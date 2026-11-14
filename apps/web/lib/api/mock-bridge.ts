/**
 * The only link between lib/api and apps/web/mocks. It holds no mock code,
 * so importing it never pulls MSW or fixtures into the production bundle.
 *
 * - The mock db publishes ActivityEvents here; useActivityFeed subscribes in mock mode.
 * - The mock layer registers its controls here when the worker starts;
 *   useMockControls() reads them and returns null outside mock mode.
 */
import { useSyncExternalStore } from "react";
import type { ActivityEvent } from "./pending-contracts";
import { isMockMode } from "./config";

type Listener = (event: ActivityEvent) => void;
const activityListeners = new Set<Listener>();

export function publishMockActivity(event: ActivityEvent): void {
  for (const listener of activityListeners) listener(event);
}

/** Subscribe to mock ActivityEvents for one business. Returns the unsubscribe function. */
export function subscribeMockActivity(businessId: string, listener: Listener): () => void {
  const wrapped: Listener = (event) => {
    if (event.businessId === businessId) listener(event);
  };
  activityListeners.add(wrapped);
  return () => {
    activityListeners.delete(wrapped);
  };
}

/** What a "Mock controls" panel can trigger. Every action changes only the in-memory mock db. */
export interface MockControls {
  /** Start a scripted incoming pizza call (Flow B). Resolves with its call, order and approval IDs once the approval is pending. */
  startPizzaCall(): Promise<{ callId: string; orderId: string; approvalId: string }>;
  /** Start a scripted barbershop booking call (Flow C). Pass slotConflict to end in SLOT_CONFLICT after approval. */
  startBookingCall(options?: { slotConflict?: boolean }): Promise<{ callId: string; bookingId: string; approvalId: string }>;
  /** Fail the payment of the newest PAYMENT_PENDING pizza order, or the next one to reach PAYMENT_PENDING. */
  simulatePaymentFailed(): void;
  /** Make the next Sheets sync fail once (RETRYING) before it succeeds. */
  simulateSyncRetry(): void;
  /** Drop the scripted call in progress before a proposal, or start one that drops (AC-18). */
  simulateCallLost(): Promise<{ callId: string }>;
  /** Emit a webhook.rejected event for the pizza business. */
  simulateRejectedWebhook(): void;
  /** Change the stored payload of a pending approval so the hash the UI shows no longer matches. */
  simulatePayloadChanged(approvalId: string): void;
  /** Leave the phone number unanswered: GET /api/live-agent then has no agentId or agentVersionId. */
  simulateNoLiveAgent(): void;
  /** Put every fixture back and cancel scripted timers. */
  reset(): void;
}

let controls: MockControls | null = null;
const controlListeners = new Set<() => void>();

export function registerMockControls(next: MockControls | null): void {
  controls = next;
  for (const listener of controlListeners) listener();
}

export function getMockControls(): MockControls | null {
  return isMockMode() ? controls : null;
}

/** Returns the mock controls in mock mode, otherwise null. Show them in a panel labelled "Mock controls". */
export function useMockControls(): MockControls | null {
  const value = useSyncExternalStore(
    (onChange) => {
      controlListeners.add(onChange);
      return () => controlListeners.delete(onChange);
    },
    () => controls,
    () => null,
  );
  return isMockMode() ? value : null;
}
