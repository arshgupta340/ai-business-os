/**
 * Seeds the mock db from the shared demo world: materializeFixtures(now) from
 * @abos/contracts/fixtures. Every row comes from there with its times moved to
 * the current clock and its approval hashes recomputed. This file adds no data
 * of its own. It only adds the activity history the shared world leaves open:
 * the shared timelines cover three calls, and for every other seeded call,
 * order, booking, owner approval and file, the events the real server would
 * have written are derived from the rows themselves, so Live operations,
 * Overview and Integrations can show their state.
 *
 * The shared world already gives each booking its own call and keeps the
 * resolution response event (factConflictResolvedEvent) out of
 * allActivityEvents (issue #103), so neither is handled here.
 */
import {
  integrationHealth as baseHealth,
  liveAgentEmpty,
  materializeFixtures,
  type FixtureWorld,
} from "@abos/contracts/fixtures";
import type {
  ActionExecution,
  ActivityEvent,
  ActivityEventPayloads,
  ActivityEventType,
  ActorType,
  ApprovalRequest,
  Booking,
  Call,
  ErrorCode,
  Order,
} from "@abos/contracts";
import { last4, makeEvent, resetEventCounter } from "./builders";
import { OWNER_USER_ID, type AgentRecord, type MockState } from "./types";

/** The state before the first seed finishes. Handlers wait for the seed (db.ready()), so screens never see it. */
export function emptyState(): MockState {
  return {
    businesses: [],
    facts: [],
    conflicts: [],
    files: [],
    catalog: [],
    agents: [],
    versions: [],
    builderSessions: [],
    approvals: [],
    orders: [],
    bookings: [],
    calls: [],
    executions: [],
    dispatches: [],
    syncJobs: [],
    activity: [],
    liveAgent: structuredClone(liveAgentEmpty),
    health: structuredClone(baseHealth),
  };
}

function agentRecord(agent: FixtureWorld["agents"][number]): AgentRecord {
  const { isLiveAgent: _live, activeVersion: _active, ...rest } = agent;
  return rest;
}

/** Async because materializeFixtures recomputes every approval hash with Web Crypto. */
export async function buildSeed(now: number = Date.now()): Promise<MockState> {
  resetEventCounter();
  const w = await materializeFixtures(new Date(now));
  const state: MockState = {
    businesses: w.businesses,
    facts: w.allFacts,
    conflicts: w.factConflicts,
    files: w.files,
    catalog: w.pizzaCatalog,
    agents: w.agents.map(agentRecord),
    versions: w.agentVersions,
    builderSessions: [],
    approvals: w.approvals,
    orders: w.orders,
    bookings: w.bookings,
    calls: w.calls,
    executions: w.executions,
    dispatches: w.messageDispatches,
    syncJobs: w.syncJobs,
    activity: [...w.allActivityEvents],
    liveAgent: w.liveAgent,
    health: w.integrationHealth,
  };
  state.activity.push(...deriveHistory(state));
  state.activity.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  return state;
}

// ---------------------------------------------------------- derived history

type Emit = <T extends ActivityEventType>(
  businessId: string,
  type: T,
  correlationId: string,
  actorType: ActorType,
  at: string,
  payload: ActivityEventPayloads[T],
) => void;

const ORDER_PAST_PAYMENT_PENDING = new Set(["PAYMENT_PENDING", "PAID_VERIFIED", "FULFILLMENT_READY", "PAYMENT_FAILED", "CANCELLED"]);
const latest = (...isos: (string | undefined)[]) =>
  new Date(Math.max(...isos.filter((x): x is string => !!x).map((x) => Date.parse(x)))).toISOString();

