// The approval engine on the migrated schema, connected as the restricted runtime role abos_app.
// Every write to approvals and executions in these tests goes through the database routines.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { payloadHash, idempotencyKey, executionStepsFor, APPROVAL_EXPIRY_MS, MATERIAL_FIELDS, canonicalJson } from '@abos/contracts';
import { createPolicyEngine, routineErrorCode } from '../../src/policy/engine';
import { emitActivity } from '../../src/policy/activity';
import { ageApproval, currentRole } from '../support/db';
import { createTestDb, seed, newId, orderInput, type Seeded, type TestDb } from './helpers';

let t: TestDb;
let ids: Seeded;
let now: Date;
let engine: ReturnType<typeof createPolicyEngine>;
beforeAll(async () => { t = await createTestDb(); }, 60_000);
afterAll(async () => { await t?.close(); });
beforeEach(async () => {
  ids = await seed(t);
  now = new Date();
  engine = createPolicyEngine(t.db, { now: () => now, newId, squareEnvironment: 'sandbox' });
});

async function proposal(channel: 'surge' | 'qr_only' = 'surge') {
  const input = await orderInput(ids, now);
  return engine.createOrderProposal({ ...input, messageChannel: channel });
}
async function counts() {
  const { rows } = await t.db.query(`select
    (select count(*)::int from orders where business_id=$1) as orders,
    (select count(*)::int from approval_requests where business_id=$1) as approvals,
    (select count(*)::int from action_executions where business_id=$1) as executions,
    (select count(*)::int from activity_events where business_id=$1) as events`, [ids.businessId]);
  return rows[0];
}
function decision(a: { id: string; payloadHash: string }, choice: 'approve' | 'reject' = 'approve') {
  return { approvalId: a.id, businessId: ids.businessId, ownerUserId: ids.ownerUserId, decision: choice, payloadHash: a.payloadHash };
}
async function status(id: string, table = 'orders') {
  return (await t.db.query(`select status from ${table} where id=$1`, [id])).rows[0];
}
async function freshHash(approvalId: string): Promise<string> {
  return String(((await t.db.query('select payload_hash from approval_requests where id=$1', [approvalId])).rows[0] as { payload_hash: string }).payload_hash);
}

it('runs as the restricted runtime role', async () => {
  expect(await currentRole(t.db)).toBe('abos_app');
  await expect(t.db.query("update approval_requests set state='APPROVED'")).rejects.toMatchObject({ code: '42501' });
});

