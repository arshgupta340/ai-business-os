// B-23 group 1: the approval decision under attack. Every test runs with the executor and the webhooks
// wired, on the in-process Postgres as abos_app, and asserts the exact number of external writes
// (Square, messages, Calendar, Sheets) and the stored state afterwards.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APPROVAL_EXPIRY_MS, canonicalJson, cartHash, hashCanonical, idempotencyKey, type Cart } from '@abos/contracts';
import { ageApproval, currentRole, type TestDb } from '../support/db';
import { OTHER, OWNER, createWorld, type World } from '../e2e/world';
import {
  BARBER, CART, NONE, filterCalendarListByProperty, OTHER_BIZ, PIZZA, RECIPIENT, approve, bookingProposal, count, counts, decide, delta, getApproval, order, pickupAt, pizzaOrder, statusOf, steps,
} from './helpers';

let w: World;
beforeAll(async () => { w = await createWorld();  filterCalendarListByProperty(w); }, 120_000);
afterAll(async () => { await w?.close(); });

/** Lets the executor and the jobs run, then asks the executor to look again, so "nothing ran" is a real result. */
async function quiesce() {
  await w.settle();
  w.app.composed.executor.kick(PIZZA);
  await w.app.composed.webhooks?.reconcileNow();
  await w.settle();
}

/** A pending order approval that must still be untouched after an attack on it. */
async function expectUntouched(orderId: string, approvalId: string) {
  await quiesce();
  expect(await statusOf(w, 'approval_requests', approvalId)).toBe('PENDING');
  expect(await statusOf(w, 'orders', orderId)).toBe('AWAITING_OWNER_APPROVAL');
  expect(await steps(w, approvalId)).toEqual([]);
  expect(await count(w, 'message_dispatches where approval_id = $1', [approvalId])).toBe(0);
}

it('the server under test runs as abos_app, with the executor wired', async () => {
  expect(await currentRole(w.t.db)).toBe('abos_app');
  expect(w.app.composed.executor.idle).toBeTypeOf('function');
});

