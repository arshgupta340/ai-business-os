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
import { createRecoveryPlugin, type RecoveryLookup, type RecoveryPorts, type RecoveryRecord,
  type RecoveryScope, type RecoveryTransaction } from '../../../src/api/recovery/index';

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
    authorized: { ok: true } as Awaited<ReturnType<RecoveryPorts['authorizeRetry']>>,
    events: [] as ActivityEvent[], receipts: new Map<ResolveExecutionBody['action'], ActionExecution>(),
    lookups: 0, reconciles: 0, authorizations: 0, queued: 0, cancels: 0,
    reconciliation: undefined as Order | undefined,
    throwLookup: false, throwReconcile: false, throwActivity: false, mutateKey: false, omitExternalRef: false,
    keys: [] as string[], dispatchKeys: [] as string[], scopes: [] as RecoveryScope[],
    writes: { square: 0, messages: 0, calendar: 0, sheets: 0 },
  };
  const originalKey = execution.idempotencyKey;
  const originalDispatchKey = record.dispatch?.idempotencyKey;
  const tx: RecoveryTransaction = {
    async loadOrder() { return state.order; },
    async loadExecution() { return state.missing ? undefined : state.record; },
    async replay(action) { return state.receipts.has(action) ? state.record.execution : undefined; },
    async cancelOrder(order) {
      state.cancels++;
      state.order = { ...order, status: 'CANCELLED' };
      return state.order;
    },
    async resolve(input) {
      state.keys.push(input.record.execution.idempotencyKey);
      if (input.status === 'QUEUED') state.queued++;
      state.record.execution = {
        ...input.record.execution, status: input.status,
        ...(input.lookup.outcome === 'exists' ? { externalRef: state.omitExternalRef ? undefined : input.lookup.externalRef } : {}),
        ...(state.mutateKey ? { idempotencyKey: 'f'.repeat(64) } : {}),
      };
      state.receipts.set(input.action, state.record.execution);
      return state.record.execution;
    },
    async retryMessage(input) {
      state.dispatchKeys.push(input.dispatchKey);
      state.keys.push(input.idempotencyKey);
      state.queued++;
      state.record.execution = { ...input.record.execution, status: 'QUEUED' };
      state.receipts.set('retry', state.record.execution);
      return state.record.execution;
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
      const snapshot = structuredClone({ record: state.record, order: state.order, events: state.events, receipts: state.receipts, queued: state.queued, cancels: state.cancels });
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
    async authorizeRetry() { state.authorizations++; return state.authorized; },
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
  const h = { app, state, request, cancel, originalKey, originalDispatchKey };

  return h;
}

async function harness(kind: 'checkout' | 'booking' | 'message' = 'checkout') {
  const h = await buildHarness(kind);
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    // Every test asserts external writes, even errors and repeat calls. Recovery only queues.
    expect(h.state.writes).toEqual({ square: 0, messages: 0, calendar: 0, sheets: 0 });
    expect(h.state.record.execution.idempotencyKey).toBe(h.originalKey);
    expect(h.state.keys.every(key => key === h.originalKey)).toBe(true);
    expect(h.state.dispatchKeys.every(key => key === h.originalDispatchKey)).toBe(true);
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
  it.each(['checkout', 'booking', 'message'] as const)('retries %s with its original key after proven absence', async kind => {
    const h = await harness(kind);
    const response = await h.request(); expect(response.statusCode).toBe(200);
    expect(ResolveExecutionResponseSchema.parse(response.json()).execution.status).toBe('QUEUED');
    expect(h.state.lookups).toBe(1); expect(h.state.queued).toBe(1); expect(h.state.authorizations).toBe(1); expect(h.state.events).toHaveLength(1);
    if (kind === 'message') expect(h.state.dispatchKeys).toEqual([h.originalKey]);
  });
  it.each(['checkout', 'booking', 'message'].flatMap(kind => ['retry', 'abandon'].map(action => ({ kind, action }))) as { kind: 'checkout' | 'booking' | 'message'; action: ResolveExecutionBody['action'] }[])('lookup finding an object resolves $kind for $action without a write', async ({ kind, action }) => {
    const h = await harness(kind); h.state.lookup = { outcome: 'exists', externalRef: 'verified_provider_object' };
    const response = await h.request(action); expect(response.statusCode).toBe(200);
    expect(response.json().execution).toMatchObject({ status: 'SUCCEEDED', externalRef: 'verified_provider_object', idempotencyKey: h.originalKey });
    expect(h.state.queued).toBe(0); expect(h.state.authorizations).toBe(0); expect(h.state.events).toHaveLength(1);
    expect((await h.request(action)).statusCode).toBe(200); expect(h.state.lookups).toBe(1); expect(h.state.events).toHaveLength(1);
  });
  it('abandons only after lookup proves absence', async () => {
    const h = await harness(); const response = await h.request('abandon');
    expect(response.statusCode).toBe(200); expect(response.json().execution.status).toBe('FAILED');
    expect(h.state.lookups).toBe(1); expect(h.state.authorizations).toBe(0); expect(h.state.queued).toBe(0); expect(h.state.events).toHaveLength(1);
  });
  it.each(['retry', 'abandon'] as const)('leaves an unknown provider outcome stuck for %s', async action => {
    const h = await harness(); h.state.lookup = { outcome: 'unknown' };
    error(await h.request(action), 409, 'INVALID_STATE'); expect(h.state.record.execution.status).toBe('NEEDS_REVIEW');
    expect(h.state.queued).toBe(0); expect(h.state.events).toHaveLength(0);
  });
  it.each(['checkout', 'booking', 'message'] as const)('durably replays %s concurrent retries after worker progress', async kind => {
    const h = await harness(kind);
    const responses = await Promise.all([h.request(), h.request()]);
    expect(responses.map(r => r.statusCode)).toEqual([200, 200]);
    h.state.record.execution.status = 'SUCCEEDED'; h.state.record.execution.attempts++;
    expect((await h.request()).json().execution.status).toBe('SUCCEEDED');
    expect(h.state.lookups).toBe(1); expect(h.state.queued).toBe(1); expect(h.state.events).toHaveLength(1);
  });
  it('replays abandon without another event or lookup', async () => {
    const h = await harness(); await h.request('abandon'); await h.request('abandon');
    expect(h.state.lookups).toBe(1); expect(h.state.events).toHaveLength(1); expect(h.state.queued).toBe(0);
  });
  it('rejects a different recovery decision after abandon', async () => {
    const h = await harness(); await h.request('abandon');
    error(await h.request('retry'), 409, 'INVALID_STATE'); expect(h.state.queued).toBe(0);
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
    error(await h.request(), 409, 'INVALID_STATE'); expect(h.state.lookups).toBe(0); expect(h.state.queued).toBe(0);
  });
  it.each(['booking', 'message'] as const)('supports a definitely failed %s retry below the attempt limit', async kind => {
    const h = await harness(kind); h.state.record.execution.status = 'FAILED';
    if (h.state.record.dispatch) h.state.record.dispatch.status = 'FAILED';
    expect((await h.request()).statusCode).toBe(200); expect(h.state.queued).toBe(1); expect(h.state.lookups).toBe(1);
  });
  it('refuses contradictory absence for an already delivered message', async () => {
    const h = await harness('message'); h.state.record.dispatch!.status = 'DELIVERED';
    error(await h.request(), 409, 'INVALID_STATE'); expect(h.state.queued).toBe(0);
  });
  it('does not resend a delivered message found by lookup', async () => {
    const h = await harness('message'); h.state.record.dispatch!.status = 'DELIVERED';
    h.state.lookup = { outcome: 'exists', externalRef: h.state.record.dispatch!.providerMessageId! };
    expect((await h.request()).statusCode).toBe(200); expect(h.state.queued).toBe(0); expect(h.state.dispatchKeys).toHaveLength(0);
  });
  it.each(['missing', 'wrong business', 'wrong approval', 'wrong subject'] as const)('hides %s execution', async scenario => {
    const h = await harness();
    if (scenario === 'missing') h.state.missing = true;
    else if (scenario === 'wrong business') h.state.record.execution.businessId = 'biz_other';
    else if (scenario === 'wrong approval') h.state.record.execution.approvalId = 'apv_other';
    else h.state.record.order!.id = 'ord_other';
    error(await h.request(), 404, 'NOT_FOUND'); expect(h.state.lookups).toBe(0);
  });
  it('rejects an expired approval without creating a replacement', async () => {
    const h = await harness(); h.state.record.approval.state = 'EXPIRED'; delete h.state.record.approval.decidedBy;
    error(await h.request(), 409, 'APPROVAL_EXPIRED'); expect(h.state.queued).toBe(0); expect(h.state.events).toHaveLength(0);
  });
  it('rejects approved material after expiry on retry', async () => {
    const h = await harness();
    h.state.now = new Date(h.state.record.approval.expiresAt);
    error(await h.request(), 409, 'APPROVAL_EXPIRED'); expect(h.state.queued).toBe(0);
  });
  it('rejects a pending approval', async () => {
    const h = await harness(); h.state.record.approval.state = 'PENDING';
    delete h.state.record.approval.decidedAt; delete h.state.record.approval.decidedBy;
    error(await h.request(), 409, 'INVALID_STATE'); expect(h.state.queued).toBe(0);
  });
  it('rejects altered approval hashes', async () => {
    const h = await harness(); h.state.record.approval.payloadHash = `sha256:${'f'.repeat(64)}`;
    error(await h.request(), 409, 'PAYLOAD_HASH_MISMATCH'); expect(h.state.queued).toBe(0);
  });
  it('honors current-material policy refusal', async () => {
    const h = await harness(); h.state.authorized = { ok: false, code: 'PAYLOAD_HASH_MISMATCH' };
    error(await h.request(), 409, 'PAYLOAD_HASH_MISMATCH'); expect(h.state.queued).toBe(0);
  });
  it('cannot reset exhausted attempts', async () => {
    const h = await harness(); h.state.record.execution.attempts = 3;
    error(await h.request(), 409, 'INVALID_STATE'); expect(h.state.record.execution.attempts).toBe(3); expect(h.state.queued).toBe(0);
  });
  it('can reconcile an exhausted or expired step that already exists', async () => {
    const h = await harness(); h.state.record.execution.attempts = 3; h.state.record.approval.state = 'EXPIRED'; delete h.state.record.approval.decidedBy;
    h.state.lookup = { outcome: 'exists', externalRef: 'provider_verified' };
    expect((await h.request()).statusCode).toBe(200); expect(h.state.queued).toBe(0);
  });
  it('sanitizes a lookup failure and preserves review state', async () => {
    const h = await harness(); h.state.throwLookup = true;
    const response = await h.request(); error(response, 500, 'INTERNAL'); expect(response.body).not.toContain('secret');
    expect(h.state.record.execution.status).toBe('NEEDS_REVIEW'); expect(h.state.queued).toBe(0);
  });
  it('rolls back a retry when the event cannot be persisted', async () => {
    const h = await harness(); h.state.throwActivity = true;
    error(await h.request(), 500, 'INTERNAL'); expect(h.state.record.execution.status).toBe('NEEDS_REVIEW');
    expect(h.state.queued).toBe(0); expect(h.state.receipts.size).toBe(0);
  });
  it('requires the verified provider reference to be saved with success', async () => {
    const h = await harness(); h.state.lookup = { outcome: 'exists', externalRef: 'verified_reference' }; h.state.omitExternalRef = true;
    error(await h.request(), 500, 'INTERNAL'); expect(h.state.record.execution.status).toBe('NEEDS_REVIEW');
  });
  it('rejects a port attempting to replace the existing key', async () => {
    const h = await harness(); h.state.mutateKey = true;
    error(await h.request(), 500, 'INTERNAL'); expect(h.state.queued).toBe(0);
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
    error(response, 400, 'VALIDATION_FAILED'); expect(h.state.queued).toBe(0);
  });
  it('registers no extra recovery endpoints', async () => {
    const h = await harness();
    expect((await h.app.inject({ method: 'POST', url: '/api/orders/ord_test/recheck' })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'POST', url: '/api/messages/msg_test/resend' })).statusCode).toBe(404);
  });
});
