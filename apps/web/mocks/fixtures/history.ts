/**
 * Writes the past of a seeded record: its call, executions, dispatches, sync
 * jobs and every activity event, in the order the real server would have
 * written them (FLOWS.md Flow B and C, API.md 3.7). Times step forward a few
 * seconds at a time from the start time given.
 */
import type {
  ActionExecution,
  ActivityEvent,
  ActivityEventType,
  ActivityPayloads,
  ApprovalRequest,
  Booking,
  Call,
  Order,
} from "@/lib/api/pending-contracts";
import { ACTION_CAPABILITY, type ActionType } from "@/lib/api/pending-contracts";
import { iso, last4, makeEvent, sandboxCheckoutUrl } from "../builders";
import { idempotencyKey } from "../hash";
import { MESSAGE_CHANNEL, OWNER_USER_ID, type MockState } from "../types";

export class History {
  constructor(
    private readonly state: MockState,
    readonly businessId: string,
  ) {}

  emit<T extends ActivityEventType>(
    type: T,
    correlationId: string,
    actorType: ActivityEvent["actorType"],
    at: number,
    payload: ActivityPayloads[T],
  ): void {
    this.state.activity.push(makeEvent(this.businessId, type, correlationId, actorType, at, payload));
  }

  /** A call with its stage changes. Returns the time after the last stage. */
  call(call: Call, stages: string[], subject: "order" | "booking", at: number): number {
    this.state.calls.push(call);
    this.emit("call.started", call.id, "provider", at, {
      callId: call.id,
      agentId: call.agentId,
      agentVersionId: call.agentVersionId,
      channel: call.channel,
      callerLast4: call.callerLast4,
    });
    let t = at;
    let from: string | undefined;
    for (const to of stages) {
      t += 20_000;
      if (subject === "order") this.emit("order.status_changed", call.id, "deployed_agent", t, { callId: call.id, from, to });
      else this.emit("booking.status_changed", call.id, "deployed_agent", t, { callId: call.id, from, to });
      from = to;
    }
    return t;
  }

  endCall(call: Call, at: number): void {
    const durationSec = Math.max(1, Math.round((at - Date.parse(call.startedAt)) / 1000));
    this.emit("call.ended", call.id, "provider", at, {
      callId: call.id,
      status: call.status,
      reason: call.endReason ?? "completed",
      durationSec,
    });
  }

  proposal(subject: Order | Booking, approval: ApprovalRequest, call: Call, at: number): void {
    const isOrder = "cart" in subject;
    this.emit("proposal.created", call.id, "deployed_agent", at, {
      subjectId: subject.id,
      subjectType: isOrder ? "order" : "booking",
      callId: call.id,
      ...(isOrder
        ? { totalMinor: subject.totalMinor, currency: "USD" as const }
        : { serviceName: subject.serviceName, startUtc: subject.startUtc }),
    });
    this.emit("approval.requested", call.id, "system", at, {
      approvalId: approval.id,
      bundleType: approval.bundleType,
      subjectId: subject.id,
      actionBundle: approval.actionBundle,
      expiresAt: approval.expiresAt,
      totalMinor: isOrder ? subject.totalMinor : undefined,
      recipientLast4: last4(isOrder ? subject.contact.messageRecipient : subject.customer.messageRecipient),
    });
    if (isOrder) {
      this.emit("order.status_changed", call.id, "system", at, {
        orderId: subject.id,
        callId: call.id,
        from: "CUSTOMER_CONFIRMED",
        to: "AWAITING_OWNER_APPROVAL",
      });
    } else {
      this.emit("booking.status_changed", call.id, "system", at, {
        bookingId: subject.id,
        callId: call.id,
        from: "CUSTOMER_CONFIRMED",
        to: "AWAITING_OWNER_APPROVAL",
      });
    }
  }

  decide(approval: ApprovalRequest, decision: "APPROVED" | "REJECTED", correlationId: string, at: number): void {
    approval.state = decision;
    approval.decidedBy = OWNER_USER_ID;
    approval.decidedAt = iso(at);
    this.emit("approval.decided", correlationId, "owner", at, {
      approvalId: approval.id,
      subjectId: approval.subjectId,
      decision,
      decidedBy: OWNER_USER_ID,
    });
  }

  expire(approval: ApprovalRequest, correlationId: string): void {
    approval.state = "EXPIRED";
    this.emit("approval.expired", correlationId, "system", Date.parse(approval.expiresAt), {
      approvalId: approval.id,
      subjectId: approval.subjectId,
    });
  }

