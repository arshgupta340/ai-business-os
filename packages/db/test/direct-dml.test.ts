import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createApproval, createMigratedDb, createOwner, createExecution, type Owner } from './helpers';
let db: PGlite;
let owner: Owner;
let other: Owner;
beforeAll(async () => { db = await createMigratedDb(); owner = await createOwner(db); other = await createOwner(db); });
afterAll(async () => { await db.close(); });
async function service<T>(fn: () => Promise<T>) {
  await db.exec('set role service_role');
  try { return await fn(); } finally { await db.exec('reset role'); }
}
async function approve(id: unknown, user = owner.userId) {
  return db.query(`update public.approval_requests set state = 'APPROVED', decided_by = $2, decided_at = now() where id = $1`, [id, user]);
}
describe('direct DML as service_role', () => {
  it('refuses another business owner as decider', async () => {
    const a = await createApproval(db, owner);
    await expect(service(() => approve(a.id, other.userId))).rejects.toThrow();
  });
  it('refuses an expired approval', async () => {
    const a = await createApproval(db, owner, { expires_at: new Date(Date.now() - 1000) });
    await expect(service(() => approve(a.id))).rejects.toThrow();
  });
  it('refuses an execution inserted RUNNING', async () => {
    const a = await createApproval(db, owner); await service(() => approve(a.id));
    await expect(service(() => createExecution(db, owner, String(a.id), { status: 'RUNNING' }))).rejects.toThrow();
  });
  it('refuses a later step starting before earlier steps finish', async () => {
    const a = await createApproval(db, owner); await service(() => approve(a.id));
    const e = await createExecution(db, owner, String(a.id), { step_index: 2, action_type: 'local.order.record' });
    await expect(service(() => db.query(`update public.action_executions set status = 'RUNNING' where id = $1`, [e.id]))).rejects.toThrow();
  });
  it('refuses deleting an approval', async () => {
    const a = await createApproval(db, owner);
    await expect(service(() => db.query(`delete from public.approval_requests where id = $1`, [a.id]))).rejects.toThrow();
  });
});
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { decideAndEnqueue, type TransactionClient } from './legacy-admin-sql';
import { BOOKING_BUNDLE, createBooking, createOrder, hex64, insert } from './helpers';

// Type-level regression: a pool cannot masquerade as a transaction client.
function poolIsNotATransaction(pool: Pool) {
  // @ts-expect-error Pool has no checked-out client's release method.
  const tx: TransactionClient = pool;
  return tx;
}
void poolIsNotATransaction;

describe('canonical approval binding', () => {
  it('refuses a hash that differs from the canonical text', async () => {
    await expect(createApproval(db, owner, { payload_hash: `sha256:${'0'.repeat(64)}` })).rejects.toThrow(/approval_payload_hash_matches/);
  });
  it('refuses a canonical object that differs from payload', async () => {
    await expect(createApproval(db, owner, { payload_canonical: '{"businessId":"different"}' })).rejects.toThrow(/approval_payload_contains_canonical/);
  });
  for (const text of ['[]', 'null', '"value"', 'invalid']) {
    it(`refuses non-object canonical material ${text}`, async () => {
      await expect(createApproval(db, owner, { payload_canonical: text })).rejects.toThrow();
    });
  }
  it('hashes exact bytes including Unicode and whitespace; freezes canonical text', async () => {
    const text = '{ "messageRecipient":"+15555550123", "messageChannel":"surge", "name":"café" }';
    const a = await createApproval(db, owner, { payload: JSON.parse(text), payload_canonical: text });
    expect(a.payload_hash).toBe(`sha256:${createHash('sha256').update(text).digest('hex')}`);
    await expect(db.query(`update public.approval_requests set payload_canonical = '{}' where id = $1`, [a.id])).rejects.toThrow(/only state and decision columns/);
  });
});

async function dispatchFixture(booking = false) {
  const subject = booking ? await createBooking(db, owner) : await createOrder(db, owner);
  const a = await createApproval(db, owner, {
    subject_id: subject.id,
    ...(booking ? { bundle_type: 'booking_bundle', action_bundle: BOOKING_BUNDLE } : {}),
  });
  await service(() => approve(a.id));
  const x = await createExecution(db, owner, String(a.id), {
    action_type: booking ? 'message.booking.confirm' : 'message.checkout.send', step_index: 1,
  });
  return {
    business_id: owner.businessId, approval_id: a.id, execution_id: x.id,
    ...(booking ? { booking_id: subject.id } : { order_id: subject.id }),
    recipient: '+15555550123', channel: 'surge', template: booking ? 'booking_confirmed' : 'checkout_link',
    body_hash: `sha256:${'a'.repeat(64)}`, idempotency_key: hex64(),
  };
}