describe('proposals and decisions', () => {
  it('stores an order and a pending approval whose payload is exactly the material and hashes as canonical JSON', async () => {
    const { order, approval } = await proposal();
    expect(order.status).toBe('AWAITING_OWNER_APPROVAL');
    expect(approval.state).toBe('PENDING');
    expect(Object.keys(approval.payload).sort()).toEqual([...MATERIAL_FIELDS.order_bundle].sort());
    expect(await counts()).toEqual({ orders: 1, approvals: 1, executions: 0, events: 3 });
    const stored = (await t.db.query('select payload, payload_canonical, payload_hash from approval_requests where id=$1', [approval.id])).rows[0] as { payload: typeof approval.payload; payload_canonical: string; payload_hash: string };
    expect(stored.payload_canonical).toBe(canonicalJson(stored.payload));
    expect(stored.payload_hash).toBe(await payloadHash(stored.payload));
    expect(Date.parse(approval.expiresAt) - Date.parse(approval.createdAt)).toBe(APPROVAL_EXPIRY_MS);
    expect(approval.createdAt).toBe(order.createdAt);
    expect(approval.createdAt.endsWith('Z')).toBe(true);
  });

  it('approves through the routine: database-derived keys, steps in order, order APPROVED, safe replay', async () => {
    const { order, approval } = await proposal();
    const result = await engine.decide(decision(approval));
    expect(result.approval.state).toBe('APPROVED');
    expect(result.executions.map((e) => ({ actionType: e.actionType, stepIndex: e.stepIndex }))).toEqual(executionStepsFor('order_bundle'));
    for (const e of result.executions) {
      expect(e.status).toBe('QUEUED');
      expect(e.idempotencyKey).toBe(await idempotencyKey({ businessId: ids.businessId, subjectId: order.id, actionType: e.actionType, approvalId: approval.id }));
    }
    expect(await status(order.id)).toEqual({ status: 'APPROVED' });
    const before = await counts();
    expect(await engine.decide(decision(approval))).toEqual(result);
    expect(await engine.decide({ ...decision(approval), reason: 'clicked twice' })).toEqual(result);
    expect(await counts()).toEqual(before);
  });

  it.each(['wrong_hash', 'expired', 'other_owner', 'other_business', 'missing'] as const)('refuses %s without changing rows', async (kind) => {
    const { approval } = await proposal();
    const input = decision(approval);
    let code = '';
    if (kind === 'wrong_hash') { input.payloadHash = `sha256:${'0'.repeat(64)}`; code = 'PAYLOAD_HASH_MISMATCH'; }
    if (kind === 'expired') { await ageApproval(t, approval.id, APPROVAL_EXPIRY_MS + 1000); input.payloadHash = await freshHash(approval.id); code = 'APPROVAL_EXPIRED'; }
    if (kind === 'other_owner') { input.ownerUserId = (await seed(t)).ownerUserId; code = 'FORBIDDEN_BUSINESS'; }
    if (kind === 'other_business') { input.businessId = ids.otherBusinessId; code = 'NOT_FOUND'; }
    if (kind === 'missing') { input.approvalId = 'apv_missing'; code = 'NOT_FOUND'; }
    const before = await counts();
    await expect(engine.decide(input)).rejects.toMatchObject({ code });
    expect(await counts()).toEqual(before);
    expect((await t.db.query('select state from approval_requests where id=$1', [approval.id])).rows[0]).toEqual({ state: 'PENDING' });
  });

  it('rejects without executions, replays rejection and refuses an opposite decision', async () => {
    const { order, approval } = await proposal();
    const result = await engine.decide(decision(approval, 'reject'));
    expect(result.executions).toEqual([]);
    expect(await status(order.id)).toEqual({ status: 'REJECTED' });
    expect(await engine.decide(decision(approval, 'reject'))).toEqual(result);
    await expect(engine.decide(decision(approval))).rejects.toMatchObject({ code: 'APPROVAL_ALREADY_DECIDED' });
  });

  it('refuses an expired quote before anything is stored', async () => {
    const input = await orderInput(ids, new Date(now.getTime() - 300_000));
    await expect(engine.createOrderProposal(input)).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
    expect(await counts()).toEqual({ orders: 0, approvals: 0, executions: 0, events: 0 });
  });

  it('a caller who declined messages: no recipient, qr_only, message step SKIPPED and no dispatch', async () => {
    const input = await orderInput(ids, now);
    const { order, approval } = await engine.createOrderProposal({ ...input, contact: { name: 'Sam', messageConsent: false }, messageChannel: 'qr_only' });
    expect(approval.payload).not.toHaveProperty('messageRecipient');
    expect(approval.payload).not.toHaveProperty('messageConsent');
    expect(order.contact).toEqual({ name: 'Sam', messageConsent: false });
    const result = await engine.decide(decision(approval));
    expect(result.executions.map((e) => e.status)).toEqual(['QUEUED', 'SKIPPED', 'QUEUED']);
    expect((await t.db.query('select * from message_dispatches where approval_id=$1', [approval.id])).rows).toEqual([]);
  });

  it('refuses a declined caller on a sending channel', async () => {
    const input = await orderInput(ids, now);
    await expect(engine.createOrderProposal({ ...input, contact: { name: 'Sam', messageConsent: false } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('expires approvals and subjects through the sweep routine', async () => {
    const { order, approval } = await proposal();
    await ageApproval(t, approval.id, APPROVAL_EXPIRY_MS + 1000);
    const expired = await engine.expireDue(ids.businessId);
    expect(expired).toContainEqual(expect.objectContaining({ id: approval.id, subject_moved: true }));
    expect(await status(order.id)).toEqual({ status: 'APPROVAL_EXPIRED' });
    expect(await counts()).toMatchObject({ events: 5, executions: 0 });
    expect(await engine.expireDue(ids.businessId)).toEqual([]);
    await expect(engine.decide({ ...decision(approval), payloadHash: await freshHash(approval.id) })).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
  });

  it('refuses a call or agent version from another business', async () => {
    const other = await seed(t);
    await expect(engine.createOrderProposal({ ...await orderInput(ids, now), callId: other.callId, agentVersionId: other.agentVersionId })).rejects.toMatchObject({ code: 'FORBIDDEN_BUSINESS' });
  });

  it('refuses a cart that differs from its quote before persisting', async () => {
    const input = await orderInput(ids, now);
    await expect(engine.createOrderProposal({ ...input, cart: { lines: [{ ...input.cart.lines[0]!, quantity: 2 }] } })).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
    expect(await counts()).toEqual({ orders: 0, approvals: 0, executions: 0, events: 0 });
  });

  it('replays an identical proposal without adding approvals or events', async () => {
    const input = await orderInput(ids, now);
    const first = await engine.createOrderProposal(input);
    const before = await counts();
    const second = await engine.createOrderProposal(input);
    expect(second.approval).toEqual(first.approval);
    expect(second.order.id).toBe(first.order.id);
    expect(await counts()).toEqual(before);
  });

  it('queues only one bundle for concurrent approval requests', async () => {
    const { approval } = await proposal();
    const [first, second] = await Promise.all([engine.decide(decision(approval)), engine.decide(decision(approval))]);
    expect(second).toEqual(first);
    expect(await counts()).toMatchObject({ executions: 3 });
  });
});

describe('step authorization', () => {
  it('authorizes every approved step', async () => {
    const { approval } = await proposal();
    const result = await engine.decide(decision(approval));
    for (const e of result.executions) expect(await engine.authorizeStep({ executionId: e.id, businessId: ids.businessId })).toMatchObject({ ok: true, execution: { id: e.id }, approval: { id: approval.id } });
  });
  it.each(['cross_business', 'production', 'missing'] as const)('refuses %s and records a guardrail event', async (kind) => {
    const { approval } = await proposal();
    let executionId = 'exe_missing';
    let businessId = ids.businessId;
    let reason = 'NOT_FOUND';
    if (kind !== 'missing') {
      executionId = (await engine.decide(decision(approval))).executions[0]!.id;
      if (kind === 'cross_business') { businessId = ids.otherBusinessId; reason = 'FORBIDDEN_BUSINESS'; }
      if (kind === 'production') { engine = createPolicyEngine(t.db, { now: () => now, newId, squareEnvironment: 'production' }); reason = 'ENVIRONMENT_MISMATCH'; }
    }
    expect(await engine.authorizeStep({ executionId, businessId })).toMatchObject({ ok: false, reason });
    const events = await t.db.query('select payload from activity_events where business_id=$1 and type=$2', [businessId, 'guardrail.refused']);
    expect(events.rows).toHaveLength(1);
  });
  it('refuses a skipped message step', async () => {
    const input = await orderInput(ids, now);
    const { approval } = await engine.createOrderProposal({ ...input, contact: { name: 'Sam', messageConsent: false }, messageChannel: 'qr_only' });
    const result = await engine.decide(decision(approval));
    expect(await engine.authorizeStep({ executionId: result.executions[1]!.id, businessId: ids.businessId })).toMatchObject({ ok: false, reason: 'INVALID_STATE' });
  });
  it('refuses payment approvals when Square is not sandbox', async () => {
    const { approval } = await proposal();
    const prod = createPolicyEngine(t.db, { now: () => now, newId, squareEnvironment: 'production' });
    await expect(prod.decide(decision(approval))).rejects.toMatchObject({ code: 'ENVIRONMENT_MISMATCH' });
  });
});

describe('bookings and facts', () => {
  function bookingInput(consent = true) {
    return { businessId: ids.businessId, callId: ids.callId, agentVersionId: ids.agentVersionId,
      serviceId: 'svc_cut', serviceName: 'Haircut', calendarId: 'demo', timezone: 'America/Los_Angeles',
      startUtc: new Date(now.getTime() + 3600000).toISOString(), endUtc: new Date(now.getTime() + 5400000).toISOString(),
      customer: consent ? { name: 'Test', messageRecipient: '+15555550123', messageConsent: true } : { name: 'Test', messageConsent: false },
      messageChannel: consent ? 'surge' as const : 'qr_only' as const };
  }
  it('creates and approves a booking to the slot recheck state with the right steps', async () => {
    const { booking, approval } = await engine.createBookingProposal(bookingInput());
    expect(Object.keys(approval.payload).sort()).toEqual([...MATERIAL_FIELDS.booking_bundle].sort());
    expect(approval.payloadHash).toBe(await payloadHash(approval.payload));
    const result = await engine.decide(decision(approval));
    expect(result.executions.map((e) => ({ actionType: e.actionType, stepIndex: e.stepIndex }))).toEqual(executionStepsFor('booking_bundle'));
    expect(await status(booking.id, 'bookings')).toEqual({ status: 'RECHECKING_SLOT' });
  });
  it('rejects a booking without executions', async () => {
    const { booking, approval } = await engine.createBookingProposal(bookingInput());
    expect((await engine.decide(decision(approval, 'reject'))).executions).toEqual([]);
    expect(await status(booking.id, 'bookings')).toEqual({ status: 'REJECTED' });
  });
  it('a declined booking caller gets qr_only and a SKIPPED confirmation', async () => {
    const { approval } = await engine.createBookingProposal(bookingInput(false));
    const result = await engine.decide(decision(approval));
    expect(result.executions.map((e) => e.status)).toEqual(['QUEUED', 'SKIPPED', 'QUEUED']);
  });

  async function verifiedFact(kind: 'hours' | 'policy', key: string, value: unknown) {
    const id = newId('fact_');
    await t.insert('business_facts', { id, business_id: ids.businessId, kind, key, value: JSON.stringify(value), source_type: 'seed', status: 'verified', version: 1, verified_at: now });
    return id;
  }
  it('fact edit: nothing changes until confirmed, then a new verified version supersedes the old one', async () => {
    const oldId = await verifiedFact('hours', 'fri', { open: '11:00', close: '22:00' });
    const { approval } = await engine.proposeFactEdit({ businessId: ids.businessId, ownerUserId: ids.ownerUserId, kind: 'hours', key: 'fri', value: { open: '11:00', close: '23:00' } });
    expect(approval).toMatchObject({ actorType: 'owner', bundleType: 'fact_edit', subjectId: oldId, payload: { fromVersion: 1, before: { open: '11:00', close: '22:00' }, after: { open: '11:00', close: '23:00' } } });
    expect(Object.keys(approval.payload).sort()).toEqual([...MATERIAL_FIELDS.fact_edit].sort());
    expect((await t.db.query('select status from business_facts where id=$1', [oldId])).rows[0]).toEqual({ status: 'verified' });
    const result = await engine.decide(decision(approval));
    expect(result.executions).toHaveLength(1);
    expect(result.executions[0]?.status).toBe('SUCCEEDED');
    const facts = (await t.db.query('select id, status, version, supersedes_id, value from business_facts where business_id=$1 order by version', [ids.businessId])).rows;
    expect(facts).toEqual([
      { id: oldId, status: 'superseded', version: 1, supersedes_id: null, value: { open: '11:00', close: '22:00' } },
      { id: expect.stringMatching(/^fact_/), status: 'verified', version: 2, supersedes_id: oldId, value: { open: '11:00', close: '23:00' } },
    ]);
    const types = (await t.db.query('select type from activity_events where correlation_id=$1 order by occurred_at, id', [approval.id])).rows.map((r) => (r as { type: string }).type);
    expect(types).toEqual(expect.arrayContaining(['approval.requested', 'approval.decided', 'execution.started', 'fact.changed', 'execution.succeeded']));
    expect(await engine.decide(decision(approval))).toEqual(result);
  });
  it('refuses a fact edit whose before value changed after the proposal', async () => {
    const oldId = await verifiedFact('policy', 'returns', 'old');
    const { approval } = await engine.proposeFactEdit({ businessId: ids.businessId, ownerUserId: ids.ownerUserId, kind: 'policy', key: 'returns', value: 'new' });
    await t.db.query(`update business_facts set value='"changed"' where id=$1`, [oldId]);
    await expect(engine.decide(decision(approval))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await counts()).toMatchObject({ executions: 0 });
  });
  it('refuses an edit of a key that has no verified fact, and a second pending edit of one fact', async () => {
    await expect(engine.proposeFactEdit({ businessId: ids.businessId, ownerUserId: ids.ownerUserId, kind: 'policy', key: 'nothing', value: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await verifiedFact('policy', 'pickup', 'a');
    await engine.proposeFactEdit({ businessId: ids.businessId, ownerUserId: ids.ownerUserId, kind: 'policy', key: 'pickup', value: 'b' });
    await expect(engine.proposeFactEdit({ businessId: ids.businessId, ownerUserId: ids.ownerUserId, kind: 'policy', key: 'pickup', value: 'c' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
  // Review finding 2: the selected conflict is not bound into the signed approval, so confirming an
  // edit must resolve no conflict, not even one created after the proposal on the same key.
  it('a confirmed edit resolves no conflict, including one the owner never saw', async () => {
    await verifiedFact('policy', 'returns', 'old');
    const { approval } = await engine.proposeFactEdit({ businessId: ids.businessId, ownerUserId: ids.ownerUserId, kind: 'policy', key: 'returns', value: 'new' });
    const unseen = newId('cfl_');
    await t.insert('fact_conflicts', { id: unseen, business_id: ids.businessId, kind: 'policy', key: 'returns', candidates: JSON.stringify([{ sourceType: 'seed', value: 'old' }, { sourceType: 'upload', value: 'newer' }]) });
    await engine.decide(decision(approval));
    expect((await t.db.query('select state, resolved_fact_id from fact_conflicts where id=$1', [unseen])).rows[0]).toEqual({ state: 'open', resolved_fact_id: null });
    expect((await t.db.query("select value from business_facts where business_id=$1 and kind='policy' and key='returns' and status='verified'", [ids.businessId])).rows[0]).toEqual({ value: 'new' });
  });
  it('a selected conflict is checked at proposal time but stays open after confirmation (no signed binding yet)', async () => {
    await verifiedFact('policy', 'refunds', 'old');
    const conflictId = newId('cfl_');
    await t.insert('fact_conflicts', { id: conflictId, business_id: ids.businessId, kind: 'policy', key: 'refunds', candidates: JSON.stringify([{ sourceType: 'seed', value: 'old' }, { sourceType: 'upload', value: 'new' }]) });
    const { approval } = await engine.proposeFactEdit({ businessId: ids.businessId, ownerUserId: ids.ownerUserId, kind: 'policy', key: 'refunds', value: 'new', resolvesConflictId: conflictId });
    await engine.decide(decision(approval));
    expect((await t.db.query('select state from fact_conflicts where id=$1', [conflictId])).rows[0]).toEqual({ state: 'open' });
  });
});

describe('activity redaction', () => {
  it('redacts phone numbers and drops card fields from activity payloads', async () => {
    await emitActivity(t.db, { id: newId('evt_'), businessId: ids.businessId, correlationId: ids.callId,
      type: 'approval.requested', actorType: 'system', occurredAt: now.toISOString(), payload: {
        approvalId: 'apv_redact', subjectId: 'ord_redact', bundleType: 'order_bundle', actionBundle: [],
        expiresAt: now.toISOString(), recipientLast4: '0123', cardNumber: '4111111111111111', phone: '+15555550123',
      } });
    const events = (await t.db.query('select payload from activity_events where business_id=$1', [ids.businessId])).rows;
    expect(JSON.stringify(events)).not.toContain('4111111111111111');
    expect(JSON.stringify(events)).not.toContain('+15555550123');
  });
});

it('maps routine refusal prefixes to contract codes', () => {
  expect(routineErrorCode(new Error('HASH: payload mismatch'))).toBe('PAYLOAD_HASH_MISMATCH');
  expect(routineErrorCode(new Error('EXPIRED: decision deadline'))).toBe('APPROVAL_EXPIRED');
  expect(routineErrorCode(new Error('OWNER: business owner required'))).toBe('FORBIDDEN_BUSINESS');
  expect(routineErrorCode(new Error('SCOPE: approval not found'))).toBe('NOT_FOUND');
  expect(routineErrorCode(new Error('DECIDED: conflicting repeat'))).toBe('APPROVAL_ALREADY_DECIDED');
  expect(routineErrorCode(new Error('something else'))).toBeUndefined();
});