  execution(
    approval: ApprovalRequest,
    actionType: ActionType,
    status: ActionExecution["status"],
    at: number,
    extra: Partial<ActionExecution> = {},
  ): ActionExecution {
    const exe: ActionExecution = {
      id: `exe_${approval.id.replace(/^apv_/, "")}_${approval.actionBundle.indexOf(actionType)}`,
      businessId: approval.businessId,
      approvalId: approval.id,
      actionType,
      stepIndex: approval.actionBundle.indexOf(actionType),
      capabilityId: ACTION_CAPABILITY[actionType],
      idempotencyKey: idempotencyKey(approval.businessId, approval.subjectId, actionType, approval.id),
      status,
      attempts: 1,
      createdAt: iso(at),
      updatedAt: iso(at),
      ...extra,
    };
    this.state.executions.push(exe);
    return exe;
  }

  orderStatus(order: Order, from: string, to: Order["status"], at: number): void {
    order.status = to;
    order.updatedAt = iso(at);
    this.emit("order.status_changed", order.callId, "system", at, { orderId: order.id, callId: order.callId, from, to });
  }

  bookingStatus(booking: Booking, from: string, to: Booking["status"], at: number): void {
    booking.status = to;
    booking.updatedAt = iso(at);
    this.emit("booking.status_changed", booking.callId ?? booking.id, "system", at, {
      bookingId: booking.id,
      callId: booking.callId,
      from,
      to,
    });
  }

