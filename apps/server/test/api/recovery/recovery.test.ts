import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ActivityEventSchema, ApiErrorSchema, CancelOrderResponseSchema,
  ResolveExecutionResponseSchema, type ActionExecution, type ActivityEvent,
  type Order, type ResolveExecutionBody,
} from '@abos/contracts';
import {
  approvalBookingVerified, approvalOrderPaymentPending, bookingVerified, executionsBookingVerified,
  executionsOrderPaymentPending, messageDispatches, orderPaymentPending,
} from '@abos/contracts/fixtures';
import { RECOVERY_MESSAGES, createRecoveryPlugin, type RecoveryLookup, type RecoveryPorts, type RecoveryRecord,
  type RecoveryDecision, type RecoveryScope, type RecoveryTransaction } from '../../../src/api/recovery/index';

type Harness = Awaited<ReturnType<typeof buildHarness>>;
const harnesses: Harness[] = [];

async function buildHarness(kind: 'checkout' | 'booking' | 'message' = 'checkout') {
  const base = kind === 'booking' ? executionsBookingVerified[0]! : executionsOrderPaymentPending[kind === 'message' ? 1 : 0]!;
  const approval = structuredClone(kind === 'booking' ? approvalBookingVerified : approvalOrderPaymentPending);
  const execution: ActionExecution = { ...base, status: 'NEEDS_REVIEW', attempts: 1 };
  const record: RecoveryRecord = { execution, approval };
  if (kind === 'booking') record.booking = { ...structuredClone(bookingVerified), status: 'RETRY_REQUIRED' };
  else record.order = structuredClone(orderPaymentPending);
  if (kind === 'message') {
    const dispatch = messageDispatches.find(d => d.executionId === execution.id)!;
    record.dispatch = { ...structuredClone(dispatch), status: 'UNKNOWN' };
  }
  const state = {
    record, order: structuredClone(orderPaymentPending) as Order | undefined,
    owned: true, authenticated: true, missing: false,
    now: new Date(Date.parse(approval.createdAt) + 120_000),
    lookup: { outcome: 'absent' } as RecoveryLookup,
    events: [] as ActivityEvent[], decision: undefined as RecoveryDecision | undefined,
    resolution: undefined as Parameters<RecoveryTransaction['resolveNeedsReview']>[0] | undefined,
    lookups: 0, reconciles: 0, resolverCalls: 0, cancels: 0,
    reconciliation: undefined as Order | undefined,
    throwLookup: false, throwReconcile: false, throwActivity: false, mutateKey: false, omitExternalRef: false,
    keys: [] as string[], scopes: [] as RecoveryScope[],
  };
  const originalKey = execution.idempotencyKey;
  const tx: RecoveryTransaction = {
    async loadOrder() { return state.order; },
    async loadExecution() { return state.missing ? undefined : state.record; },
    async recoveryDecision() { return state.decision; },
    async cancelOrder(order) {
      state.cancels++;
      state.order = { ...order, status: 'CANCELLED' };
      return state.order;
    },
    async resolveNeedsReview(input) {
      state.resolverCalls++;
      state.resolution = structuredClone(input);
      state.keys.push(input.record.execution.idempotencyKey);
      state.record.execution = {
        ...input.record.execution, status: input.status,
        ...(input.lookup.outcome === 'exists' ? { externalRef: state.omitExternalRef ? undefined : input.lookup.externalRef } : {}),
        ...(state.mutateKey ? { idempotencyKey: 'f'.repeat(64) } : {}),
      };
      if (state.throwActivity) throw new Error('provider secret should never escape');
      state.events.push(ActivityEventSchema.parse(input.event));
      state.decision = { action: input.action, generation: input.record.execution.attempts, execution: state.record.execution };
      return state.decision;
    },
    activity: { async write(event) {
      if (state.throwActivity) throw new Error('provider secret should never escape');
      state.events.push(ActivityEventSchema.parse(event));
    } },
  };
  let tail = Promise.resolve();
  const ports: RecoveryPorts = {
    async ownsBusiness() { return state.owned; },
    async withRecovery(scope, fn) {
      const prior = tail;
      let release!: () => void;
      tail = new Promise<void>(resolve => { release = resolve; });
      await prior;
      state.scopes.push(scope);
      const snapshot = structuredClone({ record: state.record, order: state.order, events: state.events, decision: state.decision, resolution: state.resolution, resolverCalls: state.resolverCalls, cancels: state.cancels });
      try { return await fn(tx); }
      catch (error) { Object.assign(state, snapshot); throw error; }
      finally { release(); }
    },
    async lookup() {
      state.lookups++;
      if (state.throwLookup) throw new Error('provider secret should never escape');
      return state.lookup;
    },
    async reconcilePayment(order) { if (state.throwReconcile) throw new Error('provider secret'); state.reconciles++; state.order = state.reconciliation ?? order; return state.order; },
    clock: { now: () => state.now },
    ids: { next: () => `evt_recovery_${state.events.length + 1}` },
  };
  const app = Fastify();
  app.addHook('preHandler', async req => { if (state.authenticated) req.ownerUserId = 'usr_owner'; });
  await app.register(createRecoveryPlugin(ports));
  await app.ready();
  const request = (action: ResolveExecutionBody['action'] = 'retry') => app.inject({
    method: 'POST', url: `/api/executions/${state.record.execution.id}/resolve?businessId=${state.record.execution.businessId}`,
    payload: { action },
  });
  const cancel = () => app.inject({ method: 'POST', url: `/api/orders/${orderPaymentPending.id}/cancel?businessId=${orderPaymentPending.businessId}`, payload: {} });
  const h = { app, state, request, cancel, originalKey };

  return h;
}