/** The events the real server would have written for the seeded rows that no shared timeline covers. */
export function deriveHistory(state: MockState): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  const emit: Emit = (businessId, type, correlationId, actorType, at, payload) => {
    out.push(makeEvent(businessId, type, correlationId, actorType, Date.parse(at), payload));
  };
  const shared = state.activity;
  const callsWithStart = new Set(shared.filter((e) => e.type === "call.started").map((e) => e.correlationId));
  const proposedSubjects = new Set(shared.flatMap((e) => (e.type === "proposal.created" ? [e.payload.subjectId] : [])));
  const requestedApprovals = new Set(shared.flatMap((e) => (e.type === "approval.requested" ? [e.payload.approvalId] : [])));
  const extractedFiles = new Set(shared.flatMap((e) => (e.type === "extraction.completed" ? [e.payload.fileId] : [])));
  const approvalOf = (id: string | undefined) => state.approvals.find((a) => a.id === id);

  const startCall = (call: Call) => {
    if (callsWithStart.has(call.id)) return;
    callsWithStart.add(call.id);
    emit(call.businessId, "call.started", call.id, "provider", call.startedAt, {
      callId: call.id,
      agentId: call.agentId,
      agentVersionId: call.agentVersionId,
      channel: call.channel,
      ...(call.callerLast4 ? { callerLast4: call.callerLast4 } : {}),
    });
  };
  const endCall = (call: Call, derived: boolean) => {
    if (!derived || !call.endedAt || call.status === "IN_PROGRESS") return;
    emit(call.businessId, "call.ended", call.id, "provider", call.endedAt, {
      callId: call.id,
      status: call.status,
      reason: call.endReason ?? "completed",
      durationSec: Math.max(1, Math.round((Date.parse(call.endedAt) - Date.parse(call.startedAt)) / 1000)),
    });
  };
  const decision = (apv: ApprovalRequest, correlationId: string) => {
    if ((apv.state === "APPROVED" || apv.state === "REJECTED") && apv.decidedAt) {
      emit(apv.businessId, "approval.decided", correlationId, "owner", apv.decidedAt, {
        approvalId: apv.id,
        subjectId: apv.subjectId,
        decision: apv.state,
        decidedBy: apv.decidedBy ?? OWNER_USER_ID,
      });
    } else if (apv.state === "EXPIRED") {
      emit(apv.businessId, "approval.expired", correlationId, "system", apv.decidedAt ?? apv.expiresAt, { approvalId: apv.id, subjectId: apv.subjectId });
    }
  };
  /** Execution rows of one approval, in step order. Returns when the last one settled. */
  const executions = (apv: ApprovalRequest, correlationId: string, order?: Order): string | undefined => {
    const rows = state.executions.filter((e) => e.approvalId === apv.id).sort((a, b) => a.stepIndex - b.stepIndex);
    let lastAt: string | undefined;
    for (const exe of rows) {
      if (exe.status === "SKIPPED" || exe.status === "QUEUED") continue;
      emit(apv.businessId, "execution.started", correlationId, "system", exe.createdAt, {
        executionId: exe.id,
        approvalId: apv.id,
        actionType: exe.actionType,
        stepIndex: exe.stepIndex,
        attempt: Math.max(1, exe.attempts),
      });
      outcome(apv, exe, correlationId, order);
      lastAt = exe.updatedAt;
    }
    return lastAt;
  };
  const outcome = (apv: ApprovalRequest, exe: ActionExecution, correlationId: string, order?: Order) => {
    const at = exe.updatedAt;
    if (exe.actionType === "square.checkout.create" && exe.status === "SUCCEEDED" && order?.squareOrderId && order.squarePaymentLinkId) {
      emit(apv.businessId, "checkout.created", correlationId, "system", at, {
        orderId: order.id,
        squareOrderId: order.squareOrderId,
        squarePaymentLinkId: order.squarePaymentLinkId,
        totalMinor: order.totalMinor,
        currency: order.currency,
        sandbox: true,
      });
    }
    const dispatch = state.dispatches.find((d) => d.executionId === exe.id);
    if (dispatch?.status === "SENT" || dispatch?.status === "DELIVERED") {
      emit(apv.businessId, "message.sent", correlationId, "system", dispatch.sentAt ?? at, {
        dispatchId: dispatch.id,
        subjectId: dispatch.subjectId,
        channel: dispatch.channel,
        template: dispatch.template,
        recipientLast4: last4(dispatch.recipient),
      });
    } else if (dispatch?.status === "FAILED" || dispatch?.status === "UNKNOWN") {
      emit(apv.businessId, "message.failed", correlationId, "system", dispatch.updatedAt, {
        dispatchId: dispatch.id,
        subjectId: dispatch.subjectId,
        channel: dispatch.channel,
        status: dispatch.status,
        ...(dispatch.errorCode ? { errorCode: dispatch.errorCode } : {}),
      });
    }
    if (exe.status === "SUCCEEDED") {
      emit(apv.businessId, "execution.succeeded", correlationId, "system", at, {
        executionId: exe.id,
        actionType: exe.actionType,
        ...(exe.externalRef ? { externalRef: exe.externalRef } : {}),
      });
    } else if (exe.status === "FAILED" || exe.status === "NEEDS_REVIEW") {
      // The event needs an error code. A row without one stopped on its provider (lastError says why).
      const errorCode: ErrorCode = exe.errorCode ?? "INTEGRATION_UNAVAILABLE";
      emit(apv.businessId, "execution.failed", correlationId, "system", at, {
        executionId: exe.id,
        actionType: exe.actionType,
        errorCode,
        retryable: false,
        nextStatus: exe.status,
      });
    }
  };
  const sheets = (businessId: string, recordType: "order" | "booking", recordId: string, correlationId: string) => {
    for (const job of state.syncJobs.filter((j) => j.recordId === recordId)) {
      const base = { target: "google_sheets" as const, syncJobId: job.id, recordType, recordId };
      emit(businessId, "sync.queued", correlationId, "system", job.createdAt, base);
      const start = Date.parse(job.createdAt);
      const span = Math.max(1, Date.parse(job.updatedAt) - start);
      if (job.state === "DONE") emit(businessId, "sync.succeeded", correlationId, "system", job.updatedAt, base);
      if (job.state === "RETRYING" || job.state === "FAILED") {
        for (let attempt = 1; attempt <= job.attempts; attempt++) {
          const at = new Date(start + Math.round((span * attempt) / job.attempts)).toISOString();
          emit(businessId, "sync.failed", correlationId, "system", at, { ...base, attempts: attempt, final: job.state === "FAILED" && attempt === job.attempts });
        }
      }
    }
  };

  // ---- orders
  for (const order of state.orders) {
    if (proposedSubjects.has(order.id)) continue;
    const apv = approvalOf(order.approvalId);
    const call = state.calls.find((c) => c.id === order.callId);
    if (!apv || !call) continue;
    const c = call.id;
    const callDerived = !callsWithStart.has(c);
    startCall(call);
    emit(order.businessId, "proposal.created", c, "deployed_agent", order.createdAt, {
      subjectId: order.id,
      subjectType: "order",
      callId: c,
      totalMinor: order.totalMinor,
      currency: order.currency,
    });
    requestApproval(emit, apv, c, order.totalMinor, order.contact.messageRecipient);
    emit(order.businessId, "order.status_changed", c, "system", order.createdAt, { orderId: order.id, callId: c, from: "CUSTOMER_CONFIRMED", to: "AWAITING_OWNER_APPROVAL" });
    endCall(call, callDerived);
    decision(apv, c);
    if (apv.state === "REJECTED") {
      emit(order.businessId, "order.status_changed", c, "system", apv.decidedAt!, { orderId: order.id, callId: c, from: "AWAITING_OWNER_APPROVAL", to: "REJECTED" });
    } else if (apv.state === "EXPIRED") {
      emit(order.businessId, "order.status_changed", c, "system", apv.decidedAt ?? apv.expiresAt, { orderId: order.id, callId: c, from: "AWAITING_OWNER_APPROVAL", to: "APPROVAL_EXPIRED" });
    } else if (apv.state === "APPROVED") {
      emit(order.businessId, "order.status_changed", c, "system", apv.decidedAt!, { orderId: order.id, callId: c, from: "AWAITING_OWNER_APPROVAL", to: "APPROVED" });
      const settled = executions(apv, c, order) ?? apv.decidedAt!;
      if (ORDER_PAST_PAYMENT_PENDING.has(order.status)) {
        emit(order.businessId, "order.status_changed", c, "system", settled, { orderId: order.id, callId: c, from: "APPROVED", to: "PAYMENT_PENDING" });
      }
      const doneAt = latest(order.updatedAt, settled);
      if ((order.status === "PAID_VERIFIED" || order.status === "FULFILLMENT_READY") && order.squarePaymentId) {
        emit(order.businessId, "payment.verified", c, "provider", doneAt, {
          orderId: order.id,
          squarePaymentId: order.squarePaymentId,
          amountMinor: order.totalMinor,
          currency: order.currency,
          sandbox: true,
        });
        emit(order.businessId, "order.status_changed", c, "system", doneAt, { orderId: order.id, callId: c, from: "PAYMENT_PENDING", to: "PAID_VERIFIED" });
      } else if (order.status === "PAYMENT_FAILED") {
        // AC-12: the declined sandbox card.
        emit(order.businessId, "payment.failed", c, "provider", doneAt, { orderId: order.id, reason: "card_declined", sandbox: true });
        emit(order.businessId, "order.status_changed", c, "system", doneAt, { orderId: order.id, callId: c, from: "PAYMENT_PENDING", to: "PAYMENT_FAILED" });
      }
      sheets(order.businessId, "order", order.id, c);
    }
  }

  // ---- bookings
  for (const booking of state.bookings) {
    if (proposedSubjects.has(booking.id)) continue;
    const apv = approvalOf(booking.approvalId);
    const call = state.calls.find((x) => x.id === booking.callId);
    if (!apv || !call) continue;
    const c = call.id;
    const callDerived = !callsWithStart.has(c);
    startCall(call);
    emit(booking.businessId, "proposal.created", c, "deployed_agent", booking.createdAt, {
      subjectId: booking.id,
      subjectType: "booking",
      callId: c,
      serviceName: booking.serviceName,
      startUtc: booking.startUtc,
    });
    requestApproval(emit, apv, c, undefined, booking.customer.messageRecipient);
    bookingStatus(emit, booking, c, booking.createdAt, "CUSTOMER_CONFIRMED", "AWAITING_OWNER_APPROVAL");
    endCall(call, callDerived);
    decision(apv, c);
    if (apv.state === "REJECTED") bookingStatus(emit, booking, c, apv.decidedAt!, "AWAITING_OWNER_APPROVAL", "REJECTED");
    else if (apv.state === "EXPIRED") bookingStatus(emit, booking, c, apv.decidedAt ?? apv.expiresAt, "AWAITING_OWNER_APPROVAL", "EXPIRED");
    else if (apv.state === "APPROVED") {
      bookingStatus(emit, booking, c, apv.decidedAt!, "AWAITING_OWNER_APPROVAL", "RECHECKING_SLOT");
      const settled = executions(apv, c) ?? apv.decidedAt!;
      const doneAt = latest(booking.updatedAt, settled);
      if (booking.status === "BOOKED_VERIFIED" && booking.googleEventId) {
        emit(booking.businessId, "booking.verified", c, "system", doneAt, {
          bookingId: booking.id,
          googleEventId: booking.googleEventId,
          serviceName: booking.serviceName,
          startUtc: booking.startUtc,
          timezone: booking.timezone,
        });
      }
      if (booking.status !== "RECHECKING_SLOT") bookingStatus(emit, booking, c, doneAt, "RECHECKING_SLOT", booking.status);
      sheets(booking.businessId, "booking", booking.id, c);
    }
  }

  // ---- calls with no order or booking (dropped, failed, in progress, a refusal)
  for (const call of state.calls) {
    if (callsWithStart.has(call.id)) continue;
    startCall(call);
    endCall(call, true);
  }

  // ---- owner approvals (fact and price edits): correlated by approval id, as the mock db does
  for (const apv of state.approvals) {
    if (apv.actorType !== "owner" || requestedApprovals.has(apv.id)) continue;
    requestApproval(emit, apv, apv.id);
    decision(apv, apv.id);
  }

  // ---- uploads with no extraction event yet
  for (const file of state.files) {
    if (extractedFiles.has(file.id) || (file.extractionState !== "EXTRACTED" && file.extractionState !== "FAILED")) continue;
    emit(file.businessId, "extraction.completed", file.id, "system", file.createdAt, {
      fileId: file.id,
      mime: file.mime,
      extractionState: file.extractionState,
      draftFactCount: file.draftFactIds?.length ?? 0,
      conflictCount: file.conflictIds?.length ?? 0,
    });
  }
  return out;
}

function requestApproval(emit: Emit, apv: ApprovalRequest, correlationId: string, totalMinor?: number, recipient?: string): void {
  emit(apv.businessId, "approval.requested", correlationId, apv.actorType === "owner" ? "owner" : "system", apv.createdAt, {
    approvalId: apv.id,
    bundleType: apv.bundleType,
    subjectId: apv.subjectId,
    actionBundle: apv.actionBundle,
    expiresAt: apv.expiresAt,
    ...(totalMinor !== undefined ? { totalMinor } : {}),
    ...(recipient ? { recipientLast4: last4(recipient) } : {}),
  });
}

function bookingStatus(
  emit: Emit,
  booking: Booking,
  callId: string,
  at: string,
  from: ActivityEventPayloads["booking.status_changed"]["from"],
  to: ActivityEventPayloads["booking.status_changed"]["to"],
): void {
  emit(booking.businessId, "booking.status_changed", callId, "system", at, { bookingId: booking.id, callId, from, to });
}
