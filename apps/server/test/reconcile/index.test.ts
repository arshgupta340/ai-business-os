import { expect, it, vi } from 'vitest';
import { pollPendingPayments } from '../../src/reconcile/index.js';
import { fixture } from '../webhooks/fakes.js';

it.each([15 * 60_000, 16 * 60_000])('stops polling at %i ms after the link became ready', async age => {
  const f = fixture(); f.deps.clock.now = () => new Date(Date.parse(f.order.linkReadyAt) + age);
  await pollPendingPayments(f.deps); expect(f.deps.square.findPaymentsForOrder).not.toHaveBeenCalled(); expect(f.order.status).toBe('PAYMENT_PENDING');
});
it('polls recent pending payments through the shared verifier', async () => {
  const f = fixture(); await pollPendingPayments(f.deps); expect(f.order.status).toBe('FULFILLMENT_READY'); expect(f.sync.queueOrder).toHaveBeenCalledTimes(1);
});
it('leaves an abandoned checkout unpaid when no payment exists', async () => {
  const f = fixture(); vi.mocked(f.deps.square.findPaymentsForOrder).mockResolvedValue([]); await pollPendingPayments(f.deps); expect(f.order.status).toBe('PAYMENT_PENDING'); expect(f.events).toHaveLength(0);
});
it.each(['PAID_VERIFIED', 'FULFILLMENT_READY', 'CANCELLED', 'RECOVERY_REQUIRED', 'MESSAGE_SENT'] as const)('does not poll an order in %s', async status => {
  const f = fixture(); f.order.status = status; await pollPendingPayments(f.deps); expect(f.deps.square.findPaymentsForOrder).not.toHaveBeenCalled();
});
it.each(['not-a-date', '2026-11-13T21:00:00Z'])('does not poll an invalid or future link-ready timestamp %s', async timestamp => {
  const f = fixture(); f.order.linkReadyAt = timestamp; await pollPendingPayments(f.deps); expect(f.deps.square.findPaymentsForOrder).not.toHaveBeenCalled();
});
it('continues polling other orders when one lookup fails, then reports the retry', async () => {
  const f = fixture(); vi.mocked(f.deps.orders.listWaitingForPayment).mockResolvedValue([{ ...f.order, id: 'ord_other', squareOrderId: 'sq_other' }, { ...f.order }]);
  vi.mocked(f.deps.square.findPaymentsForOrder).mockRejectedValueOnce(new Error('Temporary failure')).mockResolvedValue(['sq_payment']);
  await expect(pollPendingPayments(f.deps)).rejects.toThrow('Payment reconciliation requires retry');
  expect(f.order.status).toBe('FULFILLMENT_READY');
});