async function harness(kind: 'checkout' | 'booking' | 'message' = 'checkout') {
  const h = await buildHarness(kind);
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    expect(h.state.record.execution.idempotencyKey).toBe(h.originalKey);
    expect(h.state.keys.every(key => key === h.originalKey)).toBe(true);
    for (const event of h.state.events) expect(ActivityEventSchema.safeParse(event).success).toBe(true);
    await h.app.close();
  }
});

function error(response: { statusCode: number; json(): unknown }, status: number, code: string) {
  expect(response.statusCode).toBe(status);
  expect(ApiErrorSchema.parse(response.json()).code).toBe(code);
}

describe('POST order cancel', () => {
  it.each(['PAYMENT_PENDING', 'PAYMENT_FAILED', 'RECOVERY_REQUIRED'] as const)('cancels %s locally after reconciliation', async status => {
    const h = await harness(); h.state.order!.status = status;
    const response = await h.cancel();
    expect(response.statusCode).toBe(200);
    expect(CancelOrderResponseSchema.parse(response.json()).order.status).toBe('CANCELLED');
    expect(h.state.reconciles).toBe(1); expect(h.state.cancels).toBe(1); expect(h.state.events).toHaveLength(1);
  });
  it('is idempotent on repeat and concurrent calls', async () => {
    const h = await harness();
    const responses = await Promise.all([h.cancel(), h.cancel(), h.cancel()]);
    expect(responses.map(r => r.statusCode)).toEqual([200, 200, 200]);
    expect(h.state.cancels).toBe(1); expect(h.state.reconciles).toBe(1); expect(h.state.events).toHaveLength(1);
  });
  it('rejects another owner before loading or reconciling', async () => {
    const h = await harness(); h.state.owned = false;
    error(await h.cancel(), 403, 'FORBIDDEN_BUSINESS');
    expect(h.state.scopes).toHaveLength(0); expect(h.state.reconciles).toBe(0); expect(h.state.events).toHaveLength(0);
  });
  it('fails closed without the authentication guard', async () => {
    const h = await harness(); h.state.authenticated = false;
    error(await h.cancel(), 401, 'UNAUTHENTICATED'); expect(h.state.cancels).toBe(0);
  });
  it.each(['APPROVAL_EXPIRED', 'APPROVED', 'CREATING_CHECKOUT', 'FULFILLMENT_READY', 'REJECTED'] as const)('refuses %s', async status => {
    const h = await harness(); h.state.order!.status = status;
    error(await h.cancel(), 409, 'INVALID_STATE'); expect(h.state.cancels).toBe(0); expect(h.state.reconciles).toBe(0);
  });
  it('cannot cancel an order reconciliation found paid', async () => {
    const h = await harness();
    h.state.reconciliation = { ...h.state.order!, status: 'PAID_VERIFIED', squarePaymentId: 'paid_from_provider' };
    error(await h.cancel(), 409, 'INVALID_STATE'); expect(h.state.cancels).toBe(0); expect(h.state.events).toHaveLength(0);
    expect(h.state.order!.status).toBe('PAID_VERIFIED');
  });
  it.each(['missing', 'wrong business', 'wrong id'] as const)('hides %s order', async scenario => {
    const h = await harness();
    if (scenario === 'missing') h.state.order = undefined;
    else if (scenario === 'wrong business') h.state.order!.businessId = 'biz_other';
    else h.state.order!.id = 'ord_other';
    error(await h.cancel(), 404, 'NOT_FOUND'); expect(h.state.cancels).toBe(0);
  });
  it('does not cancel when reconciliation fails', async () => {
    const h = await harness(); h.state.throwReconcile = true;
    const response = await h.cancel(); error(response, 500, 'INTERNAL');
    expect(response.body).not.toContain('secret'); expect(h.state.cancels).toBe(0);
  });
  it('rolls back cancellation when its activity write fails', async () => {
    const h = await harness(); h.state.throwActivity = true;
    const response = await h.cancel(); error(response, 500, 'INTERNAL');
    expect(response.body).not.toContain('secret'); expect(h.state.order!.status).toBe('PAYMENT_PENDING'); expect(h.state.events).toHaveLength(0);
  });
});

