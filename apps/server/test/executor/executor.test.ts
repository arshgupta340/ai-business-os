import { describe, expect, it, vi } from 'vitest';
import { ActivityEventSchema, type BookingApprovalPayload, type OrderApprovalPayload } from '@abos/contracts';
import { approvalFactEditPending, approvalPriceEditPending } from '@abos/contracts/fixtures';
import { classifyFailure, createExecutor } from '../../src/executor/index.js';
import { SlotConflictError, TotalMismatchError } from '../../src/executor/types.js';
import { harness } from './fakes.js';

async function ticks(executor: ReturnType<typeof createExecutor>, count = 3) {
  for (let n = 0; n < count; n++) await executor.tick();
}

describe('executor', () => {
  it('runs the three order steps once in order, even after twenty extra ticks (AC-09, AC-10)', async () => {
    const h = harness(); const e = createExecutor(h.deps);
    await ticks(e); await ticks(e, 20);
    expect(h.rows.map((r) => r.status)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED']);
    expect(h.deps.checkout.createCheckout).toHaveBeenCalledTimes(1);
    expect(h.deps.messages.sendOnce).toHaveBeenCalledTimes(1);
    expect(h.deps.checkout.createCheckout).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: h.rows[0]?.idempotencyKey }));
    expect(h.deps.messages.sendOnce).toHaveBeenCalledWith(expect.objectContaining({ to: (h.material as OrderApprovalPayload).messageRecipient, dispatchKey: h.rows[1]?.idempotencyKey }));
    expect(h.order.status).toBe('PAYMENT_PENDING');
    expect(h.order.squareOrderId).toBe('sq_order');
    expect(h.events.filter((e) => e.type === 'execution.started')).toHaveLength(3);
    expect(h.events.filter((e) => e.type === 'execution.succeeded')).toHaveLength(3);
    for (const event of h.events) expect(ActivityEventSchema.safeParse(event).success).toBe(true);
    expect(JSON.stringify(h.events)).not.toContain('+1555');
    expect(JSON.stringify(h.events)).not.toContain('https://');
  });
  it('refuses authorization without calling adapters or changing subjects', async () => {
    const h = harness(); vi.mocked(h.deps.policy.authorizeStep).mockResolvedValue({ ok: false, code: 'PAYLOAD_HASH_MISMATCH' });
    await ticks(createExecutor(h.deps), 5);
    expect(h.rows[0]?.errorCode).toBe('PAYLOAD_HASH_MISMATCH');
    expect(h.deps.checkout.createCheckout).not.toHaveBeenCalled();
    expect(h.deps.messages.sendOnce).not.toHaveBeenCalled();
    expect(h.deps.subjects.moveOrder).not.toHaveBeenCalled();
  });
  it('stops on total mismatch, with recovery required and no message', async () => {
    const h = harness(); vi.mocked(h.deps.checkout.createCheckout).mockRejectedValue(new TotalMismatchError());
    await ticks(createExecutor(h.deps), 5);
    expect(h.order.status).toBe('RECOVERY_REQUIRED'); expect(h.rows[0]?.status).toBe('FAILED');
    expect(h.deps.messages.sendOnce).not.toHaveBeenCalled();
  });
  it.each(['UNKNOWN', 'FAILED'] as const)('continues after a %s message without resending', async (status) => {
    const h = harness(); vi.mocked(h.deps.messages.sendOnce).mockResolvedValue({ status });
    await ticks(createExecutor(h.deps), 23);
    expect(h.rows[1]?.status).toBe(status === 'UNKNOWN' ? 'NEEDS_REVIEW' : 'FAILED');
    expect(h.order.status).toBe('PAYMENT_PENDING'); expect(h.deps.messages.sendOnce).toHaveBeenCalledTimes(1);
  });
  it('does not send qr_only, including a step already skipped by the queue', async () => {
    const h = harness(); h.setMaterial({ ...h.material, messageChannel: 'qr_only', messageRecipient: undefined, messageConsent: false } as OrderApprovalPayload);
    h.rows[1]!.status = 'SKIPPED';
    await ticks(createExecutor(h.deps), 5);
    expect(h.deps.messages.sendOnce).not.toHaveBeenCalled(); expect(h.order.status).toBe('PAYMENT_PENDING');
  });
  it('a claimed qr_only message sends nothing and is never finished SKIPPED by a worker', async () => {
    const h = harness(); h.setMaterial({ ...h.material, messageChannel: 'qr_only', messageRecipient: undefined, messageConsent: false } as OrderApprovalPayload);
    await ticks(createExecutor(h.deps));
    expect(h.rows[1]?.status).toBe('FAILED');
    expect(h.history.every((o) => (o.status as string) !== 'SKIPPED')).toBe(true); expect(h.deps.messages.sendOnce).not.toHaveBeenCalled();
    expect(h.order.status).toBe('PAYMENT_PENDING');
  });
  it('requeues with growing delays, caps attempts at three, and preserves the stored key', async () => {
    const h = harness(); vi.mocked(h.deps.checkout.createCheckout).mockRejectedValue({ code: 'RATE_LIMITED', retryable: true, requestSent: false });
    const e = createExecutor(h.deps); await e.tick();
    expect(h.rows[0]?.status).toBe('QUEUED'); const first = h.history[0]?.delayMs ?? 0;
    await e.tick(); expect(h.deps.checkout.createCheckout).toHaveBeenCalledTimes(1);
    h.advance(first); await e.tick(); const second = h.history[1]?.delayMs ?? 0;
    expect(second).toBeGreaterThan(first); h.advance(second); await ticks(e, 20);
    expect(h.rows[0]?.attempts).toBe(3); expect(h.rows[0]?.status).toBe('FAILED');
    expect(h.deps.checkout.createCheckout).toHaveBeenCalledTimes(3);
    for (const [input] of vi.mocked(h.deps.checkout.createCheckout).mock.calls) expect(input.idempotencyKey).toBe(h.rows[0]?.idempotencyKey);
  });
  it('does not retry an ambiguous timeout even when it claims to be retryable', async () => {
    const h = harness(); vi.mocked(h.deps.checkout.createCheckout).mockRejectedValue({ code: 'INTEGRATION_UNAVAILABLE', retryable: true, ambiguous: true });
    await ticks(createExecutor(h.deps), 20);
    expect(h.rows[0]?.status).toBe('NEEDS_REVIEW'); expect(h.deps.checkout.createCheckout).toHaveBeenCalledTimes(1);
  });
  it('an arbitrary provider throw leaves NEEDS_REVIEW, never RUNNING', async () => {
    const h = harness(); vi.mocked(h.deps.checkout.createCheckout).mockRejectedValue(new Error('sensitive provider text'));
    await ticks(createExecutor(h.deps)); expect(h.rows[0]?.status).toBe('NEEDS_REVIEW');
    expect(JSON.stringify(h.events)).not.toContain('sensitive');
  });
  it('a pre-request handler throw leaves FAILED, never RUNNING', async () => {
    const h = harness(); vi.mocked(h.deps.subjects.loadOrder).mockRejectedValue(new Error('load failed'));
    await ticks(createExecutor(h.deps)); expect(h.rows[0]?.status).toBe('FAILED');
    expect(h.deps.checkout.createCheckout).not.toHaveBeenCalled();
  });
  it('marks persistence after provider success for review without a blind replay', async () => {
    const h = harness(); vi.mocked(h.deps.subjects.completeCheckout).mockRejectedValue(new Error('database unavailable'));
    await ticks(createExecutor(h.deps), 10);
    expect(h.rows[0]?.status).toBe('NEEDS_REVIEW'); expect(h.order.checkoutUrl).toBeUndefined();
    expect(h.deps.checkout.createCheckout).toHaveBeenCalledTimes(1);
  });
  it('booking conflict stops the bundle, preserves alternatives, and sends no confirmation', async () => {
    const h = harness('booking_bundle'); const p = h.material as BookingApprovalPayload;
    const alternatives = [{ serviceId: p.serviceId, startUtc: p.startUtc, endUtc: p.endUtc, timezone: p.timezone }];
    vi.mocked(h.deps.calendar.createEvent).mockRejectedValue(new SlotConflictError(alternatives));
    await ticks(createExecutor(h.deps), 20);
    expect(h.booking.status).toBe('SLOT_CONFLICT'); expect(h.rows[0]?.status).toBe('FAILED');
    expect(h.deps.subjects.moveBooking).toHaveBeenCalledWith(p.businessId, p.subjectId, 'SLOT_CONFLICT', alternatives);
    expect(h.deps.messages.sendOnce).not.toHaveBeenCalled();
  });
  it('books only after the saved event, even with an unknown confirmation', async () => {
    const h = harness('booking_bundle'); vi.mocked(h.deps.messages.sendOnce).mockResolvedValue({ status: 'UNKNOWN' });
    await ticks(createExecutor(h.deps), 20);
    expect(h.booking.googleEventId).toBe('google_event'); expect(h.booking.status).toBe('BOOKED_VERIFIED');
    expect(h.deps.calendar.createEvent).toHaveBeenCalledTimes(1); expect(h.deps.messages.sendOnce).toHaveBeenCalledTimes(1);
  });
  it('refuses local booking completion without a persisted event id', async () => {
    const h = harness('booking_bundle'); h.rows[0]!.status = 'SUCCEEDED'; h.rows[1]!.status = 'SKIPPED';
    await ticks(createExecutor(h.deps)); expect(h.rows[2]?.status).toBe('FAILED');
    expect(h.booking.status).toBe('RECHECKING_SLOT');
  });
  it('two concurrent executors claim a step only once', async () => {
    const h = harness(); const a = createExecutor(h.deps); const b = createExecutor({ ...h.deps, workerId: 'worker-b' });
    await Promise.all([a.tick(), b.tick()]);
    expect(h.deps.checkout.createCheckout).toHaveBeenCalledTimes(1);
    expect(h.rows.filter((r) => r.status === 'RUNNING')).toHaveLength(0);
  });
  it('reauthorizes immediately before the external call', async () => {
    const h = harness(); const original = vi.mocked(h.deps.policy.authorizeStep).getMockImplementation()!;
    vi.mocked(h.deps.policy.authorizeStep).mockImplementationOnce(original)
      .mockResolvedValueOnce({ ok: false, code: 'APPROVAL_EXPIRED' });
    await createExecutor(h.deps).tick();
    expect(h.deps.policy.authorizeStep).toHaveBeenCalledTimes(2);
    expect(h.deps.checkout.createCheckout).not.toHaveBeenCalled();
    expect(h.rows[0]?.status).toBe('FAILED'); expect(h.rows[0]?.errorCode).toBe('APPROVAL_EXPIRED');
  });
  it('does not retry mutated subject material or send to a mutable contact', async () => {
    const h = harness(); h.order.cart.lines[0]!.quantity++;
    await ticks(createExecutor(h.deps), 10);
    expect(h.rows[0]?.status).toBe('FAILED'); expect(h.rows[0]?.attempts).toBe(1);
    expect(h.deps.checkout.createCheckout).not.toHaveBeenCalled();
  });
  it('uses only the approved recipient even if the current contact changes', async () => {
    const h = harness(); h.order.contact.messageRecipient = '+15555559999';
    await ticks(createExecutor(h.deps));
    expect(h.deps.messages.sendOnce).toHaveBeenCalledWith(expect.objectContaining({ to: (h.material as OrderApprovalPayload).messageRecipient }));
  });
  it('keeps a typed but uncertain provider error in review', async () => {
    const h = harness(); vi.mocked(h.deps.checkout.createCheckout).mockRejectedValue({ code: 'INTERNAL' });
    await createExecutor(h.deps).tick(); expect(h.rows[0]?.status).toBe('NEEDS_REVIEW');
  });
  it('does not continue a message refused by policy', async () => {
    const h = harness(); const e = createExecutor(h.deps); await e.tick();
    vi.mocked(h.deps.policy.authorizeStep).mockResolvedValue({ ok: false, code: 'CAPABILITY_NOT_ALLOWED' });
    await ticks(e, 10); expect(h.order.status).toBe('PAYMENT_LINK_READY');
    expect(h.rows[2]?.status).toBe('QUEUED'); expect(h.deps.messages.sendOnce).not.toHaveBeenCalled();
  });
  it('a timeout during message send continues recording without a second send', async () => {
    const h = harness(); vi.mocked(h.deps.messages.sendOnce).mockRejectedValue(new Error('Request timed out'));
    await ticks(createExecutor(h.deps), 10); expect(h.rows[1]?.status).toBe('NEEDS_REVIEW');
    expect(h.order.status).toBe('PAYMENT_PENDING'); expect(h.deps.messages.sendOnce).toHaveBeenCalledTimes(1);
  });
  it('leaves terminal calendar failures in RETRY_REQUIRED', async () => {
    const h = harness('booking_bundle'); vi.mocked(h.deps.calendar.createEvent).mockRejectedValue({ code: 'INTEGRATION_UNAVAILABLE', requestSent: false, retryable: false });
    await ticks(createExecutor(h.deps), 10); expect(h.rows[0]?.status).toBe('FAILED');
    expect(h.booking.status).toBe('RETRY_REQUIRED'); expect(h.deps.messages.sendOnce).not.toHaveBeenCalled();
  });
  it('local fact edits run through the injected subject port', async () => {
    const h = harness(); const row = h.rows[0]!;
    h.rows.splice(1); row.actionType = 'local.fact.update'; row.capabilityId = undefined;
    h.setMaterial(approvalFactEditPending.payload);
    await createExecutor(h.deps).tick(); expect(row.status).toBe('SUCCEEDED');
    expect(h.deps.subjects.updateFact).toHaveBeenCalledWith(row.businessId, approvalFactEditPending.payload);
    expect(h.deps.checkout.createCheckout).not.toHaveBeenCalled();
  });
  it.each(['square.catalog.price.update', 'local.catalog.sync'] as const)('clearly fails unimplemented %s', async (actionType) => {
    const h = harness(); const row = h.rows[0]!;
    h.rows.splice(1); row.actionType = actionType; row.stepIndex = actionType === 'local.catalog.sync' ? 1 : 0;
    row.capabilityId = actionType === 'local.catalog.sync' ? undefined : 'catalog.price.update';
    h.setMaterial(approvalPriceEditPending.payload);
    await createExecutor(h.deps).tick(); expect(row.status).toBe('FAILED');
    expect(h.history[0]?.reason).toContain('not implemented');
    expect(h.deps.checkout.createCheckout).not.toHaveBeenCalled();
  });
  it('classifies definite permanent refusals and explicit safe retries', () => {
    expect(classifyFailure({ code: 'VALIDATION_FAILED', requestSent: false, retryable: false }, 1, true).status).toBe('FAILED');
    expect(classifyFailure({ code: 'INTEGRATION_UNAVAILABLE', requestSent: false }, 1, true).status).toBe('QUEUED');
    expect(classifyFailure({ code: 'RATE_LIMITED', retryable: true, ambiguous: false }, 1, true).status).toBe('QUEUED');
  });
});
