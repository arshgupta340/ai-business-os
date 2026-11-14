/**
 * Scripted timelines (FLOWS.md Flow B and Flow C) and the mock controls.
 *
 * startPizzaCall(): call.started, the stage changes, proposal.created,
 * approval.requested, a pending approval and order in the mock db, then
 * call.ended. It then waits. When the owner approves through
 * POST /api/approvals/:id/decision, the mock db runs the order bundle:
 * approval.decided, execution.started, checkout.created, execution.succeeded,
 * message.sent, order.status_changed steps, then payment.verified after a few
 * seconds, then sync.queued and sync.succeeded. Reject and expiry end it.
 *
 * Screens import useMockControls from "@/lib/api", not from this file.
 */
import type { MockControls } from "@/lib/api/mock-bridge";
import { publishMockReset, useMockControls as useMockControlsFromBridge } from "@/lib/api/mock-bridge";
import type { Call, CallStage } from "@abos/contracts";
import * as db from "./db";
import { BARBER_BUSINESS_ID as BARBER, PIZZA_BUSINESS_ID as PIZZA } from "@abos/contracts";
import { barberAgent, barberVersionV1, bookingVerified, orderFulfilled, pizzaAgent, pizzaVersionV2 } from "@abos/contracts/fixtures";
import { cancel, schedule, timing } from "./scheduler";

/** The scripted call that has not reached its proposal yet, if any. */
let inFlight: { call: Call; timers: ReturnType<typeof setTimeout>[]; reject: (err: Error) => void } | null = null;