describe('dispatch direct DML as service_role', () => {
  for (const [name, change] of [
    ['recipient', { recipient: '+15555550999' }],
    ['channel', { channel: 'android_gateway' }],
    ['template', { template: 'booking_confirmed' }],
  ] as const) {
    it(`refuses an unapproved ${name} on insert`, async () => {
      const row = await dispatchFixture();
      await expect(service(() => insert(db, 'message_dispatches', { ...row, ...change }))).rejects.toThrow();
    });
  }
  it('refuses a non-message execution', async () => {
    const row = await dispatchFixture();
    const x = await createExecution(db, owner, String(row.approval_id));
    await expect(service(() => insert(db, 'message_dispatches', { ...row, execution_id: x.id }))).rejects.toThrow(/message step/);
  });
  it('refuses an unrelated subject', async () => {
    const row = await dispatchFixture(); const order = await createOrder(db, owner);
    await expect(service(() => insert(db, 'message_dispatches', { ...row, order_id: order.id }))).rejects.toThrow(/subject/);
  });
  it('refuses a subject in another business even with the same approval subject id', async () => {
    const order = await createOrder(db, other);
    const row = await dispatchFixture();
    const a = await createApproval(db, owner, { subject_id: order.id }); await approve(a.id);
    const x = await createExecution(db, owner, String(a.id), { action_type: 'message.checkout.send', step_index: 1 });
    await expect(service(() => insert(db, 'message_dispatches', { ...row, order_id: order.id, approval_id: a.id, execution_id: x.id }))).rejects.toThrow(/foreign key/);
  });
  it('refuses a second dispatch for one execution', async () => {
    const row = await dispatchFixture(); await service(() => insert(db, 'message_dispatches', row));
    await expect(service(() => insert(db, 'message_dispatches', { ...row, idempotency_key: hex64() }))).rejects.toThrow(/unique/);
  });
  for (const field of ['id', 'business_id', 'approval_id', 'execution_id', 'order_id', 'booking_id', 'channel', 'recipient', 'template', 'body_hash', 'idempotency_key']) {
    it(`freezes dispatch ${field} after insert`, async () => {
      const row = await dispatchFixture(); const d = await service(() => insert(db, 'message_dispatches', row));
      const value = field === 'recipient' ? '+15555550999' : field === 'body_hash' ? `sha256:${'b'.repeat(64)}` : 'different';
      await expect(service(() => db.query(`update public.message_dispatches set ${field} = $2 where id = $1`, [d.id, value]))).rejects.toThrow(/cannot change/);
    });
  }
  it('accepts a booking dispatch and provider status metadata changes', async () => {
    const row = await dispatchFixture(true); const d = await service(() => insert(db, 'message_dispatches', row));
    await service(() => db.query(`update public.message_dispatches set status = 'SENT', attempts = 1, provider_message_id = 'provider-1', sent_at = now() where id = $1`, [d.id]));
  });
});