  /**
   * An approved order bundle through to its end state.
   * message: what the message step did. payment: what the customer did.
   * sync: the Sheets job after PAID_VERIFIED.
   */
  approvedOrder(
    order: Order,
    approval: ApprovalRequest,
    at: number,
    opts: {
      message: "SENT" | "FAILED";
      payment: "verified" | "failed" | "pending";
      sync?: "DONE" | "RETRYING";
      ready?: boolean;
    },
  ): void {
    const c = order.callId;
    let t = at;
    this.decide(approval, "APPROVED", c, t);
    this.orderStatus(order, "AWAITING_OWNER_APPROVAL", "APPROVED", t);

    t += 1500;
    const checkout = this.execution(approval, "square.checkout.create", "SUCCEEDED", t);
    this.emit("execution.started", c, "system", t, {
      executionId: checkout.id,
      approvalId: approval.id,
      actionType: "square.checkout.create",
      stepIndex: 0,
      attempt: 1,
    });
    this.orderStatus(order, "APPROVED", "CREATING_CHECKOUT", t);
    t += 1500;
    order.squareOrderId = `SQ_ORD_${order.id.slice(4).toUpperCase()}`;
    order.squarePaymentLinkId = `SQ_PL_${order.id.slice(4).toUpperCase()}`;
    order.checkoutUrl = sandboxCheckoutUrl(order.id);
    checkout.externalRef = order.squarePaymentLinkId;
    this.emit("checkout.created", c, "system", t, {
      orderId: order.id,
      squareOrderId: order.squareOrderId,
      squarePaymentLinkId: order.squarePaymentLinkId,
      totalMinor: order.totalMinor,
      currency: "USD",
      sandbox: true,
    });
    this.emit("execution.succeeded", c, "system", t, {
      executionId: checkout.id,
      actionType: "square.checkout.create",
      externalRef: order.squarePaymentLinkId,
    });
    this.orderStatus(order, "CREATING_CHECKOUT", "PAYMENT_LINK_READY", t);

    t += 1500;
    const msgExe = this.execution(approval, "message.checkout.send", opts.message === "SENT" ? "SUCCEEDED" : "FAILED", t, {
      attempts: opts.message === "SENT" ? 1 : 3,
      errorCode: opts.message === "SENT" ? undefined : "INTEGRATION_UNAVAILABLE",
      lastError: opts.message === "SENT" ? undefined : "carrier_rejected",
    });
    this.emit("execution.started", c, "system", t, {
      executionId: msgExe.id,
      approvalId: approval.id,
      actionType: "message.checkout.send",
      stepIndex: 1,
      attempt: 1,
    });
    const dispatchId = `msg_${order.id.slice(4)}`;
    this.state.dispatches.push({
      id: dispatchId,
      businessId: order.businessId,
      executionId: msgExe.id,
      subjectId: order.id,
      channel: MESSAGE_CHANNEL,
      recipient: order.contact.messageRecipient,
      template: "checkout_link",
      status: opts.message,
      providerMessageId: opts.message === "SENT" ? `surge_${order.id.slice(4)}` : undefined,
      idempotencyKey: msgExe.idempotencyKey,
      errorCode: opts.message === "SENT" ? undefined : "INTEGRATION_UNAVAILABLE",
      sentAt: opts.message === "SENT" ? iso(t + 1000) : undefined,
      createdAt: iso(t),
      updatedAt: iso(t + 1000),
    });
    t += 1000;
    if (opts.message === "SENT") {
      this.emit("message.sent", c, "system", t, {
        dispatchId,
        subjectId: order.id,
        channel: MESSAGE_CHANNEL,
        template: "checkout_link",
        recipientLast4: last4(order.contact.messageRecipient),
      });
      this.emit("execution.succeeded", c, "system", t, { executionId: msgExe.id, actionType: "message.checkout.send" });
      this.orderStatus(order, "PAYMENT_LINK_READY", "MESSAGE_SENT", t);
    } else {
      this.emit("message.failed", c, "system", t, {
        dispatchId,
        subjectId: order.id,
        channel: MESSAGE_CHANNEL,
        status: "FAILED",
        errorCode: "INTEGRATION_UNAVAILABLE",
      });
      this.emit("execution.failed", c, "system", t, {
        executionId: msgExe.id,
        actionType: "message.checkout.send",
        errorCode: "INTEGRATION_UNAVAILABLE",
        retryable: false,
        nextStatus: "FAILED",
      });
    }

    t += 1500;
    const record = this.execution(approval, "local.order.record", "SUCCEEDED", t);
    this.emit("execution.started", c, "system", t, {
      executionId: record.id,
      approvalId: approval.id,
      actionType: "local.order.record",
      stepIndex: 2,
      attempt: 1,
    });
    this.emit("execution.succeeded", c, "system", t, { executionId: record.id, actionType: "local.order.record" });
    this.orderStatus(order, order.status, "PAYMENT_PENDING", t);

    if (opts.payment === "pending") return;
    t += 90_000;
    if (opts.payment === "failed") {
      this.emit("payment.failed", c, "provider", t, {
        orderId: order.id,
        squarePaymentId: `SQ_PAY_${order.id.slice(4).toUpperCase()}`,
        reason: "card_declined",
        sandbox: true,
      });
      this.orderStatus(order, "PAYMENT_PENDING", "PAYMENT_FAILED", t);
      return;
    }
    order.squarePaymentId = `SQ_PAY_${order.id.slice(4).toUpperCase()}`;
    this.emit("payment.verified", c, "provider", t, {
      orderId: order.id,
      squarePaymentId: order.squarePaymentId,
      amountMinor: order.totalMinor,
      currency: "USD",
      sandbox: true,
    });
    this.orderStatus(order, "PAYMENT_PENDING", "PAID_VERIFIED", t);
    this.sheets(order.id, "order", opts.sync ?? "DONE", c, t);
    if (opts.ready) {
      t += 1000;
      this.orderStatus(order, "PAID_VERIFIED", "FULFILLMENT_READY", t);
    }
  }

  /** Sheets sync job and its events. RETRYING leaves the job mid-retry after two failed attempts. */
  sheets(recordId: string, recordType: "order" | "booking", status: "DONE" | "RETRYING", correlationId: string, at: number): void {
    const syncJobId = `syn_${recordId.replace(/^(ord|bkg)_/, "")}`;
    this.state.syncJobs.push({
      id: syncJobId,
      businessId: this.businessId,
      target: "google_sheets",
      recordType,
      recordId,
      status,
      attempts: status === "DONE" ? 1 : 2,
      createdAt: iso(at),
      updatedAt: iso(at + 4000),
    });
    this.emit("sync.queued", correlationId, "system", at, { target: "google_sheets", syncJobId, recordType, recordId });
    if (status === "DONE") {
      this.emit("sync.succeeded", correlationId, "system", at + 2000, { target: "google_sheets", syncJobId, recordType, recordId });
    } else {
      this.emit("sync.failed", correlationId, "system", at + 2000, {
        target: "google_sheets",
        syncJobId,
        recordType,
        recordId,
        attempts: 1,
        final: false,
      });
      this.emit("sync.failed", correlationId, "system", at + 4000, {
        target: "google_sheets",
        syncJobId,
        recordType,
        recordId,
        attempts: 2,
        final: false,
      });
    }
  }