describe('POST execution resolve', () => {
  // Issue #54 (0008): retry after proven absence requeues the checkout and the calendar step with the same
  // key. A message whose delivery is unknown is never resent (CONTRACTS: no resend from UNKNOWN), so its
  // retry is refused with a plain sentence even when a lookup claims absence.
  it('refuses a message retry after proven absence, saying it is never resent, with no resolution', async () => {
    const h = await harness('message');
    const response = await h.request();
    error(response, 409, 'INVALID_STATE');
    expect((response.json() as { message: string }).message).toBe(RECOVERY_MESSAGES.messageNotResent);
    expect(h.state.lookups).toBe(1); expect(h.state.resolverCalls).toBe(0); expect(h.state.events).toHaveLength(0);
  });
  // Review of 0008, finding 2: no Square read proves a payment link absent, so even a lookup that claims
  // absence cannot requeue or abandon a checkout. The owner cancels the order.
  it.each(['retry', 'abandon'] as const)('refuses a checkout %s on a claimed absence, saying to cancel the order', async action => {
    const h = await harness('checkout');
    const response = await h.request(action);
    error(response, 409, 'INVALID_STATE');
    expect((response.json() as { message: string }).message).toBe(RECOVERY_MESSAGES.checkoutNotProvable);
    expect(h.state.resolverCalls).toBe(0); expect(h.state.events).toHaveLength(0);
  });
  it('abandons a message in UNKNOWN without provider proof: the owner marks it failed', async () => {
    const h = await harness('message'); h.state.lookup = { outcome: 'unknown' };
    const response = await h.request('abandon');
    expect(response.statusCode).toBe(200); expect(response.json().execution.status).toBe('FAILED');
    expect(h.state.resolution).toMatchObject({ action: 'abandon', status: 'FAILED' });
  });
  it.each([
    ['an expired approval', (h: Harness) => { h.state.record.approval.state = 'EXPIRED'; delete h.state.record.approval.decidedBy; }, 'INVALID_STATE'],
    ['a pending approval', (h: Harness) => { h.state.record.approval.state = 'PENDING'; delete h.state.record.approval.decidedAt; delete h.state.record.approval.decidedBy; }, 'INVALID_STATE'],
    ['an altered approval hash', (h: Harness) => { h.state.record.approval.payloadHash = `sha256:${'f'.repeat(64)}`; }, 'PAYLOAD_HASH_MISMATCH'],
    ['exhausted attempts', (h: Harness) => { h.state.record.execution.attempts = 3; }, 'INVALID_STATE'],
  ] as const)('refuses a calendar requeue with %s, before the routine', async (_name, mutate, code) => {
    const h = await harness('booking'); mutate(h);
    error(await h.request('retry'), 409, code); expect(h.state.resolverCalls).toBe(0); expect(h.state.events).toHaveLength(0);
  });
  it('says why an unknown checkout outcome cannot be resolved', async () => {
    const h = await harness('checkout'); h.state.lookup = { outcome: 'unknown' };
    const response = await h.request('retry');
    error(response, 409, 'INVALID_STATE');
    expect((response.json() as { message: string }).message).toBe(RECOVERY_MESSAGES.outcomeUnknown);
  });
  it('requeues a booking retry after proven absence, keeping the key', async () => {
    const h = await harness('booking');
    const response = await h.request('retry');
    expect(response.statusCode).toBe(200); expect(response.json().execution.status).toBe('QUEUED');
    expect(h.state.resolution).toMatchObject({ action: 'retry', status: 'QUEUED', lookup: { outcome: 'absent' } });
    expect(h.state.resolution?.record.execution.idempotencyKey).toBe(h.originalKey);
  });
  it.each(['checkout', 'booking', 'message'] as const)('refuses %s abandon when provider evidence shows an effect', async kind => {
    const h = await harness(kind); h.state.lookup = { outcome: 'exists', externalRef: 'verified_provider_object' };
    error(await h.request('abandon'), 409, 'INVALID_STATE');
    expect(h.state.resolverCalls).toBe(0); expect(h.state.events).toHaveLength(0); expect(h.state.lookups).toBe(1);
  });
  it.each(['checkout', 'booking', 'message'] as const)('completes a %s retry from provider evidence of the approved effect', async kind => {
    const h = await harness(kind); h.state.lookup = { outcome: 'exists', externalRef: 'verified_provider_object' };
    const response = await h.request('retry');
    expect(response.statusCode).toBe(200); expect(response.json().execution.status).toBe('SUCCEEDED');
    expect(h.state.resolution).toMatchObject({ action: 'retry', status: 'SUCCEEDED', lookup: { outcome: 'exists', externalRef: 'verified_provider_object' } });
    expect(h.state.resolverCalls).toBe(1);
  });
  it('abandons only after lookup proves absence', async () => {
    const h = await harness('booking'); const response = await h.request('abandon');
    expect(response.statusCode).toBe(200); expect(response.json().execution.status).toBe('FAILED');
    expect(h.state.lookups).toBe(1); expect(h.state.resolverCalls).toBe(1); expect(h.state.events).toHaveLength(1);
    expect(h.state.resolution).toMatchObject({ action: 'abandon', status: 'FAILED', lookup: { outcome: 'absent' } });
    expect(h.state.resolution?.record.execution.idempotencyKey).toBe(h.originalKey);
  });
  it.each(['retry', 'abandon'] as const)('leaves an unknown provider outcome stuck for %s', async action => {
    const h = await harness(); h.state.lookup = { outcome: 'unknown' };
    error(await h.request(action), 409, 'INVALID_STATE'); expect(h.state.record.execution.status).toBe('NEEDS_REVIEW');
    expect(h.state.resolverCalls).toBe(0); expect(h.state.events).toHaveLength(0);
  });
  it.each(['booking', 'message'] as const)('serializes same-process %s abandon requests around one generation', async kind => {
    const h = await harness(kind);
    const responses = await Promise.all([h.request('abandon'), h.request('abandon')]);
    expect(responses.map(r => r.statusCode)).toEqual([200, 200]);
    h.state.record.execution.status = 'SUCCEEDED'; h.state.record.execution.attempts++;
    error(await h.request('abandon'), 409, 'INVALID_STATE');
    expect(h.state.lookups).toBe(1); expect(h.state.resolverCalls).toBe(1); expect(h.state.events).toHaveLength(1);
  });
  it('replays abandon without another event or lookup, with the same 200 body', async () => {
    const h = await harness('booking'); const first = await h.request('abandon'); const second = await h.request('abandon');
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]); expect(second.json()).toEqual(first.json());
    expect(h.state.lookups).toBe(1); expect(h.state.events).toHaveLength(1); expect(h.state.resolverCalls).toBe(1);
  });
  it('allows a later NEEDS_REVIEW worker generation without changing the provider key', async () => {
    const h = await harness('booking');
    expect((await h.request('abandon')).statusCode).toBe(200);
    h.state.record.execution = { ...h.state.record.execution, status: 'NEEDS_REVIEW', attempts: h.state.record.execution.attempts + 1 };
    expect((await h.request('abandon')).statusCode).toBe(200);
    expect(h.state.resolverCalls).toBe(2);
    expect(h.state.keys).toEqual([h.originalKey, h.originalKey]);
  });
  it('rejects a different recovery decision after abandon', async () => {
    const h = await harness('booking'); await h.request('abandon');
    error(await h.request('retry'), 409, 'INVALID_STATE'); expect(h.state.resolverCalls).toBe(1);
  });
  it('rejects another owner before lookup', async () => {
    const h = await harness(); h.state.owned = false;
    error(await h.request(), 403, 'FORBIDDEN_BUSINESS'); expect(h.state.lookups).toBe(0); expect(h.state.scopes).toHaveLength(0);
  });
  it('rejects an unauthenticated request', async () => {
    const h = await harness(); h.state.authenticated = false;
    error(await h.request(), 401, 'UNAUTHENTICATED'); expect(h.state.lookups).toBe(0);
  });
  it.each(['QUEUED', 'RUNNING', 'SUCCEEDED', 'SKIPPED', 'FAILED'] as const)('refuses an unrelated %s execution', async status => {
    const h = await harness(); h.state.record.execution.status = status;
    error(await h.request(), 409, 'INVALID_STATE'); expect(h.state.lookups).toBe(0); expect(h.state.resolverCalls).toBe(0);
  });
  it.each(['booking', 'message'] as const)('refuses definitely failed %s retries without additive transitions', async kind => {
    const h = await harness(kind); h.state.record.execution.status = 'FAILED';
    if (h.state.record.dispatch) h.state.record.dispatch.status = 'FAILED';
    error(await h.request(), 409, 'INVALID_STATE'); expect(h.state.resolverCalls).toBe(0); expect(h.state.lookups).toBe(0);
  });
  it('refuses contradictory absence for an already delivered message', async () => {
    const h = await harness('message'); h.state.record.dispatch!.status = 'DELIVERED';
    error(await h.request('abandon'), 409, 'INVALID_STATE'); expect(h.state.lookups).toBe(1); expect(h.state.resolverCalls).toBe(0);
  });
  it('refuses delivered message evidence pending an atomic subject routine', async () => {
    const h = await harness('message'); h.state.record.dispatch!.status = 'DELIVERED';
    h.state.lookup = { outcome: 'exists', externalRef: h.state.record.dispatch!.providerMessageId! };
    error(await h.request('abandon'), 409, 'INVALID_STATE'); expect(h.state.lookups).toBe(1); expect(h.state.resolverCalls).toBe(0);
  });
  it.each(['missing', 'wrong business', 'wrong approval', 'wrong subject'] as const)('hides %s execution', async scenario => {
    const h = await harness();
    if (scenario === 'missing') h.state.missing = true;
    else if (scenario === 'wrong business') h.state.record.execution.businessId = 'biz_other';
    else if (scenario === 'wrong approval') h.state.record.execution.approvalId = 'apv_other';
    else h.state.record.order!.id = 'ord_other';
    error(await h.request(), 404, 'NOT_FOUND'); expect(h.state.lookups).toBe(0);
  });
  it('refuses unsupported retry before inspecting an expired approval', async () => {
    const h = await harness('message'); h.state.record.approval.state = 'EXPIRED'; delete h.state.record.approval.decidedBy;
    error(await h.request(), 409, 'INVALID_STATE'); expect(h.state.resolverCalls).toBe(0); expect(h.state.events).toHaveLength(0);
  });
  it('refuses unsupported retry before inspecting approval time', async () => {
    const h = await harness('message');
    h.state.now = new Date(h.state.record.approval.expiresAt);
    error(await h.request(), 409, 'INVALID_STATE'); expect(h.state.resolverCalls).toBe(0);
  });
  it('refuses unsupported retry before inspecting a pending approval', async () => {
    const h = await harness('message'); h.state.record.approval.state = 'PENDING';
    delete h.state.record.approval.decidedAt; delete h.state.record.approval.decidedBy;
    error(await h.request(), 409, 'INVALID_STATE'); expect(h.state.resolverCalls).toBe(0);
  });
  it('refuses unsupported retry before inspecting an altered approval hash', async () => {
    const h = await harness('message'); h.state.record.approval.payloadHash = `sha256:${'f'.repeat(64)}`;
    error(await h.request(), 409, 'INVALID_STATE'); expect(h.state.resolverCalls).toBe(0);
  });
  it('does not call a removed retry-authorization seam for unsupported recovery', async () => {
    const h = await harness('message');
    error(await h.request(), 409, 'INVALID_STATE'); expect(h.state.resolverCalls).toBe(0);
  });
  it('cannot reset exhausted attempts', async () => {
    const h = await harness(); h.state.record.execution.attempts = 3;
    error(await h.request(), 409, 'INVALID_STATE'); expect(h.state.record.execution.attempts).toBe(3); expect(h.state.resolverCalls).toBe(0);
  });
  it('refuses an existing effect without an atomic subject recovery routine', async () => {
    const h = await harness(); h.state.record.execution.attempts = 3; h.state.record.approval.state = 'EXPIRED'; delete h.state.record.approval.decidedBy;
    h.state.lookup = { outcome: 'exists', externalRef: 'provider_verified' };
    error(await h.request('abandon'), 409, 'INVALID_STATE'); expect(h.state.resolverCalls).toBe(0);
  });
  it('sanitizes a lookup failure and preserves review state', async () => {
    const h = await harness(); h.state.throwLookup = true;
    const response = await h.request('abandon'); error(response, 500, 'INTERNAL'); expect(response.body).not.toContain('secret');
    expect(h.state.record.execution.status).toBe('NEEDS_REVIEW'); expect(h.state.resolverCalls).toBe(0);
  });
  it('rolls back an abandon decision when its checked routine cannot persist the audit event', async () => {
    const h = await harness('booking'); h.state.throwActivity = true;
    error(await h.request('abandon'), 500, 'INTERNAL'); expect(h.state.record.execution.status).toBe('NEEDS_REVIEW');
    expect(h.state.resolverCalls).toBe(0); expect(h.state.decision).toBeUndefined();
  });
  it('refuses a verified effect instead of recording a partial execution success', async () => {
    const h = await harness(); h.state.lookup = { outcome: 'exists', externalRef: 'verified_reference' }; h.state.omitExternalRef = true;
    error(await h.request('abandon'), 409, 'INVALID_STATE'); expect(h.state.record.execution.status).toBe('NEEDS_REVIEW');
  });
  it('rejects a port attempting to replace the existing key', async () => {
    const h = await harness('booking'); h.state.mutateKey = true;
    error(await h.request('abandon'), 500, 'INTERNAL'); expect(h.state.resolverCalls).toBe(0);
  });
  it.each(['bogus', 'RETRY', ''])('rejects invalid action %s', async action => {
    const h = await harness();
    const response = await h.app.inject({ method: 'POST', url: `/api/executions/${h.state.record.execution.id}/resolve?businessId=${h.state.record.execution.businessId}`, payload: { action } });
    error(response, 400, 'VALIDATION_FAILED'); expect(h.state.lookups).toBe(0);
  });
  it('refuses a missing subject rather than authorizing an orphan execution', async () => {
    const h = await harness(); delete h.state.record.order;
    error(await h.request(), 404, 'NOT_FOUND'); expect(h.state.lookups).toBe(0);
  });
  it('rejects extra material rather than changing the approved payload', async () => {
    const h = await harness();
    const response = await h.app.inject({ method: 'POST', url: `/api/executions/${h.state.record.execution.id}/resolve?businessId=${h.state.record.execution.businessId}`, payload: { action: 'retry', idempotencyKey: 'replacement' } });
    error(response, 400, 'VALIDATION_FAILED'); expect(h.state.resolverCalls).toBe(0);
  });
  it('registers no extra recovery endpoints', async () => {
    const h = await harness();
    expect((await h.app.inject({ method: 'POST', url: '/api/orders/ord_test/recheck' })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'POST', url: '/api/messages/msg_test/resend' })).statusCode).toBe(404);
  });

  it('does not echo secrets or phone-like input from malformed and unsupported requests', async () => {
    const h = await harness();
    const secret = 'Bearer-credential-should-not-appear';
    const malformed = await h.app.inject({ method: 'POST', url: `/api/executions/${h.state.record.execution.id}/resolve?businessId=${h.state.record.execution.businessId}`,
      payload: { action: 'retry', secret, phone: '+15555550123' } });
    const unsupported = await h.app.inject({ method: 'PATCH', url: `/api/executions/${h.state.record.execution.id}/resolve?businessId=${h.state.record.execution.businessId}&secret=${secret}` });
    error(malformed, 400, 'VALIDATION_FAILED');
    for (const response of [malformed, unsupported]) {
      expect(response.body).not.toContain(secret);
      expect(response.body).not.toContain('+15555550123');
    }
  });

  it.each(['checkout', 'message'] as const)('fails closed for an unproven %s retry', async kind => {
    const h = await harness(kind); h.state.lookup = { outcome: 'unknown' };
    error(await h.request('retry'), 409, 'INVALID_STATE');
    expect(h.state.lookups).toBe(1);
    expect(h.state.resolverCalls).toBe(0);
    expect(h.state.events).toHaveLength(0);
  });

  it.each(['booking', 'message'] as const)('rejects retry after abandoned %s recovery', async kind => {
    const h = await harness(kind);
    expect((await h.request('abandon')).statusCode).toBe(200);
    error(await h.request('retry'), 409, 'INVALID_STATE');
    expect(h.state.resolverCalls).toBe(1);
  });

  it.each(['message'] as const)('rejects abandon after an unsupported %s retry', async kind => {
    const h = await harness(kind);
    error(await h.request('retry'), 409, 'INVALID_STATE');
    expect((await h.request('abandon')).statusCode).toBe(200);
    expect(h.state.resolverCalls).toBe(1);
  });
  it('rejects abandon after a requeued booking retry', async () => {
    const h = await harness('booking');
    expect((await h.request('retry')).statusCode).toBe(200);
    error(await h.request('abandon'), 409, 'INVALID_STATE');
    expect(h.state.resolverCalls).toBe(1);
  });
});
