import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { payloadHash, idempotencyKey, executionStepsFor, APPROVAL_EXPIRY_MS } from '@abos/contracts';
import { createPolicyEngine } from '../../src/policy/engine';
import { emitActivity } from '../../src/policy/activity';
import { harness, seed, newId, orderInput } from './helpers';

let h: Awaited<ReturnType<typeof harness>>;
let ids: Awaited<ReturnType<typeof seed>>;
let now: Date;
let engine: ReturnType<typeof createPolicyEngine>;
beforeAll(async () => { h = await harness(); }, 30000);
afterAll(async () => { await h?.pg.close(); vi.unstubAllEnvs(); });
beforeEach(async () => {
  ids = await seed(h.db);
  now = new Date();
  engine = createPolicyEngine(h.db, { now: () => now, newId });
  vi.stubEnv('SQUARE_ENVIRONMENT', 'sandbox');
});
async function proposal() { return engine.createOrderProposal(await orderInput(ids, now)); }
async function counts() {
  const { rows } = await h.db.query(`select
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
  return (await h.db.query(`select status from ${table} where id=$1`, [id])).rows[0];
}
// Fault injection stays in this in-process database. Production guards remain enabled for all normal tests.
async function corruptApproval(id: string, column: 'payload' | 'state' | 'decided_at', value: unknown) {
  await h.pg.exec('alter table approval_requests disable trigger approval_requests_guard');
  try {
    if (column === 'state') {
      await h.db.query(`update approval_requests set state=$2, decided_by=case when $2='REJECTED' then decided_by else null end where id=$1`, [id, value]);
    } else await h.db.query(`update approval_requests set ${column}=$2 where id=$1`, [id, value]);
  } finally { await h.pg.exec('alter table approval_requests enable trigger approval_requests_guard'); }
}

describe('proposals and decisions', () => {
  it('stores an order, a pending approval, three events and no executions with the exact payload hash', async () => {
    const { order, approval } = await proposal();
    expect(order.status).toBe('AWAITING_OWNER_APPROVAL');
    expect(approval.state).toBe('PENDING');
    expect(await counts()).toEqual({ orders: 1, approvals: 1, executions: 0, events: 3 });
    const stored = (await h.pg.query<{ payload: typeof approval.payload; payload_hash: string }>('select payload,payload_hash from approval_requests where id=$1', [approval.id])).rows[0]!;
    expect(stored.payload_hash).toBe(await payloadHash(stored.payload));
    expect(Date.parse(approval.expiresAt) - Date.parse(approval.createdAt)).toBe(APPROVAL_EXPIRY_MS);
  });
  it('approves exactly the non-deferred steps with stable keys and safely replays the decision', async () => {
    const { order, approval } = await proposal();
    const result = await engine.decide(decision(approval));
    expect(result.executions.map((e) => ({ actionType: e.actionType, stepIndex: e.stepIndex }))).toEqual(executionStepsFor('order_bundle'));
    for (const e of result.executions) {
      expect(e.status).toBe('QUEUED');
      expect(e.idempotencyKey).toBe(await idempotencyKey({ businessId: ids.businessId, subjectId: order.id, actionType: e.actionType, approvalId: approval.id }));
    }
    expect(await status(order.id)).toEqual({ status: 'APPROVED' });
    const before = await counts();
    expect(await engine.decide(decision(approval))).toEqual(result);
    expect(await counts()).toEqual(before);
  });
  it.each(['wrong_hash', 'expired', 'other_owner', 'other_business', 'missing'] as const)('refuses %s without changing rows', async (kind) => {
    const { approval } = await proposal();
    const input = decision(approval);
    let code = '';
    if (kind === 'wrong_hash') { input.payloadHash = `sha256:${'0'.repeat(64)}`; code = 'PAYLOAD_HASH_MISMATCH'; }
    if (kind === 'expired') { now = new Date(now.getTime() + APPROVAL_EXPIRY_MS); code = 'APPROVAL_EXPIRED'; }
    if (kind === 'other_owner') { input.ownerUserId = (await seed(h.db)).ownerUserId; code = 'FORBIDDEN_BUSINESS'; }
    if (kind === 'other_business') { input.businessId = ids.otherBusinessId; code = 'FORBIDDEN_BUSINESS'; }
    if (kind === 'missing') { input.approvalId = 'apv_missing'; code = 'NOT_FOUND'; }
    const before = await counts();
    await expect(engine.decide(input)).rejects.toMatchObject({ code });
    expect(await counts()).toEqual(before);
    expect((await h.pg.query<{ state: string }>('select state from approval_requests where id=$1', [approval.id])).rows[0]?.state).toBe('PENDING');
  });
  it('rejects without executions, replays rejection and refuses an opposite decision', async () => {
    const { order, approval } = await proposal();
    const result = await engine.decide(decision(approval, 'reject'));
    expect(result.executions).toEqual([]);
    expect(await status(order.id)).toEqual({ status: 'REJECTED' });
    expect(await engine.decide(decision(approval, 'reject'))).toEqual(result);
    await expect(engine.decide(decision(approval))).rejects.toMatchObject({ code: 'APPROVAL_ALREADY_DECIDED' });
  });
  it('refuses an expired quote atomically', async () => {
    const input = await orderInput(ids, new Date(now.getTime() - 300000));
    await expect(engine.createOrderProposal(input)).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
    expect(await counts()).toEqual({ orders: 0, approvals: 0, executions: 0, events: 0 });
  });
  it('skips the message step for qr_only without creating a dispatch', async () => {
    const { approval } = await engine.createOrderProposal({ ...await orderInput(ids, now), messageChannel: 'qr_only' });
    const result = await engine.decide(decision(approval));
    expect(result.executions.map((e) => e.status)).toEqual(['QUEUED', 'SKIPPED', 'QUEUED']);
    expect((await h.pg.query('select * from message_dispatches where approval_id=$1', [approval.id])).rows).toEqual([]);
  });
  it('expires approvals and subjects with both events in the same transaction', async () => {
    now = new Date(Date.now() - APPROVAL_EXPIRY_MS - 1000);
    const { order, approval } = await proposal();
    const expired = await engine.expireDue();
    expect(expired).toContainEqual(expect.objectContaining({ id: approval.id, subject_moved: true }));
    expect(await status(order.id)).toEqual({ status: 'APPROVAL_EXPIRED' });
    expect((await counts())).toMatchObject({ events: 5, executions: 0 });
    expect(await engine.expireDue()).toEqual([]);
  });
  it('refuses a caller-supplied approval ID owned by another business, even on replay', async () => {
    const { approval } = await proposal();
    await engine.decide(decision(approval));
    await expect(engine.decide({ ...decision(approval), businessId: ids.otherBusinessId })).rejects.toMatchObject({ code: 'FORBIDDEN_BUSINESS' });
  });
  it('refuses a call or agent version from another business', async () => {
    const other = await seed(h.db);
    await expect(engine.createOrderProposal({ ...await orderInput(ids, now), callId: other.callId, agentVersionId: other.agentVersionId })).rejects.toMatchObject({ code: 'FORBIDDEN_BUSINESS' });
  });
  it('validates consent and the quote cart binding before persisting', async () => {
    const input = await orderInput(ids, now);
    await expect(engine.createOrderProposal({ ...input, contact: { ...input.contact, messageConsent: false as unknown as true } })).rejects.toThrow();
    await expect(engine.createOrderProposal({ ...input, cart: { lines: [{ ...input.cart.lines[0]!, quantity: 2 }] } })).rejects.toThrow();
    expect(await counts()).toEqual({ orders: 0, approvals: 0, executions: 0, events: 0 });
  });
});

describe('step authorization', () => {
  it('authorizes an approved registered step and its local record step', async () => {
    const { approval } = await proposal();
    const result = await engine.decide(decision(approval));
    for (const e of result.executions) expect(await engine.authorizeStep({ executionId: e.id, businessId: ids.businessId })).toMatchObject({ ok: true, execution: { id: e.id }, approval: { id: approval.id } });
  });
  it.each(['tamper', 'rejected', 'expired', 'cross_business', 'production', 'capability', 'late_decision', 'missing'] as const)('refuses %s and records a guardrail event', async (kind) => {
    const { approval } = await proposal();
    const result = await engine.decide(decision(approval));
    const first = result.executions[0]!;
    const input = { executionId: first.id, businessId: ids.businessId };
    let reason = '';
    if (kind === 'tamper') { await corruptApproval(approval.id, 'payload', JSON.stringify({ ...approval.payload, totalMinor: 9999 })); reason = 'PAYLOAD_HASH_MISMATCH'; }
    if (kind === 'rejected') { await corruptApproval(approval.id, 'state', 'REJECTED'); reason = 'INVALID_STATE'; }
    if (kind === 'expired') { await corruptApproval(approval.id, 'state', 'EXPIRED'); reason = 'APPROVAL_EXPIRED'; }
    if (kind === 'cross_business') { input.businessId = ids.otherBusinessId; reason = 'FORBIDDEN_BUSINESS'; }
    if (kind === 'production') { vi.stubEnv('SQUARE_ENVIRONMENT', 'production'); reason = 'ENVIRONMENT_MISMATCH'; }
    if (kind === 'capability') { await h.db.query("update action_executions set capability_id='catalog.read' where id=$1", [first.id]); reason = 'CAPABILITY_NOT_ALLOWED'; }
    if (kind === 'late_decision') { await corruptApproval(approval.id, 'decided_at', approval.expiresAt); reason = 'APPROVAL_EXPIRED'; }
    if (kind === 'missing') { input.executionId = 'exe_missing'; reason = 'NOT_FOUND'; }
    expect(await engine.authorizeStep(input)).toMatchObject({ ok: false, reason });
    const events = await h.pg.query('select * from activity_events where business_id=$1 and type=$2', [input.businessId, 'guardrail.refused']);
    expect(events.rows).toHaveLength(1);
  });
  it('refuses a skipped message step', async () => {
    const { approval } = await engine.createOrderProposal({ ...await orderInput(ids, now), messageChannel: 'qr_only' });
    const result = await engine.decide(decision(approval));
    expect(await engine.authorizeStep({ executionId: result.executions[1]!.id, businessId: ids.businessId })).toMatchObject({ ok: false, reason: 'INVALID_STATE' });
  });
});

describe('bookings and facts', () => {
  function bookingInput() {
    return { businessId: ids.businessId, callId: ids.callId, agentVersionId: ids.agentVersionId,
      serviceId: 'svc_cut', serviceName: 'Haircut', calendarId: 'demo', timezone: 'America/Los_Angeles',
      startUtc: new Date(now.getTime() + 3600000).toISOString(), endUtc: new Date(now.getTime() + 5400000).toISOString(),
      customer: { name: 'Test', messageRecipient: '+15555550123', messageConsent: true }, messageChannel: 'surge' as const };
  }
  it('creates and approves a booking to the slot recheck state with the right steps', async () => {
    const { booking, approval } = await engine.createBookingProposal(bookingInput());
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
  it('expires a booking and logs its status', async () => {
    now = new Date(Date.now() - APPROVAL_EXPIRY_MS - 1000);
    const { booking } = await engine.createBookingProposal(bookingInput());
    await engine.expireDue();
    expect(await status(booking.id, 'bookings')).toEqual({ status: 'EXPIRED' });
  });
  it('refuses booking message delivery without consent', async () => {
    const input = bookingInput();
    await expect(engine.createBookingProposal({ ...input, customer: { ...input.customer, messageConsent: false } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
  it('verifies a new fact version and supersedes its previous version only upon approval', async () => {
    const oldId = newId('fact_');
    await h.db.query(`insert into business_facts (id,business_id,kind,key,value,source_type,status,version,verified_at,verified_by)
      values ($1,$2,'hours','fri',$3,'seed','verified',1,$4,$5)`, [oldId, ids.businessId, JSON.stringify({ open: '09:00', close: '22:00' }), now, ids.ownerUserId]);
    const { approval, draftFact } = await engine.proposeFactEdit({ businessId: ids.businessId, ownerUserId: ids.ownerUserId,
      kind: 'hours', key: 'fri', value: { open: '09:00', close: '23:00' } });
    expect(approval.actorType).toBe('owner');
    expect(draftFact.status).toBe('draft');
    const result = await engine.decide(decision(approval));
    expect(result.executions).toHaveLength(1);
    expect(result.executions[0]?.status).toBe('SUCCEEDED');
    const facts = await h.pg.query<{ id: string; status: string; version: number; supersedes_id: string | null }>('select id,status,version,supersedes_id from business_facts where business_id=$1 order by version', [ids.businessId]);
    expect(facts.rows).toEqual([{ id: oldId, status: 'superseded', version: 1, supersedes_id: null }, { id: draftFact.id, status: 'verified', version: 2, supersedes_id: oldId }]);
    expect((await h.pg.query('select * from activity_events where business_id=$1 and type=$2', [ids.businessId, 'fact.changed'])).rows).toHaveLength(1);
    expect(await engine.decide(decision(approval))).toEqual(result);
  });
});

it('redacts phone numbers and drops card fields from activity payloads', async () => {
  await emitActivity(h.db, { id: newId('evt_'), businessId: ids.businessId, correlationId: ids.callId,
    type: 'approval.requested', actorType: 'system', occurredAt: now.toISOString(), payload: {
      approvalId: 'apv_redact', subjectId: 'ord_redact', bundleType: 'order_bundle', actionBundle: [],
      expiresAt: now.toISOString(), recipientLast4: '0123', cardNumber: '4111111111111111', phone: '+15555550123',
    } });
  const events = await h.pg.query<{ payload: Record<string, unknown> }>('select payload from activity_events where business_id=$1', [ids.businessId]);
  expect(JSON.stringify(events.rows)).not.toContain('4111111111111111');
  expect(JSON.stringify(events.rows)).not.toContain('+15555550123');
  expect(events.rows[0]?.payload.recipientLast4).toBe('0123');
});

describe('atomicity and stale data', () => {
  it('rolls back an approval and all queued executions when writing its event fails', async () => {
    const { approval } = await proposal();
    const before = await counts();
    const broken = createPolicyEngine(h.db, { now: () => now, newId: (prefix) => prefix === 'evt_' ? 'invalid' : newId(prefix) });
    await expect(broken.decide(decision(approval))).rejects.toThrow();
    expect(await counts()).toEqual(before);
    expect((await h.pg.query<{ state: string }>('select state from approval_requests where id=$1', [approval.id])).rows[0]?.state).toBe('PENDING');
  });
  it('queues only one bundle for concurrent approval requests', async () => {
    const { approval } = await proposal();
    const [first, second] = await Promise.all([engine.decide(decision(approval)), engine.decide(decision(approval))]);
    expect(second).toEqual(first);
    expect(await counts()).toMatchObject({ executions: 3 });
  });
  it('refuses a fact edit when its approved before value has changed without a version change', async () => {
    const oldId = newId('fact_');
    await h.db.query(`insert into business_facts (id,business_id,kind,key,value,source_type,status,version,verified_at)
      values ($1,$2,'policy','returns','"old"','seed','verified',1,$3)`, [oldId, ids.businessId, now]);
    const { approval } = await engine.proposeFactEdit({ businessId: ids.businessId, ownerUserId: ids.ownerUserId, kind: 'policy', key: 'returns', value: 'new' });
    await h.db.query(`update business_facts set value='"changed"' where id=$1`, [oldId]);
    await expect(engine.decide(decision(approval))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await counts()).toMatchObject({ executions: 0 });
  });
  it('creates a new verified fact when no previous version exists', async () => {
    const { approval, draftFact } = await engine.proposeFactEdit({ businessId: ids.businessId, ownerUserId: ids.ownerUserId, kind: 'policy', key: 'returns', value: 'new' });
    await engine.decide(decision(approval));
    expect((await h.pg.query('select status,version from business_facts where id=$1', [draftFact.id])).rows[0]).toEqual({ status: 'verified', version: 1 });
  });
  it('resolves a matching fact conflict during confirmation', async () => {
    const conflictId = newId('cfl_');
    await h.db.query(`insert into fact_conflicts (id,business_id,kind,key,candidates) values ($1,$2,'policy','returns',$3)`, [conflictId, ids.businessId, JSON.stringify([{ sourceType: 'seed', value: 'old' }, { sourceType: 'owner_chat', value: 'new' }])]);
    const { approval, draftFact } = await engine.proposeFactEdit({ businessId: ids.businessId, ownerUserId: ids.ownerUserId, kind: 'policy', key: 'returns', value: 'new', resolvesConflictId: conflictId });
    await engine.decide(decision(approval));
    expect((await h.pg.query('select state,resolved_fact_id from fact_conflicts where id=$1', [conflictId])).rows[0]).toEqual({ state: 'resolved', resolved_fact_id: draftFact.id });
  });
  it('redacts free-text phone and card data while preserving timestamps', async () => {
    await emitActivity(h.db, { id: newId('evt_'), businessId: ids.businessId, correlationId: ids.callId,
      type: 'proposal.created', actorType: 'system', occurredAt: now.toISOString(), payload: {
        subjectId: 'bkg_test', subjectType: 'booking', callId: ids.callId,
        serviceName: 'Call +1 (555) 555-0123 card 4111 1111 1111 1111', startUtc: now.toISOString(),
      } });
    const row = (await h.pg.query<{ payload: { serviceName: string; startUtc: string } }>('select payload from activity_events where business_id=$1', [ids.businessId])).rows[0]!;
    expect(row.payload.startUtc).toBe(now.toISOString());
    expect(row.payload.serviceName).toContain('0123');
    expect(row.payload.serviceName).not.toContain('555');
    expect(row.payload.serviceName).not.toContain('4111');
  });
});

it('replays an identical proposal without adding approvals or events', async () => {
  const input = await orderInput(ids, now);
  const first = await engine.createOrderProposal(input);
  const before = await counts();
  const second = await engine.createOrderProposal(input);
  expect(second).toEqual(first);
  expect(await counts()).toEqual(before);
});
it('preserves generated identifiers that contain a long run of digits', async () => {
  const id = 'ord_12345678901234567890';
  await emitActivity(h.db, { id: newId('evt_'), businessId: ids.businessId, correlationId: ids.callId,
    type: 'proposal.created', actorType: 'system', occurredAt: now.toISOString(),
    payload: { subjectId: id, subjectType: 'order', callId: ids.callId } });
  const row = (await h.pg.query<{ payload: { subjectId: string } }>('select payload from activity_events where business_id=$1', [ids.businessId])).rows[0]!;
  expect(row.payload.subjectId).toBe(id);
});
it('honors database expiry even when the injected clock is behind', async () => {
  now = new Date(Date.now() - APPROVAL_EXPIRY_MS - 1000);
  const { approval } = await proposal();
  const before = await counts();
  await expect(engine.decide(decision(approval))).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
  expect(await counts()).toEqual(before);
});