const tx: TransactionClient = { query: (sql, params) => db.query(sql, params), release() {} };
function args(a: Record<string, unknown>) {
  return { approvalId: String(a.id), businessId: owner.businessId, ownerUserId: owner.userId,
    payloadHash: String(a.payload_hash), decision: 'APPROVED' as const, stepIdempotencyKeys: [hex64(), hex64(), hex64()] };
}
describe('decideAndEnqueue in caller transaction', () => {
  it('enqueues ordered non-deferred steps and returns the same executions on identical retry', async () => {
    const a = await createApproval(db, owner); const input = args(a);
    await db.exec('begin');
    try {
      const result = await decideAndEnqueue(tx, input);
      expect(result?.approval.state).toBe('APPROVED');
      expect(result?.executions.map(e => [e.step_index, e.action_type, e.status, e.idempotency_key])).toEqual([
        [0, 'square.checkout.create', 'QUEUED', input.stepIdempotencyKeys[0]],
        [1, 'message.checkout.send', 'QUEUED', input.stepIdempotencyKeys[1]],
        [2, 'local.order.record', 'QUEUED', input.stepIdempotencyKeys[2]],
      ]);
      expect(await decideAndEnqueue(tx, input)).toEqual(result);
      expect(await decideAndEnqueue(tx, { ...input, decision: 'REJECTED' })).toBeNull();
      expect(await decideAndEnqueue(tx, { ...input, stepIdempotencyKeys: [hex64(), hex64(), hex64()] })).toBeNull();
      await db.exec('commit');
    } catch (err) { await db.exec('rollback'); throw err; }
  });
  it('rolls back the decision and prior inserts when a later insert fails', async () => {
    const a = await createApproval(db, owner); const input = args(a);
    input.stepIdempotencyKeys[1] = input.stepIdempotencyKeys[0]!;
    await db.exec('begin');
    try {
      await expect(decideAndEnqueue(tx, input)).rejects.toThrow(/unique/);
      // Even if the caller commits after the caught error, no partial decision escapes.
      await db.exec('commit');
    } catch (err) { await db.exec('rollback'); throw err; }
    expect((await db.query(`select state from public.approval_requests where id = $1`, [a.id])).rows).toEqual([{ state: 'PENDING' }]);
    expect((await db.query(`select id from public.action_executions where approval_id = $1`, [a.id])).rows).toEqual([]);
  });
  it('skips only the qr_only message and never enqueues Sheets', async () => {
    const a = await createApproval(db, owner, { payload: { messageChannel: 'qr_only' } });
    await db.exec('begin');
    try {
      expect((await decideAndEnqueue(tx, args(a)))?.executions.map(e => e.status)).toEqual(['QUEUED', 'SKIPPED', 'QUEUED']);
      await db.exec('commit');
    } catch (err) { await db.exec('rollback'); throw err; }
  });
  it('rejects without executions and retries rejection identically', async () => {
    const a = await createApproval(db, owner); const input = { ...args(a), decision: 'REJECTED' as const, stepIdempotencyKeys: [] };
    await db.exec('begin');
    try {
      const result = await decideAndEnqueue(tx, input);
      expect(result?.approval.state).toBe('REJECTED'); expect(result?.executions).toEqual([]);
      expect(await decideAndEnqueue(tx, input)).toEqual(result);
      await db.exec('commit');
    } catch (err) { await db.exec('rollback'); throw err; }
  });
});

describe('decision trigger details under direct service DML', () => {
  for (const state of ['APPROVED', 'REJECTED']) {
    it(`${state} requires the owner, decided_at and a decision before expiry`, async () => {
      const a = await createApproval(db, owner);
      for (const [by, at] of [[other.userId, new Date()], [owner.userId, null], [owner.userId, a.expires_at]]) {
        await expect(service(() => db.query(`update public.approval_requests set state = $2, decided_by = $3, decided_at = $4 where id = $1`, [a.id, state, by, at]))).rejects.toThrow();
      }
    });
  }
  it('refuses backdated approval of an already expired request', async () => {
    const a = await createApproval(db, owner, { expires_at: new Date(Date.now() - 1000) });
    await expect(service(() => db.query(`update public.approval_requests set state = 'APPROVED', decided_by = $2, decided_at = expires_at - interval '1 second' where id = $1`, [a.id, owner.userId]))).rejects.toThrow();
  });
  it('EXPIRED requires elapsed expiry, a timestamp and no deciding user', async () => {
    const future = await createApproval(db, owner);
    await expect(service(() => db.query(`update public.approval_requests set state = 'EXPIRED', decided_at = now() where id = $1`, [future.id]))).rejects.toThrow();
    const a = await createApproval(db, owner, { expires_at: new Date(Date.now() - 1000) });
    await expect(service(() => db.query(`update public.approval_requests set state = 'EXPIRED', decided_at = now(), decided_by = $2 where id = $1`, [a.id, owner.userId]))).rejects.toThrow();
    await service(() => db.query(`update public.approval_requests set state = 'EXPIRED', decided_at = now() where id = $1`, [a.id]));
  });
  for (const status of ['SUCCEEDED', 'FAILED', 'NEEDS_REVIEW', 'SKIPPED']) {
    it(`refuses initial non-message execution state ${status}`, async () => {
      const a = await createApproval(db, owner); await approve(a.id);
      await expect(service(() => createExecution(db, owner, String(a.id), { status, finished_at: new Date() }))).rejects.toThrow(/must start/);
    });
  }
  for (const messageStatus of ['SKIPPED', 'FAILED', 'NEEDS_REVIEW', 'SUCCEEDED']) {
    it(`allows the next step after a ${messageStatus} message and succeeded provider step`, async () => {
      const a = await createApproval(db, owner); await approve(a.id);
      const first = await createExecution(db, owner, String(a.id));
      const msg = await createExecution(db, owner, String(a.id), { action_type: 'message.checkout.send', step_index: 1 });
      const last = await createExecution(db, owner, String(a.id), { action_type: 'local.order.record', step_index: 2 });
      await service(async () => {
        await db.query(`update public.action_executions set status = 'SUCCEEDED', finished_at = now() where id = $1`, [first.id]);
        await db.query(`update public.action_executions set status = $2, finished_at = now() where id = $1`, [msg.id, messageStatus]);
        await db.query(`update public.action_executions set status = 'RUNNING' where id = $1`, [last.id]);
      });
    });
  }
  it('checks every transition into RUNNING, including from FAILED', async () => {
    const a = await createApproval(db, owner); await approve(a.id);
    const e = await createExecution(db, owner, String(a.id), { action_type: 'local.order.record', step_index: 2 });
    await db.query(`update public.action_executions set status = 'FAILED' where id = $1`, [e.id]);
    await expect(service(() => db.query(`update public.action_executions set status = 'RUNNING' where id = $1`, [e.id]))).rejects.toThrow(/earlier steps/);
  });
  it('deletion remains forbidden after approval with no executions', async () => {
    const a = await createApproval(db, owner); await approve(a.id);
    await expect(service(() => db.query(`delete from public.approval_requests where id = $1`, [a.id]))).rejects.toMatchObject({ code: '42501' });
  });
});

