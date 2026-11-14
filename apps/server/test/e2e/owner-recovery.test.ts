// Issue #54 on migration 0008: the owner's retry or abandon through POST /api/executions/:id/resolve,
// on the in-process Postgres as abos_app, with the real engine, executor and recovery ports, and fake
// providers. Each test counts the external writes it caused.
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRecoveryPlugin, RECOVERY_MESSAGES } from '../../src/api/recovery/index';
import { createDbRecoveryPorts } from '../../src/compose/recovery';
import { currentRole } from '../support/db';
import { OWNER, OTHER, createWorld, type World } from './world';
import { PIZZA, approve, count, counts, delta, order, pizzaOrder, steps } from '../adversarial/helpers';

const resolve = (w: World, id: string, action: 'retry' | 'abandon', headers = OWNER) =>
  w.app.inject({ method: 'POST', url: `/api/executions/${id}/resolve?businessId=${PIZZA}`, headers, payload: { action } });
const dispatchOf = async (w: World, approvalId: string) =>
  (await w.t.db.query('select status, provider_message_id from message_dispatches where approval_id = $1', [approvalId])).rows as { status: string; provider_message_id: string | null }[];

describe('a message whose delivery is unknown', () => {
  let w: World;
  beforeAll(async () => { w = await createWorld(); }, 120_000);
  afterAll(async () => { await w?.close(); });

  it('runs as abos_app', async () => { expect(await currentRole(w.t.db)).toBe('abos_app'); });

  it('retry is refused with a plain sentence and sends nothing; abandon marks the dispatch and the step FAILED, once', async () => {
    const providers = w.app.composed.providers;
    const original = providers.message;
    const sends: string[] = [];
    providers.message = { channel: original!.channel, send: async (input) => { sends.push(input.idempotencyKey); return { status: 'UNKNOWN', errorCode: 'INTEGRATION_UNAVAILABLE' }; } };
    let ids: { orderId: string; approvalId: string };
    try {
      ids = await pizzaOrder(w);
      await approve(w, PIZZA, ids.approvalId);
      await w.settle();
    } finally { providers.message = original; }
    const message = (await steps(w, ids.approvalId))[1]!;
    expect(message).toMatchObject({ action_type: 'message.checkout.send', status: 'NEEDS_REVIEW' });
    expect(await dispatchOf(w, ids.approvalId)).toEqual([{ status: 'UNKNOWN', provider_message_id: null }]);
    expect(sends).toEqual([message.idempotency_key]);
    const before = counts(w);

    const retry = await resolve(w, message.id, 'retry');
    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toMatchObject({ code: 'INVALID_STATE', message: RECOVERY_MESSAGES.messageNotResent });
    expect((await steps(w, ids.approvalId))[1]!.status).toBe('NEEDS_REVIEW');

    expect((await resolve(w, message.id, 'abandon', OTHER)).statusCode).toBeGreaterThanOrEqual(403);
    const events = await count(w, 'activity_events where business_id = $1', [PIZZA]);
    const abandon = await resolve(w, message.id, 'abandon');
    expect(abandon.statusCode, abandon.body).toBe(200);
    expect(abandon.json().execution).toMatchObject({ id: message.id, status: 'FAILED', idempotencyKey: message.idempotency_key });
    expect(await dispatchOf(w, ids.approvalId)).toEqual([{ status: 'FAILED', provider_message_id: null }]);
    expect(await count(w, 'activity_events where business_id = $1', [PIZZA])).toBe(events + 2);
    expect(await count(w, "activity_events where type = 'message.failed' and actor_type = 'owner' and payload->>'status' = 'FAILED' and payload->>'subjectId' = $1", [ids.orderId])).toBe(1);
    // A repeat is refused at the route: the step is no longer in review.
    expect((await resolve(w, message.id, 'abandon')).statusCode).toBe(409);
    w.app.composed.executor.kick(PIZZA);
    await w.settle();
    expect(sends).toHaveLength(1);
    expect(delta(w, before)).toEqual({ square: 0, messages: 0, calendar: 0, sheets: 0 });
    expect((await order(w, ids.orderId)).status).toBe('PAYMENT_PENDING');
  });
});