  approvedBooking(booking: Booking, approval: ApprovalRequest, at: number, outcome: "booked" | "slot_conflict"): void {
    const c = booking.callId ?? booking.id;
    let t = at;
    this.decide(approval, "APPROVED", c, t);
    if (outcome === "slot_conflict") {
      t += 1500;
      const exe = this.execution(approval, "calendar.event.create", "FAILED", t, { errorCode: "SLOT_CONFLICT" });
      this.emit("execution.started", c, "system", t, {
        executionId: exe.id,
        approvalId: approval.id,
        actionType: "calendar.event.create",
        stepIndex: 0,
        attempt: 1,
      });
      this.bookingStatus(booking, "AWAITING_OWNER_APPROVAL", "RECHECKING_SLOT", t);
      t += 1500;
      const start = Date.parse(booking.startUtc);
      const dur = Date.parse(booking.endUtc) - start;
      this.emit("booking.slot_conflict", c, "provider", t, {
        bookingId: booking.id,
        approvalId: approval.id,
        startUtc: booking.startUtc,
        alternatives: [1, 2, 3].map((n) => ({ startUtc: iso(start + n * 45 * 60_000), endUtc: iso(start + n * 45 * 60_000 + dur) })),
      });
      this.emit("execution.failed", c, "system", t, {
        executionId: exe.id,
        actionType: "calendar.event.create",
        errorCode: "SLOT_CONFLICT",
        retryable: false,
        nextStatus: "FAILED",
      });
      this.bookingStatus(booking, "RECHECKING_SLOT", "SLOT_CONFLICT", t);
      return;
    }
    this.bookingStatus(booking, "AWAITING_OWNER_APPROVAL", "RECHECKING_SLOT", t);
    t += 1500;
    const cal = this.execution(approval, "calendar.event.create", "SUCCEEDED", t);
    booking.googleEventId = `gcal${booking.id.slice(4)}`;
    cal.externalRef = booking.googleEventId;
    this.emit("execution.started", c, "system", t, {
      executionId: cal.id,
      approvalId: approval.id,
      actionType: "calendar.event.create",
      stepIndex: 0,
      attempt: 1,
    });
    t += 1500;
    this.emit("execution.succeeded", c, "system", t, {
      executionId: cal.id,
      actionType: "calendar.event.create",
      externalRef: booking.googleEventId,
    });
    t += 1500;
    const msg = this.execution(approval, "message.booking.confirm", "SUCCEEDED", t);
    const dispatchId = `msg_${booking.id.slice(4)}`;
    this.state.dispatches.push({
      id: dispatchId,
      businessId: booking.businessId,
      executionId: msg.id,
      subjectId: booking.id,
      channel: MESSAGE_CHANNEL,
      recipient: booking.customer.messageRecipient,
      template: "booking_confirmed",
      status: "SENT",
      providerMessageId: `surge_${booking.id.slice(4)}`,
      idempotencyKey: msg.idempotencyKey,
      sentAt: iso(t),
      createdAt: iso(t),
      updatedAt: iso(t),
    });
    this.emit("execution.started", c, "system", t, {
      executionId: msg.id,
      approvalId: approval.id,
      actionType: "message.booking.confirm",
      stepIndex: 1,
      attempt: 1,
    });
    this.emit("message.sent", c, "system", t, {
      dispatchId,
      subjectId: booking.id,
      channel: MESSAGE_CHANNEL,
      template: "booking_confirmed",
      recipientLast4: last4(booking.customer.messageRecipient),
    });
    this.emit("execution.succeeded", c, "system", t, { executionId: msg.id, actionType: "message.booking.confirm" });
    t += 1500;
    const rec = this.execution(approval, "local.booking.record", "SUCCEEDED", t);
    this.emit("execution.started", c, "system", t, {
      executionId: rec.id,
      approvalId: approval.id,
      actionType: "local.booking.record",
      stepIndex: 2,
      attempt: 1,
    });
    this.emit("execution.succeeded", c, "system", t, { executionId: rec.id, actionType: "local.booking.record" });
    this.bookingStatus(booking, "RECHECKING_SLOT", "BOOKED_VERIFIED", t);
    this.emit("booking.verified", c, "provider", t, {
      bookingId: booking.id,
      googleEventId: booking.googleEventId,
      serviceName: booking.serviceName,
      startUtc: booking.startUtc,
      timezone: booking.timezone,
    });
    this.sheets(booking.id, "booking", "DONE", c, t + 1000);
  }
}