describe('atomic decision edge cases', () => {
  for (const [bundleType, bundle] of [
    ['booking_bundle', BOOKING_BUNDLE],
    ['fact_edit', ['local.fact.update']],
    ['price_edit', ['square.catalog.price.update', 'local.catalog.sync']],
  ] as const) {
    it(`enqueues the exact ${bundleType} steps`, async () => {
      const a = await createApproval(db, owner, { bundle_type: bundleType, action_bundle: [...bundle] });
      const steps = bundle.filter(s => !s.startsWith('sheets.'));
      await db.exec('begin');
      try {
        const result = await decideAndEnqueue(tx, { ...args(a), stepIdempotencyKeys: steps.map(() => hex64()) });
        expect(result?.executions.map(e => e.action_type)).toEqual(steps);
        await db.exec('commit');
      } catch (err) { await db.exec('rollback'); throw err; }
    });
  }
  for (const kind of ['wrong owner', 'wrong hash', 'expired']) {
    it(`does not decide or enqueue for ${kind}`, async () => {
      const a = await createApproval(db, owner, kind === 'expired' ? { expires_at: new Date(Date.now() - 1000) } : {});
      const input = args(a);
      if (kind === 'wrong owner') input.ownerUserId = other.userId;
      if (kind === 'wrong hash') input.payloadHash = `sha256:${'0'.repeat(64)}`;
      await db.exec('begin');
      try {
        expect(await decideAndEnqueue(tx, input)).toBeNull();
        await db.exec('commit');
      } catch (err) { await db.exec('rollback'); throw err; }
      expect((await db.query(`select state from public.approval_requests where id = $1`, [a.id])).rows).toEqual([{ state: 'PENDING' }]);
      expect((await db.query(`select id from public.action_executions where approval_id = $1`, [a.id])).rows).toEqual([]);
    });
  }
  it('requires caller BEGIN and refuses an incomplete key set', async () => {
    const a = await createApproval(db, owner);
    await expect(decideAndEnqueue(tx, args(a))).rejects.toThrow(/transaction/);
    await db.exec('begin');
    try {
      await expect(decideAndEnqueue(tx, { ...args(a), stepIdempotencyKeys: [] })).rejects.toThrow(/expected 3/);
      await db.exec('commit');
    } catch (err) { await db.exec('rollback'); throw err; }
    expect((await db.query(`select state from public.approval_requests where id = $1`, [a.id])).rows).toEqual([{ state: 'PENDING' }]);
  });
  it('replays a committed decision in a new transaction without inserting again', async () => {
    const a = await createApproval(db, owner); const input = args(a);
    let ids: string[] = [];
    await db.exec('begin');
    try {
      ids = (await decideAndEnqueue(tx, input))!.executions.map(e => e.id);
      await db.exec('commit');
    } catch (err) { await db.exec('rollback'); throw err; }
    await db.exec('begin');
    try {
      expect((await decideAndEnqueue(tx, input))?.executions.map(e => e.id)).toEqual(ids);
      await db.exec('commit');
    } catch (err) { await db.exec('rollback'); throw err; }
  });
});