describe('a checkout retry after a lookup proves no link exists', () => {
  // The Square lookup in compose/recovery.ts cannot prove absence (a timed-out CreatePaymentLink leaves no
  // reference to read back), so it answers "unknown" and the route refuses. This test replaces only the
  // lookup with one that proves absence, to show what the database and the executor do with that proof.
  let w: World;
  beforeAll(async () => { w = await createWorld(); }, 120_000);
  afterAll(async () => { await w?.close(); });

  it('requeues the same step with the same key; the next attempt creates the link from RECOVERY_REQUIRED and the bundle goes on', async () => {
    const c = w.app.composed;
    w.square.mode.create = 'timeout';
    let ids: { orderId: string; approvalId: string };
    try {
      ids = await pizzaOrder(w);
      await approve(w, PIZZA, ids.approvalId);
      await w.settle();
    } finally { w.square.mode.create = 'ok'; }
    const checkout = (await steps(w, ids.approvalId))[0]!;
    expect(checkout).toMatchObject({ status: 'NEEDS_REVIEW', attempts: 1, external_ref: null });
    expect((await order(w, ids.orderId)).status).toBe('RECOVERY_REQUIRED');
    // Through the real route and ports, the lookup cannot prove absence.
    expect((await resolve(w, checkout.id, 'retry')).json()).toMatchObject({ code: 'INVALID_STATE', message: RECOVERY_MESSAGES.outcomeUnknown });

    const ports = createDbRecoveryPorts({ db: c.db, now: c.now, newId: c.newId, providers: c.providers });
    const owner = (await w.t.db.query('select owner_id from businesses where id = $1', [PIZZA])).rows[0] as { owner_id: string };
    const proving = Fastify();
    proving.addHook('preHandler', async (req) => { req.ownerUserId = owner.owner_id; });
    await proving.register(createRecoveryPlugin({ ...ports, lookup: async () => ({ outcome: 'absent' }) }));
    try {
      // Another owner whose route-level ownership check is bypassed is still refused by the database.
      const other = Fastify();
      other.addHook('preHandler', async (req) => { req.ownerUserId = 'usr_other_01'; });
      await other.register(createRecoveryPlugin({ ...ports, ownsBusiness: async () => true, lookup: async () => ({ outcome: 'absent' }) }));
      const refused = await other.inject({ method: 'POST', url: `/api/executions/${checkout.id}/resolve?businessId=${PIZZA}`, payload: { action: 'retry' } });
      expect(refused.json()).toMatchObject({ code: 'FORBIDDEN_BUSINESS' });
      await other.close();
      expect((await steps(w, ids.approvalId))[0]!.status).toBe('NEEDS_REVIEW');
      const res = await proving.inject({ method: 'POST', url: `/api/executions/${checkout.id}/resolve?businessId=${PIZZA}`, payload: { action: 'retry' } });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().execution).toMatchObject({ id: checkout.id, status: 'QUEUED', attempts: 1, idempotencyKey: checkout.idempotency_key });
    } finally { await proving.close(); }

    const keysBefore = w.square.createKeys.length;
    c.executor.kick(PIZZA);
    await w.settle();
    const after = await steps(w, ids.approvalId);
    expect(after.map((s) => [s.status, s.attempts])).toEqual([['SUCCEEDED', 2], ['SUCCEEDED', 1], ['SUCCEEDED', 1]]);
    expect(after[0]!.idempotency_key).toBe(checkout.idempotency_key);
    // One more CreatePaymentLink, with the original key.
    expect(w.square.createKeys.slice(keysBefore)).toEqual([checkout.idempotency_key]);
    expect(await order(w, ids.orderId)).toMatchObject({ status: 'PAYMENT_PENDING', checkout_url: expect.stringMatching(/^https:\/\//) });
    expect(await count(w, "activity_events where type = 'execution.failed' and payload->>'executionId' = $1 and payload->>'nextStatus' = 'QUEUED'", [checkout.id])).toBe(1);
  });
});