describe('a decision that must be refused', () => {
  it('approve with a wrong payload hash: 409 PAYLOAD_HASH_MISMATCH for every wrong hash, nothing changes', async () => {
    const before = counts(w);
    const a = await pizzaOrder(w);
    const b = await pizzaOrder(w, { recipient: '+15555550188' });
    const hashA = (await getApproval(w, PIZZA, a.approvalId)).payloadHash;
    const hashB = (await getApproval(w, PIZZA, b.approvalId)).payloadHash;
    expect(hashA).not.toBe(hashB);
    const wrong = [
      `sha256:${'0'.repeat(64)}`,
      hashB, // a real hash, of another pending approval of the same business
      `sha256:${hashA.slice(7).split('').reverse().join('')}`,
      hashA.replace(/.$/, (c) => (c === '0' ? '1' : '0')),
    ];
    for (const payloadHash of wrong) {
      const res = await decide(w, PIZZA, a.approvalId, 'approve', payloadHash);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'PAYLOAD_HASH_MISMATCH', retryable: false });
      // The refusal does not hand out the right hash.
      expect(res.body).not.toContain(hashA);
    }
    // A reject with a wrong hash is refused the same way.
    expect((await decide(w, PIZZA, a.approvalId, 'reject', wrong[0]!)).json()).toMatchObject({ code: 'PAYLOAD_HASH_MISMATCH' });
    // A hash that is not a hash at all, or no hash, fails validation before the engine.
    for (const payload of [{ decision: 'approve', payloadHash: 'not-a-hash' }, { decision: 'approve' }, { decision: 'approve', payloadHash: hashA.toUpperCase() },
      { decision: 'approve', payloadHash: { $ne: null } }, { decision: 'APPROVED', payloadHash: hashA }, { decision: ['approve'], payloadHash: hashA }, [], 'approve']) {
      const res = await w.app.inject({ method: 'POST', url: `/api/approvals/${a.approvalId}/decision?businessId=${PIZZA}`, headers: OWNER, payload });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    await expectUntouched(a.orderId, a.approvalId);
    await expectUntouched(b.orderId, b.approvalId);
    expect(delta(w, before)).toEqual(NONE);
  });

  it('approve after expiry: 409 APPROVAL_EXPIRED before and after the sweep, zero writes, order APPROVAL_EXPIRED', async () => {
    const before = counts(w);
    const { orderId, approvalId } = await pizzaOrder(w);
    await ageApproval(w.t, approvalId, APPROVAL_EXPIRY_MS + 1000);
    const hash = (await getApproval(w, PIZZA, approvalId)).payloadHash;
    // Past the deadline but not swept yet: the decision itself checks the clock.
    const late = await decide(w, PIZZA, approvalId, 'approve', hash);
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ code: 'APPROVAL_EXPIRED' });
    expect(await statusOf(w, 'approval_requests', approvalId)).toBe('PENDING');
    expect(await steps(w, approvalId)).toEqual([]);
    await w.app.composed.engine.expireDue();
    await quiesce();
    expect(await statusOf(w, 'approval_requests', approvalId)).toBe('EXPIRED');
    expect(await statusOf(w, 'orders', orderId)).toBe('APPROVAL_EXPIRED');
    // Swept: approve and reject are both still refused.
    for (const decision of ['approve', 'reject'] as const) {
      const res = await decide(w, PIZZA, approvalId, decision, hash);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'APPROVAL_EXPIRED' });
    }
    await quiesce();
    expect(await statusOf(w, 'approval_requests', approvalId)).toBe('EXPIRED');
    expect(await statusOf(w, 'orders', orderId)).toBe('APPROVAL_EXPIRED');
    expect(await steps(w, approvalId)).toEqual([]);
    expect(await count(w, "activity_events where type = 'approval.expired' and payload->>'approvalId' = $1", [approvalId])).toBe(1);
    expect(delta(w, before)).toEqual(NONE);
  });

  it('approve after reject: 409 APPROVAL_ALREADY_DECIDED, the order stays REJECTED, zero writes', async () => {
    const before = counts(w);
    const { orderId, approvalId } = await pizzaOrder(w);
    const hash = (await getApproval(w, PIZZA, approvalId)).payloadHash;
    expect((await decide(w, PIZZA, approvalId, 'reject', hash)).statusCode).toBe(200);
    for (let i = 0; i < 3; i++) {
      const res = await decide(w, PIZZA, approvalId, 'approve', hash);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'APPROVAL_ALREADY_DECIDED' });
    }
    await quiesce();
    expect(await statusOf(w, 'approval_requests', approvalId)).toBe('REJECTED');
    expect(await statusOf(w, 'orders', orderId)).toBe('REJECTED');
    expect(await steps(w, approvalId)).toEqual([]);
    expect(await count(w, "activity_events where type = 'approval.decided' and payload->>'approvalId' = $1", [approvalId])).toBe(1);
    expect(delta(w, before)).toEqual(NONE);
  });

  it('reject after approve: 409 APPROVAL_ALREADY_DECIDED, the bundle that already ran is not undone or rerun', async () => {
    const before = counts(w);
    const { orderId, approvalId } = await pizzaOrder(w);
    const { payloadHash } = await approve(w, PIZZA, approvalId);
    expect(delta(w, before)).toEqual({ square: 1, messages: 1, calendar: 0, sheets: 0 });
    const res = await decide(w, PIZZA, approvalId, 'reject', payloadHash);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'APPROVAL_ALREADY_DECIDED' });
    await quiesce();
    expect(await statusOf(w, 'approval_requests', approvalId)).toBe('APPROVED');
    expect(await statusOf(w, 'orders', orderId)).toBe('PAYMENT_PENDING');
    expect((await steps(w, approvalId)).map((s) => [s.status, s.attempts])).toEqual([['SUCCEEDED', 1], ['SUCCEEDED', 1], ['SUCCEEDED', 1]]);
    expect(delta(w, before)).toEqual({ square: 1, messages: 1, calendar: 0, sheets: 0 });
  });

  it('approve by another owner: 403 FORBIDDEN_BUSINESS in the victim scope, 404 NOT_FOUND in their own, nothing changes', async () => {
    const before = counts(w);
    const { orderId, approvalId } = await pizzaOrder(w);
    const hash = (await getApproval(w, PIZZA, approvalId)).payloadHash;
    for (const decision of ['approve', 'reject'] as const) {
      const inVictimScope = await decide(w, PIZZA, approvalId, decision, hash, OTHER);
      expect(inVictimScope.statusCode).toBe(403);
      expect(inVictimScope.json()).toMatchObject({ code: 'FORBIDDEN_BUSINESS' });
      const inOwnScope = await decide(w, OTHER_BIZ, approvalId, decision, hash, OTHER);
      expect(inOwnScope.statusCode).toBe(404);
      expect(inOwnScope.json()).toMatchObject({ code: 'NOT_FOUND' });
      for (const res of [inVictimScope, inOwnScope]) {
        expect(res.body).not.toContain(hash);
        expect(res.body).not.toContain(RECIPIENT);
      }
    }
    // No scope at all is not a way in either.
    const noScope = await w.app.inject({ method: 'POST', url: `/api/approvals/${approvalId}/decision`, headers: OTHER, payload: { decision: 'approve', payloadHash: hash } });
    expect(noScope.statusCode).toBeGreaterThanOrEqual(400);
    await expectUntouched(orderId, approvalId);
    expect(delta(w, before)).toEqual(NONE);
  });

  it('approve an approval of another business, as the owner of both: 404 NOT_FOUND, nothing changes in either business', async () => {
    const before = counts(w);
    const pizza = await pizzaOrder(w);
    const barber = await bookingProposal(w, { minDays: 2 });
    const pizzaHash = (await getApproval(w, PIZZA, pizza.approvalId)).payloadHash;
    const barberHash = (await getApproval(w, BARBER, barber.approvalId)).payloadHash;
    // The pizza approval through the barbershop scope, and the booking approval through the pizza scope.
    for (const [scope, id, hash] of [[BARBER, pizza.approvalId, pizzaHash], [PIZZA, barber.approvalId, barberHash], [BARBER, pizza.approvalId, barberHash]] as const) {
      const res = await decide(w, scope, id, 'approve', hash);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'NOT_FOUND' });
      expect(res.body).not.toContain(pizzaHash);
      expect(res.body).not.toContain(barberHash);
    }
    await expectUntouched(pizza.orderId, pizza.approvalId);
    expect(await statusOf(w, 'approval_requests', barber.approvalId)).toBe('PENDING');
    expect(await statusOf(w, 'bookings', barber.bookingId)).toBe('AWAITING_OWNER_APPROVAL');
    expect(await steps(w, barber.approvalId)).toEqual([]);
    expect(delta(w, before)).toEqual(NONE);
    // Clear the slot for later tests.
    expect((await decide(w, BARBER, barber.approvalId, 'reject', barberHash)).statusCode).toBe(200);
  });
});

