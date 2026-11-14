// D-13 demo tracker stage. Computed from stored times, never stored itself.
import type { OrderStatus } from '@abos/contracts';

export type DemoStage = 'awaiting_payment' | 'reviewing' | 'not_taken' | 'placed' | 'making' | 'ready';

/** Order statuses after which the shop will not make the order. */
const NOT_TAKEN: readonly OrderStatus[] = ['REJECTED', 'APPROVAL_EXPIRED', 'CANCELLED', 'UNAVAILABLE', 'PAYMENT_FAILED', 'RECOVERY_REQUIRED'];

export function isNotTaken(status: string): boolean {
  return (NOT_TAKEN as readonly string[]).includes(status);
}

/**
 * When the tracker shows "Ready for pickup": the pickup time, or `readyAfterMs` after the confirmation
 * when the pickup time is further than `pickupFarMs` from the confirmation, so a demo can show it.
 */
export function readyAtMs(input: { confirmedAtMs: number; pickupAtMs: number; readyAfterMs: number; pickupFarMs: number }): number {
  return input.pickupAtMs - input.confirmedAtMs > input.pickupFarMs ? input.confirmedAtMs + input.readyAfterMs : input.pickupAtMs;
}

export function demoStage(input: {
  orderStatus: string;
  demoPaidAtMs: number | undefined;
  confirmedAtMs: number | undefined;
  pickupAtMs: number;
  nowMs: number;
  makingAfterMs: number;
  readyAfterMs: number;
  pickupFarMs: number;
}): DemoStage {
  if (input.confirmedAtMs !== undefined) {
    const ready = readyAtMs({ confirmedAtMs: input.confirmedAtMs, pickupAtMs: input.pickupAtMs, readyAfterMs: input.readyAfterMs, pickupFarMs: input.pickupFarMs });
    if (input.nowMs >= ready) return 'ready';
    if (input.nowMs >= input.confirmedAtMs + input.makingAfterMs) return 'making';
    return 'placed';
  }
  if (isNotTaken(input.orderStatus)) return 'not_taken';
  return input.demoPaidAtMs !== undefined ? 'reviewing' : 'awaiting_payment';
}