function runStages(call: Call, stages: CallStage[], onDone: () => Promise<void>, reject: (err: Error) => void): void {
  const timers: ReturnType<typeof setTimeout>[] = [];
  inFlight = { call, timers, reject };
  stages.forEach((stage, i) => {
    timers.push(schedule(() => db.setStage(call, stage), timing.callTurnMs * (i + 1)));
  });
  timers.push(
    schedule(async () => {
      inFlight = null;
      try {
        await onDone();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    }, timing.callTurnMs * (stages.length + 1)),
  );
}

const PIZZA_AGENT_ID = pizzaAgent.id;
const BARBER_AGENT_ID = barberAgent.id;
/** The scripted callers are the callers of the shared pizza and booking timelines. */
const PIZZA_CALLER = { name: orderFulfilled.contact.name, messageRecipient: orderFulfilled.contact.messageRecipient! };
const BOOKING_CALLER = { name: bookingVerified.customer.name, messageRecipient: bookingVerified.customer.messageRecipient! };

function pizzaAgentVersion(): string {
  const agent = db.getAgentRecord(PIZZA, PIZZA_AGENT_ID);
  return agent.activeVersionId ?? pizzaVersionV2.id;
}

export function startPizzaCall(): Promise<{ callId: string; orderId: string; approvalId: string }> {
  return new Promise((resolve, reject) => {
    const call = db.startCall({
      businessId: PIZZA,
      agentId: PIZZA_AGENT_ID,
      agentVersionId: pizzaAgentVersion(),
      channel: "phone",
      callerLast4: PIZZA_CALLER.messageRecipient.slice(-4),
    });
    runStages(
      call,
      ["COLLECTING", "VALIDATING", "CUSTOMER_CONFIRMED"],
      async () => {
        const { order, approval } = await db.proposeOrderOnCall(call, PIZZA_CALLER);
        // P-07: the caller may hang up while the shop reviews the order.
        schedule(() => db.endCall(call, "completed"), timing.callTurnMs);
        resolve({ callId: call.id, orderId: order.id, approvalId: approval.id });
      },
      reject,
    );
  });
}

export function startBookingCall(options: { slotConflict?: boolean } = {}): Promise<{ callId: string; bookingId: string; approvalId: string }> {
  return new Promise((resolve, reject) => {
    const call = db.startCall({
      businessId: BARBER,
      agentId: BARBER_AGENT_ID,
      agentVersionId: db.getAgentRecord(BARBER, BARBER_AGENT_ID).activeVersionId ?? barberVersionV1.id,
      channel: "phone",
      callerLast4: BOOKING_CALLER.messageRecipient.slice(-4),
    });
    runStages(
      call,
      ["SLOT_SEARCH", "PROPOSAL", "CUSTOMER_CONFIRMED"],
      async () => {
        const { booking, approval } = await db.proposeBookingOnCall(call, BOOKING_CALLER, options);
        schedule(() => db.endCall(call, "completed"), timing.callTurnMs);
        resolve({ callId: call.id, bookingId: booking.id, approvalId: approval.id });
      },
      reject,
    );
  });
}

/** Drop the scripted call that is still collecting, or start one that drops (AC-18: no order, no approval). */
export function simulateCallLost(): Promise<{ callId: string }> {
  if (inFlight) {
    const { call, timers, reject } = inFlight;
    inFlight = null;
    timers.forEach(cancel);
    db.endCall(call, "dropped");
    reject(new Error("The call was lost before the order was confirmed."));
    return Promise.resolve({ callId: call.id });
  }
  return new Promise((resolve) => {
    const call = db.startCall({
      businessId: PIZZA,
      agentId: PIZZA_AGENT_ID,
      agentVersionId: pizzaAgentVersion(),
      channel: "phone",
      callerLast4: "0177",
    });
    schedule(() => db.setStage(call, "COLLECTING"), timing.callTurnMs);
    schedule(() => {
      db.endCall(call, "dropped");
      resolve({ callId: call.id });
    }, timing.callTurnMs * 2);
  });
}

export function simulatePaymentFailed(): void {
  const order = db.newestPendingPayment();
  if (order) db.failPayment(order);
  else db.setFlag("nextPaymentFails", true);
}

export function simulateSyncRetry(): void {
  db.setFlag("nextSyncRetries", true);
}

export function simulateRejectedWebhook(): void {
  db.emit(PIZZA, "webhook.rejected", `whk_${Date.now().toString(36)}`, "provider", { provider: "square", reason: "signature_invalid" });
}

/** The next uploaded file ends in extractionState FAILED with no draft facts. */
export function simulateExtractionFailed(): void {
  db.setFlag("nextExtractionFails", true);
}

/** The next catalog sync ends with sync.failed (final) and leaves the catalog as it was. */
export function simulateCatalogSyncFailed(): void {
  db.setFlag("nextCatalogSyncFails", true);
}

/** The next pizza call uses messageChannel "qr_only", so its message step is SKIPPED after approval. */
export function simulateQrOnlyChannel(): void {
  db.setFlag("nextCallQrOnly", true);
}

export async function reset(): Promise<void> {
  if (inFlight) {
    inFlight.timers.forEach(cancel);
    inFlight = null;
  }
  await db.resetDb();
  // useActivityFeed drops the events it holds and refetches.
  publishMockReset();
}

/** Google Sheets reports disconnected (the shared integrationHealthDisconnected). */
export function simulateSheetsDisconnected(): void {
  db.disconnectSheets();
}

export const mockControls: MockControls = {
  startPizzaCall,
  startBookingCall,
  simulatePaymentFailed,
  simulateSyncRetry,
  simulateCallLost,
  simulateRejectedWebhook,
  simulatePayloadChanged: (approvalId) => db.tamperApproval(approvalId),
  simulateNoLiveAgent: () => db.clearLiveAgent(),
  reset,
  simulateExtractionFailed,
  simulateCatalogSyncFailed,
  simulateQrOnlyChannel,
  simulateSheetsDisconnected,
  simulateEmptyBusiness: (businessId) => {
    db.emptyBusiness(businessId);
    // Screens drop what they hold and refetch, the same as after reset().
    publishMockReset();
  },
  simulateRequestFailure: (rule) => db.addRequestFailure(rule),
  clearRequestFailures: () => db.clearRequestFailures(),
};

/** Returns mockControls in mock mode once the worker started, otherwise null. Same hook as "@/lib/api". */
export const useMockControls = useMockControlsFromBridge;