describe('duplicate and racing decisions', () => {
  it('the same approve sent 20 times in parallel: one decision, each step run once with its database key, one link, one message', async () => {
    const before = counts(w);
    const keysBefore = w.square.createKeys.length;
    const { orderId, approvalId } = await pizzaOrder(w);
    const hash = (await getApproval(w, PIZZA, approvalId)).payloadHash;
    const responses = await Promise.all(Array.from({ length: 20 }, () => decide(w, PIZZA, approvalId, 'approve', hash)));
    expect(responses.map((r) => r.statusCode)).toEqual(Array.from({ length: 20 }, () => 200));
    expect(new Set(responses.map((r) => JSON.stringify(r.json()))).size).toBe(1);
    await quiesce();
    await quiesce();
    const s = await steps(w, approvalId);
    expect(s.map((x) => [x.action_type, x.status, x.attempts])).toEqual([
      ['square.checkout.create', 'SUCCEEDED', 1], ['message.checkout.send', 'SUCCEEDED', 1], ['local.order.record', 'SUCCEEDED', 1]]);
    for (const x of s) expect(x.idempotency_key).toBe(await idempotencyKey({ businessId: PIZZA, subjectId: orderId, actionType: x.action_type as never, approvalId }));
    expect(w.square.createKeys.slice(keysBefore)).toEqual([s[0]!.idempotency_key]);
    expect(w.messages.sent.filter((m) => m.idempotencyKey === s[1]!.idempotency_key)).toHaveLength(1);
    expect(await count(w, 'message_dispatches where approval_id = $1', [approvalId])).toBe(1);
    expect(await count(w, "activity_events where type = 'approval.decided' and payload->>'approvalId' = $1", [approvalId])).toBe(1);
    expect(await count(w, "activity_events where type = 'checkout.created' and payload->>'orderId' = $1", [orderId])).toBe(1);
    expect(await order(w, orderId)).toMatchObject({ status: 'PAYMENT_PENDING', square_payment_id: null });
    expect(delta(w, before)).toEqual({ square: 1, messages: 1, calendar: 0, sheets: 0 });
  });

  it('10 approves racing 10 rejects: exactly one decision is recorded and the writes match it', async () => {
    const before = counts(w);
    const { orderId, approvalId } = await pizzaOrder(w);
    const hash = (await getApproval(w, PIZZA, approvalId)).payloadHash;
    const sent = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 'reject' : 'approve') as 'approve' | 'reject');
    const responses = await Promise.all(sent.map((d) => decide(w, PIZZA, approvalId, d, hash)));
    await quiesce();
    const state = await statusOf(w, 'approval_requests', approvalId);
    expect(['APPROVED', 'REJECTED']).toContain(state);
    const winner = state === 'APPROVED' ? 'approve' : 'reject';
    responses.forEach((r, i) => {
      if (sent[i] === winner) expect(r.statusCode).toBe(200);
      else expect(r.json()).toMatchObject({ code: 'APPROVAL_ALREADY_DECIDED' });
    });
    expect(await count(w, "activity_events where type = 'approval.decided' and payload->>'approvalId' = $1", [approvalId])).toBe(1);
    if (state === 'APPROVED') {
      expect(await statusOf(w, 'orders', orderId)).toBe('PAYMENT_PENDING');
      expect(delta(w, before)).toEqual({ square: 1, messages: 1, calendar: 0, sheets: 0 });
    } else {
      expect(await statusOf(w, 'orders', orderId)).toBe('REJECTED');
      expect(await steps(w, approvalId)).toEqual([]);
      expect(delta(w, before)).toEqual(NONE);
    }
  });

  it('20 parallel approves of a booking: one Calendar event, one confirmation', async () => {
    const before = counts(w);
    const { bookingId, approvalId } = await bookingProposal(w, { minDays: 3 });
    const hash = (await getApproval(w, BARBER, approvalId)).payloadHash;
    const responses = await Promise.all(Array.from({ length: 20 }, () => decide(w, BARBER, approvalId, 'approve', hash)));
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    await quiesce();
    await quiesce();
    expect((await steps(w, approvalId)).map((x) => [x.status, x.attempts])).toEqual([['SUCCEEDED', 1], ['SUCCEEDED', 1], ['SUCCEEDED', 1]]);
    expect(await statusOf(w, 'bookings', bookingId)).toBe('BOOKED_VERIFIED');
    expect(await count(w, "sync_jobs where record_id = $1", [bookingId])).toBe(1);
    expect(delta(w, before)).toEqual({ square: 0, messages: 1, calendar: 1, sheets: 1 });
  });

  it('Idempotency-Key: a replay returns the first response, and the key cannot be reused for another body', async () => {
    const before = counts(w);
    const { approvalId } = await pizzaOrder(w);
    const other = await pizzaOrder(w, { recipient: '+15555550177' });
    const hash = (await getApproval(w, PIZZA, approvalId)).payloadHash;
    const otherHash = (await getApproval(w, PIZZA, other.approvalId)).payloadHash;
    const headers = { ...OWNER, 'idempotency-key': 'adv-key-00000001' };
    const first = await decide(w, PIZZA, approvalId, 'reject', hash, headers);
    expect(first.statusCode).toBe(200);
    const replays = await Promise.all(Array.from({ length: 5 }, () => decide(w, PIZZA, approvalId, 'reject', hash, headers)));
    for (const r of replays) expect(r.json()).toEqual(first.json());
    // The same key with another decision, or for another approval, is refused and decides nothing.
    const flipped = await decide(w, PIZZA, approvalId, 'approve', hash, headers);
    expect(flipped.statusCode).toBe(400);
    expect(flipped.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    const reused = await decide(w, PIZZA, other.approvalId, 'approve', otherHash, headers);
    expect(reused.statusCode).toBe(400);
    await expectUntouched(other.orderId, other.approvalId);
    expect(await statusOf(w, 'approval_requests', approvalId)).toBe('REJECTED');
    // Another owner sending the same key gets no cached answer.
    expect((await decide(w, PIZZA, approvalId, 'reject', hash, { ...OTHER, 'idempotency-key': 'adv-key-00000001' })).json()).toMatchObject({ code: 'FORBIDDEN_BUSINESS' });
    expect(delta(w, before)).toEqual(NONE);
  });
});

