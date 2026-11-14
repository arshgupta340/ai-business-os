import { vi } from 'vitest';
import { ACTION_TYPE_CAPABILITY, EXECUTION_MAX_ATTEMPTS, executionStepsFor, type ActionExecution, type ActivityEvent, type ApprovalPayload, type Order, type Booking } from '@abos/contracts';
import { approvalOrderPaymentPending, approvalBookingVerified, orderPaymentPending, bookingVerified, storedKey } from '@abos/contracts/fixtures';
import type { Authorization, ExecutorDeps, MessageResult, StepOutcome } from '../../src/executor/types.js';

export function harness(kind: 'order_bundle' | 'booking_bundle' = 'order_bundle') {
  const approval = kind === 'order_bundle' ? approvalOrderPaymentPending : approvalBookingVerified;
  let material: ApprovalPayload = structuredClone(approval.payload);
  let now = Date.parse(approval.createdAt);
  let order: Order = { ...structuredClone(orderPaymentPending), status: 'APPROVED', checkoutUrl: undefined, squareOrderId: undefined, squarePaymentLinkId: undefined };
  let booking: Booking = { ...structuredClone(bookingVerified), status: 'RECHECKING_SLOT', googleEventId: undefined };
  const rows: ActionExecution[] = executionStepsFor(kind).map(({ actionType, stepIndex }) => ({
    id: `exe_test_${stepIndex}`, businessId: approval.businessId, approvalId: approval.id,
    actionType, stepIndex, idempotencyKey: storedKey(`idem:exe_test_${stepIndex}`),
    status: 'QUEUED', attempts: 0, createdAt: approval.createdAt, updatedAt: approval.createdAt,
    ...(ACTION_TYPE_CAPABILITY[actionType] === null ? {} : { capabilityId: ACTION_TYPE_CAPABILITY[actionType] }),
  }));
  const leases = new Map<string, string>();
  const due = new Map<string, number>();
  const outcomes = new Map<string, StepOutcome>();
  const history: StepOutcome[] = [];
  const events: ActivityEvent[] = [];
  let id = 0;
  const deps: ExecutorDeps = {
    workerId: 'worker-a',
    queue: {
      claimNext: vi.fn(async (workerId) => {
        const row = rows.find((row, index) => row.status === 'QUEUED'
          && row.attempts < EXECUTION_MAX_ATTEMPTS && (due.get(row.id) ?? 0) <= now
          && rows.slice(0, index).every((prev) => prev.status === 'SUCCEEDED' || prev.status === 'SKIPPED'
            || ((prev.status === 'FAILED' || prev.status === 'NEEDS_REVIEW') && outcomes.get(prev.id)?.continueBundle === true)));
        if (!row) return undefined;
        row.status = 'RUNNING'; row.attempts++;
        leases.set(row.id, workerId);
        return { ...row };
      }),
      finish: vi.fn(async (executionId, workerId, outcome) => {
        const row = rows.find((r) => r.id === executionId);
        if (!row || row.status !== 'RUNNING' || leases.get(executionId) !== workerId) throw new Error('Lease lost');
        const previousOrder = structuredClone(order);
        const previousBooking = structuredClone(booking);
        try { await outcome.apply?.(deps.subjects); }
        catch (error) { order = previousOrder; booking = previousBooking; throw error; }
        row.status = outcome.status;
        row.errorCode = outcome.errorCode;
        row.externalRef = outcome.externalRef;
        due.set(row.id, now + (outcome.delayMs ?? 0));
        history.push(outcome); outcomes.set(row.id, outcome); leases.delete(row.id);
      }),
    },
    policy: { authorizeStep: vi.fn(async ({ executionId }: { executionId: string; businessId: string }): Promise<Authorization> => {
      const row = rows.find((r) => r.id === executionId);
      if (!row) return { ok: false, code: 'NOT_FOUND' };
      return { ok: true, execution: { ...row }, material };
    }) },
    subjects: {
      loadOrder: vi.fn(async () => structuredClone(order)),
      loadBooking: vi.fn(async () => structuredClone(booking)),
      saveCheckout: vi.fn(async (_biz, _id, refs) => { order.squareOrderId = refs.squareOrderId; order.squarePaymentLinkId = refs.paymentLinkId; order.checkoutUrl = refs.url; }),
      saveEvent: vi.fn(async (_biz, _id, eventId) => { booking.googleEventId = eventId; }),
      moveOrder: vi.fn(async (_biz, _id, status) => { order.status = status; }),
      moveBooking: vi.fn(async (_biz, _id, status) => { booking.status = status; }),
      updateFact: vi.fn(async () => {}),
    },
    checkout: { createCheckout: vi.fn(async () => ({ squareOrderId: 'sq_order', paymentLinkId: 'sq_link', url: 'https://example.test/pay' })) },
    messages: { sendOnce: vi.fn(async (): Promise<MessageResult> => 'SENT') },
    calendar: { createEvent: vi.fn(async () => ({ id: 'google_event' })) },
    templates: { checkout: vi.fn(({ url }) => `Sandbox test payment.\n${url}`), booking: vi.fn(() => 'Your appointment is confirmed.') },
    activity: { write: vi.fn(async (event) => { events.push(event); }) },
    clock: { now: () => new Date(now) }, ids: { next: () => `evt_test_${++id}` },
  };
  return { deps, rows, history, events, get order() { return order; }, get booking() { return booking; },
    setMaterial(value: ApprovalPayload) { material = value; }, get material() { return material; },
    advance(ms: number) { now += ms; } };
}