/**
 * Test-only corruption of a stored approval, as only the database owner could do it (guard trigger off
 * for one statement, the same technique as ageApproval). The decision that follows is the real routine.
 */
async function corruptStoredApproval(t: TestDb, approvalId: string, change: (payload: Record<string, unknown>) => Record<string, unknown>, rehash: boolean) {
  await t.admin(async (q) => {
    const row = (await q.query('select payload from public.approval_requests where id = $1', [approvalId])).rows[0] as { payload: Record<string, unknown> };
    const payload = change({ ...row.payload });
    await q.query('alter table public.approval_requests disable trigger approval_requests_guard');
    try {
      if (rehash) await q.query('update public.approval_requests set payload = $2::jsonb, payload_canonical = $3, payload_hash = $4 where id = $1', [approvalId, JSON.stringify(payload), canonicalJson(payload), await hashCanonical(payload)]);
      else await q.query('update public.approval_requests set payload = $2::jsonb, payload_canonical = $3 where id = $1', [approvalId, JSON.stringify(payload), canonicalJson(payload)]);
    } finally {
      await q.query('alter table public.approval_requests enable always trigger approval_requests_guard');
    }
  });
}

describe('a payload changed after the proposal', () => {
  const ATTACKER = '+15555550666';

  it('the runtime role cannot rewrite an approval, decide it, or forge its execution steps', async () => {
    const before = counts(w);
    const { orderId, approvalId } = await pizzaOrder(w);
    const denied = [
      w.t.db.query(`update approval_requests set payload = jsonb_set(payload, '{messageRecipient}', '"${ATTACKER}"') where id = $1`, [approvalId]),
      w.t.db.query(`update approval_requests set payload_hash = 'sha256:${'a'.repeat(64)}' where id = $1`, [approvalId]),
      w.t.db.query("update approval_requests set state = 'APPROVED', decided_by = 'usr_owner_01', decided_at = now() where id = $1", [approvalId]),
      w.t.db.query("update approval_requests set expires_at = now() + interval '1 day' where id = $1", [approvalId]),
      w.t.db.query('delete from approval_requests where id = $1', [approvalId]),
      w.t.db.query(`insert into action_executions (business_id, approval_id, action_type, step_index, status, idempotency_key)
        values ($1, $2, 'square.checkout.create', 0, 'QUEUED', $3)`, [PIZZA, approvalId, 'f'.repeat(64)]),
      w.t.db.query(`insert into message_dispatches (business_id, approval_id, recipient, channel, status, idempotency_key)
        values ($1, $2, $3, 'surge', 'QUEUED', $4)`, [PIZZA, approvalId, ATTACKER, 'e'.repeat(64)]),
    ];
    for (const attempt of denied) await expect(attempt).rejects.toThrow(/permission denied/i);
    await expectUntouched(orderId, approvalId);
    expect((await getApproval(w, PIZZA, approvalId)).payload).toMatchObject({ messageRecipient: RECIPIENT });
    expect(delta(w, before)).toEqual(NONE);
  });

  // Since 0006 (orders_material_guard) the runtime role can no longer change an order's cart, quote,
  // total, contact or fulfillment, and each change below first asserts that refusal. The suite was
  // written when abos_app could; to keep the downstream check (the decision and the executor compare
  // the order with the signed material) the change is then made as the table owner, whom the guard
  // does not cover. Adapted after the merge.
  const BIGGER: Cart = { lines: [{ ...CART.lines[0]!, quantity: 20 }] };
  const changeAs = async (sql: string, params: unknown[]) => {
    await expect(w.t.db.query(sql, params)).rejects.toThrow(/protected order material/);
    await w.t.admin(async (q) => { await q.query(sql, params); });
  };
  it.each([
    ['cart', async (orderId: string) => { await changeAs('update public.orders set cart = $2::jsonb, cart_hash = $3 where id = $1', [orderId, JSON.stringify(BIGGER), await cartHash(BIGGER)]); }],
    ['total', async (orderId: string) => { await changeAs('update public.orders set total_minor = 1 where id = $1', [orderId]); }],
    ['pickup time', async (orderId: string) => { await changeAs(`update public.orders set fulfillment = jsonb_set(fulfillment, '{pickupAt}', to_jsonb($2::text)) where id = $1`, [orderId, pickupAt('19:30')]); }],
  ] as const)('order %s changed in the database after the proposal: the old hash is refused, zero writes', async (_field, change) => {
    const before = counts(w);
    const { orderId, approvalId } = await pizzaOrder(w);
    const hash = (await getApproval(w, PIZZA, approvalId)).payloadHash;
    await change(orderId);
    // The approval the owner saw is unchanged, so its hash is unchanged too.
    expect((await getApproval(w, PIZZA, approvalId)).payloadHash).toBe(hash);
    const res = await decide(w, PIZZA, approvalId, 'approve', hash);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'INVALID_STATE' });
    await expectUntouched(orderId, approvalId);
    expect(delta(w, before)).toEqual(NONE);
  });

  describe('cart rewritten under an unchanged cart hash', () => {
    let ids: { orderId: string; approvalId: string };
    it('the approval passes, the executor refuses the step: no Square call, no message', async () => {
      const before = counts(w);
      ids = await pizzaOrder(w);
      await changeAs('update public.orders set cart = $2::jsonb where id = $1', [ids.orderId, JSON.stringify(BIGGER)]);
      await approve(w, PIZZA, ids.approvalId);
      await quiesce();
      expect((await steps(w, ids.approvalId)).map((x) => [x.status, x.attempts])).toEqual([['FAILED', 1], ['QUEUED', 0], ['QUEUED', 0]]);
      expect(await order(w, ids.orderId)).toMatchObject({ square_order_id: null, checkout_url: null, square_payment_id: null });
      expect(await count(w, 'message_dispatches where approval_id = $1', [ids.approvalId])).toBe(0);
      expect(delta(w, before)).toEqual(NONE);
    });
    // Was DEFECT 4 in the pull request (the refused order stayed APPROVED). Fixed on arsh/integration
    // before the merge (the reworked 0005 routines move it), so this is a plain test now.
    it('the refused order is surfaced for review (RECOVERY_REQUIRED) instead of staying APPROVED', async () => {
      expect((await order(w, ids.orderId)).status).toBe('RECOVERY_REQUIRED');
    });
  });

  it('recipient replaced on the order row: the one message goes to the approved number only', async () => {
    const before = counts(w);
    const sentBefore = w.messages.sent.length;
    const { orderId, approvalId } = await pizzaOrder(w, { recipient: '+15555550155' });
    await changeAs(`update public.orders set contact = jsonb_set(contact, '{messageRecipient}', to_jsonb($2::text)) where id = $1`, [orderId, ATTACKER]);
    await approve(w, PIZZA, approvalId);
    await quiesce();
    const sent = w.messages.sent.slice(sentBefore);
    expect(sent.map((m) => m.to)).toEqual(['+15555550155']);
    expect((await w.t.db.query('select recipient, status from message_dispatches where approval_id = $1', [approvalId])).rows).toEqual([{ recipient: '+15555550155', status: 'SENT' }]);
    expect(w.messages.sent.some((m) => m.to === ATTACKER)).toBe(false);
    expect((await order(w, orderId)).status).toBe('PAYMENT_PENDING');
    expect(delta(w, before)).toEqual({ square: 1, messages: 1, calendar: 0, sheets: 0 });
  });

  it.each([
    ['recipient', (p: Record<string, unknown>) => ({ ...p, messageRecipient: ATTACKER })],
    ['total', (p: Record<string, unknown>) => ({ ...p, totalMinor: 1 })],
    ['pickup time', (p: Record<string, unknown>) => ({ ...p, pickupAt: pickupAt('19:30') })],
    ['cart', (p: Record<string, unknown>) => ({ ...p, cartHash: `sha256:${'c'.repeat(64)}` })],
  ] as const)('stored payload %s rewritten by a database owner: impossible without a new hash, and the old hash is then refused', async (_field, change) => {
    const before = counts(w);
    const { orderId, approvalId } = await pizzaOrder(w);
    const shown = await getApproval(w, PIZZA, approvalId);
    // Even the table owner, with the guard trigger off, cannot store a payload under the old hash.
    await expect(corruptStoredApproval(w.t, approvalId, change, false)).rejects.toThrow(/approval_payload_hash_matches/);
    expect(await getApproval(w, PIZZA, approvalId)).toEqual(shown);
    // With the stored hash recomputed, the hash the owner saw no longer approves anything.
    await corruptStoredApproval(w.t, approvalId, change, true);
    expect((await getApproval(w, PIZZA, approvalId)).payloadHash).not.toBe(shown.payloadHash);
    const res = await decide(w, PIZZA, approvalId, 'approve', shown.payloadHash);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'PAYLOAD_HASH_MISMATCH' });
    await expectUntouched(orderId, approvalId);
    expect(delta(w, before)).toEqual(NONE);
  });

  it.each([
    ['cart and total', { cart: BIGGER }],
    ['recipient', { recipient: '+15555550144' }],
    ['pickup time', { pickup: pickupAt('19:00') }],
  ] as const)('a new proposal that differs in %s has a new hash; the old hash cannot approve it', async (_field, changed) => {
    const before = counts(w);
    const first = await pizzaOrder(w);
    const second = await pizzaOrder(w, changed);
    const a = await getApproval(w, PIZZA, first.approvalId);
    const b = await getApproval(w, PIZZA, second.approvalId);
    expect(second.approvalId).not.toBe(first.approvalId);
    expect(b.payloadHash).not.toBe(a.payloadHash);
    const res = await decide(w, PIZZA, second.approvalId, 'approve', a.payloadHash);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'PAYLOAD_HASH_MISMATCH' });
    await expectUntouched(second.orderId, second.approvalId);
    await expectUntouched(first.orderId, first.approvalId);
    expect(delta(w, before)).toEqual(NONE);
  });
});
