/**
 * Pure logic for Live operations: group activity events into one journey per
 * call and derive what each journey shows (steps, current state, notices).
 *
 * Rules this file keeps (AGENTS.md, docs/FLOWS.md 3.5):
 * - Labels and tones come from statusView. This file never maps a state to a
 *   color itself.
 * - State comes from the REST reads (order, booking, call, checkout). Events
 *   only fill what has no REST read: execution steps, the Sheets sync and the
 *   booking confirmation message.
 * - Paid is shown only when the order says PAID_VERIFIED (or FULFILLMENT_READY)
 *   and a payment.verified event for that order is in the timeline. Booked is
 *   shown only when the booking says BOOKED_VERIFIED and a booking.verified
 *   event is in the timeline.
 */
import type {
  ActivityEvent,
  ActivityEventPayloads,
  ApprovalState,
  Booking,
  Call,
  MessageDispatchStatus,
  Order,
  OrderCheckout,
} from '@/lib/api';
import {statusView, type StatusView, type Tone} from '@/lib/status';

// ------------------------------------------------------------- grouping

type EventOf<T extends keyof ActivityEventPayloads> = ActivityEvent & {type: T};

function payload<T extends keyof ActivityEventPayloads>(event: ActivityEvent, type: T): ActivityEventPayloads[T] | null {
  return event.type === type ? (event.payload as unknown as ActivityEventPayloads[T]) : null;
}

function is<T extends keyof ActivityEventPayloads>(type: T) {
  return (event: ActivityEvent): event is EventOf<T> => event.type === type;
}

/**
 * Merge event lists (each newest first, as the API and the feed return them),
 * drop duplicates by id and return them oldest first. Events with the same
 * time keep the order they were written in.
 */
export function mergeEvents(...lists: ActivityEvent[][]): ActivityEvent[] {
  const seen = new Set<string>();
  const ascending: ActivityEvent[] = [];
  for (const list of lists) {
    for (const event of [...list].reverse()) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      ascending.push(event);
    }
  }
  return ascending.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}

/** True for a correlation id that names a call journey. */
export function isCallId(id: string): boolean {
  return id.startsWith('call_');
}

/** One entry per call, oldest event first in each. Events of other journeys (fact edits, webhooks) are left out. */
export function groupByCall(events: ActivityEvent[]): Map<string, ActivityEvent[]> {
  const groups = new Map<string, ActivityEvent[]>();
  for (const event of mergeEvents(events)) {
    if (!isCallId(event.correlationId)) continue;
    const list = groups.get(event.correlationId);
    if (list) list.push(event);
    else groups.set(event.correlationId, [event]);
  }
  return groups;
}

// ------------------------------------------------------------- journeys

export type JourneyKind = 'order' | 'booking' | 'call_only';

export interface JourneyStep {
  key: string;
  label: string;
  /** Set once the step is reached. Absent means not reached yet. */
  view?: StatusView;
  detail?: string;
}

export interface ExecutionView {
  executionId: string;
  actionType: string;
  stepIndex?: number;
  attempt?: number;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'NEEDS_REVIEW';
  errorCode?: string;
  externalRef?: string;
}

export interface SyncView {
  status: 'PENDING' | 'RETRYING' | 'DONE' | 'FAILED';
  attempts?: number;
}

export interface MessageView {
  /** A dispatch status, SKIPPED (no dispatch under qr_only), or NOT_STARTED. */
  status: MessageDispatchStatus | 'SKIPPED' | 'NOT_STARTED';
  channel?: string;
}

export interface Notice {
  key: string;
  tone: Tone;
  title: string;
  description: string;
}

export interface ApprovalView {
  id: string;
  state: ApprovalState;
  expiresAt?: string;
  actionBundle: string[];
  recipientLast4?: string;
}

export interface Journey {
  callId: string;
  call?: Call;
  kind: JourneyKind;
  order?: Order;
  booking?: Booking;
  events: ActivityEvent[];
  startedAt: string;
  steps: JourneyStep[];
  /** Index of the current step. Equal to steps.length when every step is done. */
  activeStep: number;
  headline: StatusView;
  approval?: ApprovalView;
  executions: ExecutionView[];
  sync?: SyncView;
  message?: MessageView;
  paidVerified: boolean;
  bookedVerified: boolean;
  payment?: {state: 'verified'; squarePaymentId: string; amountMinor: number} | {state: 'failed'; reason: string};
  slotConflict?: {alternatives: {startUtc: string; endUtc: string}[]};
  notices: Notice[];
  /** True when nothing more will happen on its own. */
  finished: boolean;
}

export interface JourneyInput {
  callId: string;
  events: ActivityEvent[];
  call?: Call;
  order?: Order;
  booking?: Booking;
  /** GET /api/orders/:id/checkout, when loaded. */
  checkout?: OrderCheckout;
  /** The message channel is qr_only (from the approval payload or integration health). */
  qrOnly?: boolean;
}

const PAID_STATES = new Set(['PAID_VERIFIED', 'FULFILLMENT_READY']);
const LINK_STATES = new Set(['PAYMENT_LINK_READY', 'MESSAGE_SENT', 'PAYMENT_PENDING']);
const BEFORE_CHECKOUT = new Set(['APPROVED', 'CREATING_CHECKOUT']);
/** Order states after which the message step has run or been skipped. */
const PAST_MESSAGE_STEP = new Set(['PAYMENT_PENDING', 'PAID_VERIFIED', 'FULFILLMENT_READY', 'PAYMENT_FAILED', 'CANCELLED']);

const ORDER_FINISHED = new Set(['FULFILLMENT_READY', 'REJECTED', 'APPROVAL_EXPIRED', 'CANCELLED', 'UNAVAILABLE', 'PAYMENT_FAILED']);
const BOOKING_FINISHED = new Set(['BOOKED_VERIFIED', 'REJECTED', 'EXPIRED', 'SLOT_CONFLICT']);

/** The owner-facing name of an action type in a bundle. */
export const ACTION_LABELS: Record<string, string> = {
  'square.checkout.create': 'Create the Square checkout link',
  'message.checkout.send': 'Send the link to the customer',
  'local.order.record': 'Record the order',
  'sheets.order.append': 'Report to Google Sheets',
  'calendar.event.create': 'Create the calendar event',
  'message.booking.confirm': 'Send the confirmation',
  'local.booking.record': 'Record the booking',
  'sheets.booking.append': 'Report to Google Sheets',
};

export function actionLabel(actionType: string): string {
  return ACTION_LABELS[actionType] ?? actionType;
}

function approvalFromEvents(events: ActivityEvent[]): ApprovalView | undefined {
  const requested = [...events].reverse().find(is('approval.requested'));
  if (!requested) return undefined;
  const p = payload(requested, 'approval.requested')!;
  let state: ApprovalState = 'PENDING';
  for (const event of events) {
    const decided = payload(event, 'approval.decided');
    if (decided && decided.approvalId === p.approvalId) state = decided.decision;
    const expired = payload(event, 'approval.expired');
    if (expired && expired.approvalId === p.approvalId) state = 'EXPIRED';
  }
  return {id: p.approvalId, state, expiresAt: p.expiresAt, actionBundle: p.actionBundle, recipientLast4: p.recipientLast4};
}

/** Approval state from the subject's REST status, which wins over the events. */
function approvalStateFromSubject(status: string): ApprovalState {
  if (status === 'AWAITING_OWNER_APPROVAL') return 'PENDING';
  if (status === 'REJECTED') return 'REJECTED';
  if (status === 'APPROVAL_EXPIRED' || status === 'EXPIRED') return 'EXPIRED';
  return 'APPROVED';
}

export function executionsFromEvents(events: ActivityEvent[]): ExecutionView[] {
  const byId = new Map<string, ExecutionView>();
  for (const event of events) {
    const started = payload(event, 'execution.started');
    if (started) {
      byId.set(started.executionId, {
        executionId: started.executionId,
        actionType: started.actionType,
        stepIndex: started.stepIndex,
        attempt: started.attempt,
        status: 'RUNNING',
      });
      continue;
    }
    const succeeded = payload(event, 'execution.succeeded');
    if (succeeded) {
      const prior = byId.get(succeeded.executionId);
      byId.set(succeeded.executionId, {
        ...(prior ?? {executionId: succeeded.executionId, actionType: succeeded.actionType}),
        status: 'SUCCEEDED',
        externalRef: succeeded.externalRef,
      });
      continue;
    }
    const failed = payload(event, 'execution.failed');
    if (failed) {
      const prior = byId.get(failed.executionId);
      byId.set(failed.executionId, {
        ...(prior ?? {executionId: failed.executionId, actionType: failed.actionType}),
        status: failed.nextStatus === 'NEEDS_REVIEW' ? 'NEEDS_REVIEW' : 'FAILED',
        errorCode: failed.errorCode,
      });
    }
  }
  return [...byId.values()];
}

export function syncFromEvents(events: ActivityEvent[], recordId: string | undefined): SyncView | undefined {
  if (!recordId) return undefined;
  let view: SyncView | undefined;
  for (const event of events) {
    const fields = event.payload as {target?: string; recordId?: string};
    if (fields.target !== 'google_sheets' || fields.recordId !== recordId) continue;
    if (event.type === 'sync.queued') view = {status: 'PENDING'};
    else if (event.type === 'sync.succeeded') view = {status: 'DONE', attempts: view?.attempts};
    else if (event.type === 'sync.failed') {
      const p = payload(event, 'sync.failed')!;
      view = {status: p.final ? 'FAILED' : 'RETRYING', attempts: p.attempts};
    }
  }
  return view;
}

/** Label and tone for a sync view, with the attempt number when the payload gave one. */
export function syncStatusView(sync: SyncView): StatusView {
  const base = statusView('syncJob', sync.status);
  if ((sync.status === 'RETRYING' || sync.status === 'FAILED') && sync.attempts) {
    return {...base, label: `${base.label}, attempt ${sync.attempts}`};
  }
  return base;
}

function orderMessage(order: Order, input: JourneyInput, executions: ExecutionView[]): MessageView {
  if (input.checkout?.message) {
    return {status: input.checkout.message.status, channel: input.checkout.message.channel};
  }
  const started = executions.some((e) => e.actionType === 'message.checkout.send');
  if (!started && (input.qrOnly || PAST_MESSAGE_STEP.has(order.status))) {
    // FLOWS.md 4: under qr_only the message step ends SKIPPED and writes no event or dispatch.
    return {status: 'SKIPPED', channel: input.qrOnly ? 'qr_only' : undefined};
  }
  if (started) {
    // A message step ran but the checkout read has no dispatch yet: say only that it is queued.
    const failed = [...input.events].reverse().find(is('message.failed'));
    if (failed) {
      const p = payload(failed, 'message.failed')!;
      if (p.subjectId === order.id) return {status: p.status, channel: p.channel};
    }
    return {status: 'QUEUED'};
  }
  return {status: 'NOT_STARTED'};
}

function bookingMessage(booking: Booking, events: ActivityEvent[]): MessageView {
  let view: MessageView = {status: 'NOT_STARTED'};
  for (const event of events) {
    const sent = payload(event, 'message.sent');
    if (sent && sent.subjectId === booking.id) view = {status: 'SENT', channel: sent.channel};
    const failed = payload(event, 'message.failed');
    if (failed && failed.subjectId === booking.id) view = {status: failed.status, channel: failed.channel};
  }
  return view;
}

function callStep(call: Call | undefined, events: ActivityEvent[]): JourneyStep {
  if (call) {
    const live = call.status === 'IN_PROGRESS';
    const view = live ? statusView('callStage', call.stage) : statusView('call', call.status);
    return {key: 'call', label: 'Call', view, detail: live ? statusView('call', call.status).label : undefined};
  }
  const ended = [...events].reverse().find(is('call.ended'));
  if (ended) return {key: 'call', label: 'Call', view: statusView('call', payload(ended, 'call.ended')!.status)};
  return {key: 'call', label: 'Call', view: statusView('call', 'IN_PROGRESS')};
}

const view = (label: string, tone: Tone): StatusView => ({label, tone});

function deriveOrder(input: JourneyInput, order: Order, base: Partial<Journey>): Journey {
  const events = input.events;
  const executions = executionsFromEvents(events);
  const verifiedEvent = events
    .filter(is('payment.verified'))
    .map((e) => payload(e, 'payment.verified')!)
    .find((p) => p.orderId === order.id);
  const failedEvent = events
    .filter(is('payment.failed'))
    .map((e) => payload(e, 'payment.failed')!)
    .find((p) => p.orderId === order.id);
  const paidVerified = PAID_STATES.has(order.status) && !!verifiedEvent;
  const status = order.status;
  const approvalState = approvalStateFromSubject(status);
  const fromEvents = approvalFromEvents(events);
  const approvalId = order.approvalId ?? fromEvents?.id;
  const approval: ApprovalView | undefined = approvalId
    ? {
        id: approvalId,
        state: approvalState,
        expiresAt: fromEvents?.expiresAt,
        actionBundle: fromEvents?.actionBundle ?? [],
        recipientLast4: fromEvents?.recipientLast4,
      }
    : undefined;

  const steps: JourneyStep[] = [
    callStep(input.call, events),
    {key: 'proposal', label: 'Proposal', view: view('Proposal ready', 'info'), detail: 'Total from Square (sandbox)'},
    {key: 'approval', label: 'Approval'},
    {key: 'checkout', label: 'Checkout link'},
    {key: 'paid', label: 'Paid'},
  ];
  let active = 2;
  const notices: Notice[] = [];

  if (approvalState === 'PENDING') {
    steps[2].view = statusView('order', status);
  } else if (approvalState === 'REJECTED') {
    steps[2].view = statusView('approval', 'REJECTED');
    notices.push({
      key: 'rejected',
      tone: statusView('order', 'REJECTED').tone,
      title: 'You rejected this order',
      description: 'Nothing was sent to Square or the customer, and nothing was charged.',
    });
  } else if (approvalState === 'EXPIRED') {
    steps[2].view = statusView('approval', 'EXPIRED');
    notices.push({
      key: 'expired',
      tone: statusView('order', 'APPROVAL_EXPIRED').tone,
      title: 'The approval expired',
      description: 'Nobody decided in time, so nothing was sent and nothing was charged. The caller needs to order again.',
    });
  } else {
    steps[2].view = statusView('approval', 'APPROVED');
    active = 3;
    if (BEFORE_CHECKOUT.has(status)) {
      steps[3].view = statusView('order', status);
    } else if (status === 'UNAVAILABLE') {
      steps[3].view = statusView('order', 'UNAVAILABLE');
      notices.push({
        key: 'unavailable',
        tone: statusView('order', 'UNAVAILABLE').tone,
        title: 'An item is no longer available',
        description: 'The item became unavailable after you approved. No checkout link was created, nothing was sent and nothing was charged.',
      });
    } else if (status === 'RECOVERY_REQUIRED') {
      const failed = executions.find((e) => e.status === 'FAILED' || e.status === 'NEEDS_REVIEW');
      steps[3].view = statusView('order', 'RECOVERY_REQUIRED');
      notices.push({
        key: 'recovery',
        tone: statusView('order', 'RECOVERY_REQUIRED').tone,
        title: 'This order needs your review',
        description: `A step stopped${failed ? ` (${actionLabel(failed.actionType)}${failed.errorCode ? `, ${failed.errorCode}` : ''})` : ''}. The customer did not get a payment link from this step. Check Square before you contact the customer.`,
      });
    } else {
      // The link exists from here on.
      steps[3].view = LINK_STATES.has(status)
        ? statusView('order', status)
        : {...statusView('order', 'PAYMENT_LINK_READY'), label: 'Link created (sandbox)'};
      active = 4;
      if (paidVerified) {
        steps[4].view = statusView('order', status);
        active = 5;
      } else if (status === 'PAYMENT_FAILED') {
        steps[4].view = statusView('order', 'PAYMENT_FAILED');
        notices.push({
          key: 'payment_failed',
          tone: statusView('order', 'PAYMENT_FAILED').tone,
          title: 'Payment failed (sandbox)',
          description: `Square reported the payment as failed${failedEvent?.reason ? ` (${failedEvent.reason})` : ''}. The order is not paid and will not go to the kitchen. You can call the customer back.`,
        });
      } else if (status === 'CANCELLED') {
        steps[4].view = statusView('order', 'CANCELLED');
      } else if (PAID_STATES.has(status)) {
        // The order says paid but the verified event is not in the timeline yet.
        steps[4].view = statusView('order', 'PAYMENT_PENDING');
        steps[4].detail = 'Waiting for the verified payment event';
      } else {
        steps[4].view = statusView('order', 'PAYMENT_PENDING');
      }
    }
  }

  const message = approvalState === 'APPROVED' ? orderMessage(order, input, executions) : undefined;
  if (message && (message.status === 'FAILED' || message.status === 'UNKNOWN')) {
    notices.push({
      key: 'message',
      tone: statusView('messageDispatch', message.status).tone,
      title: message.status === 'FAILED' ? 'The payment link message failed' : 'Delivery of the payment link is unknown',
      description:
        message.status === 'FAILED'
          ? 'The customer did not get the link by message. Show them the QR code.'
          : 'The channel did not confirm the message. It is not resent automatically. Show the customer the QR code.',
    });
  }

  for (const exe of executions) {
    if (exe.status === 'NEEDS_REVIEW') {
      notices.push({
        key: `review_${exe.executionId}`,
        tone: statusView('execution', 'NEEDS_REVIEW').tone,
        title: `${actionLabel(exe.actionType)} needs your review`,
        description: `The result of this step is unknown${exe.errorCode ? ` (${exe.errorCode})` : ''}. It is not repeated automatically.`,
      });
    }
  }

  const sync = syncFromEvents(events, order.id);
  pushSyncNotice(notices, sync);
  const headline = paidVerified
    ? statusView('order', status)
    : PAID_STATES.has(status)
      ? {...statusView('order', 'PAYMENT_PENDING'), label: 'Checking the payment (sandbox)'}
      : statusView('order', status);

  const callOpen = input.call?.status === 'IN_PROGRESS';
  const syncOpen = sync ? sync.status === 'PENDING' || sync.status === 'RETRYING' : false;
  return {
    ...(base as Journey),
    kind: 'order',
    order,
    steps,
    activeStep: active,
    headline,
    approval,
    executions,
    sync,
    message,
    paidVerified,
    bookedVerified: false,
    payment: paidVerified && verifiedEvent
      ? {state: 'verified', squarePaymentId: verifiedEvent.squarePaymentId, amountMinor: verifiedEvent.amountMinor}
      : status === 'PAYMENT_FAILED'
        ? {state: 'failed', reason: failedEvent?.reason ?? 'unknown'}
        : undefined,
    notices,
    finished: !callOpen && ORDER_FINISHED.has(status) && !syncOpen,
  };
}

function pushSyncNotice(notices: Notice[], sync: SyncView | undefined): void {
  if (sync?.status === 'RETRYING') {
    notices.push({
      key: 'sync',
      tone: statusView('syncJob', 'RETRYING').tone,
      title: `Google Sheets report is retrying${sync.attempts ? ` (attempt ${sync.attempts} failed)` : ''}`,
      description: 'The row did not write yet. The server retries on its own and never writes it twice. The order itself is not affected.',
    });
  } else if (sync?.status === 'FAILED') {
    notices.push({
      key: 'sync',
      tone: statusView('syncJob', 'FAILED').tone,
      title: 'Google Sheets report failed',
      description: `The report row was not written${sync.attempts ? ` after ${sync.attempts} attempts` : ''}. The order and the payment are not affected.`,
    });
  }
}

function deriveBooking(input: JourneyInput, booking: Booking, base: Partial<Journey>): Journey {
  const events = input.events;
  const executions = executionsFromEvents(events);
  const verified = events
    .filter(is('booking.verified'))
    .map((e) => payload(e, 'booking.verified')!)
    .find((p) => p.bookingId === booking.id);
  const conflict = events
    .filter(is('booking.slot_conflict'))
    .map((e) => payload(e, 'booking.slot_conflict')!)
    .find((p) => p.bookingId === booking.id);
  const status = booking.status;
  const bookedVerified = status === 'BOOKED_VERIFIED' && !!verified;
  const approvalState = approvalStateFromSubject(status);
  const fromEvents = approvalFromEvents(events);
  const approvalId = booking.approvalId ?? fromEvents?.id;

  const steps: JourneyStep[] = [
    callStep(input.call, events),
    {key: 'proposal', label: 'Proposal', view: view('Time offered', 'info'), detail: booking.serviceName},
    {key: 'approval', label: 'Approval'},
    {key: 'calendar', label: 'Calendar'},
    {key: 'booked', label: 'Booked'},
  ];
  let active = 2;
  const notices: Notice[] = [];
  const calendarStep = executions.find((e) => e.actionType === 'calendar.event.create');

  if (approvalState === 'PENDING') {
    steps[2].view = statusView('booking', status);
  } else if (approvalState === 'REJECTED') {
    steps[2].view = statusView('approval', 'REJECTED');
    notices.push({
      key: 'rejected',
      tone: statusView('booking', 'REJECTED').tone,
      title: 'You rejected this booking',
      description: 'No calendar event was created and no message was sent.',
    });
  } else if (approvalState === 'EXPIRED') {
    steps[2].view = statusView('approval', 'EXPIRED');
    notices.push({
      key: 'expired',
      tone: statusView('booking', 'EXPIRED').tone,
      title: 'The approval expired',
      description: 'Nobody decided in time, so nothing was booked and no message was sent.',
    });
  } else {
    steps[2].view = statusView('approval', 'APPROVED');
    active = 3;
    if (status === 'SLOT_CONFLICT') {
      steps[3].view = statusView('booking', 'SLOT_CONFLICT');
      notices.push({
        key: 'slot_conflict',
        tone: statusView('booking', 'SLOT_CONFLICT').tone,
        title: 'The slot was taken after the proposal',
        description:
          'No calendar event was created and no confirmation was sent. A different time needs a new proposal and a new approval.',
      });
    } else if (status === 'RETRY_REQUIRED') {
      steps[3].view = statusView('booking', 'RETRY_REQUIRED');
      notices.push({
        key: 'retry',
        tone: statusView('booking', 'RETRY_REQUIRED').tone,
        title: 'This booking needs your review',
        description: `The calendar step did not finish${calendarStep?.errorCode ? ` (${calendarStep.errorCode})` : ''}. Check Google Calendar before you contact the customer. It is not repeated automatically.`,
      });
    } else if (calendarStep?.status === 'SUCCEEDED') {
      steps[3].view = statusView('execution', 'SUCCEEDED');
      steps[3].detail = 'Google Calendar event created';
      active = 4;
      if (bookedVerified) {
        steps[4].view = statusView('booking', 'BOOKED_VERIFIED');
        active = 5;
      } else {
        steps[4].view = statusView('booking', 'RECHECKING_SLOT');
        steps[4].label = 'Booked';
        steps[4].detail = 'Waiting for the booking to be verified';
      }
    } else {
      steps[3].view = statusView('booking', 'RECHECKING_SLOT');
    }
  }

  const message = approvalState === 'APPROVED' ? bookingMessage(booking, events) : undefined;
  if (message && (message.status === 'FAILED' || message.status === 'UNKNOWN')) {
    notices.push({
      key: 'message',
      tone: statusView('messageDispatch', message.status).tone,
      title: message.status === 'FAILED' ? 'The confirmation message failed' : 'Delivery of the confirmation is unknown',
      description:
        message.status === 'FAILED'
          ? 'The customer did not get the confirmation. The booking itself still stands.'
          : 'The channel did not confirm the message. It is not resent automatically.',
    });
  }

  const sync = syncFromEvents(events, booking.id);
  pushSyncNotice(notices, sync);
  const callOpen = input.call?.status === 'IN_PROGRESS';
  const syncOpen = sync ? sync.status === 'PENDING' || sync.status === 'RETRYING' : false;
  const headline =
    status === 'BOOKED_VERIFIED' && !bookedVerified ? statusView('booking', 'RECHECKING_SLOT') : statusView('booking', status);

  return {
    ...(base as Journey),
    kind: 'booking',
    booking,
    steps,
    activeStep: active,
    headline,
    approval: approvalId
      ? {
          id: approvalId,
          state: approvalState,
          expiresAt: fromEvents?.expiresAt,
          actionBundle: fromEvents?.actionBundle ?? [],
          recipientLast4: fromEvents?.recipientLast4,
        }
      : undefined,
    executions,
    sync,
    message,
    paidVerified: false,
    bookedVerified,
    slotConflict: conflict ? {alternatives: conflict.alternatives} : undefined,
    notices,
    finished: !callOpen && BOOKING_FINISHED.has(status) && !syncOpen,
  };
}

function deriveCallOnly(input: JourneyInput, base: Partial<Journey>): Journey {
  const events = input.events;
  const call = input.call;
  const ended = [...events].reverse().find(is('call.ended'));
  const callStatus = call?.status ?? (ended ? payload(ended, 'call.ended')!.status : 'IN_PROGRESS');
  const isBooking = events.some((e) => e.type === 'booking.status_changed');
  const steps: JourneyStep[] = [
    callStep(call, events),
    {key: 'proposal', label: 'Proposal'},
    {key: 'approval', label: 'Approval'},
    isBooking ? {key: 'calendar', label: 'Calendar'} : {key: 'checkout', label: 'Checkout link'},
    isBooking ? {key: 'booked', label: 'Booked'} : {key: 'paid', label: 'Paid'},
  ];
  const notices: Notice[] = [];
  let headline: StatusView;
  let active = 0;

  if (callStatus === 'IN_PROGRESS') {
    headline = call ? statusView('callStage', call.stage) : statusView('call', 'IN_PROGRESS');
    if (call?.stage === 'UNAVAILABLE') {
      notices.push({
        key: 'item_unavailable',
        tone: statusView('callStage', 'UNAVAILABLE').tone,
        title: 'An item is unavailable',
        description: 'The agent told the caller and is asking them to choose something else. No order exists yet.',
      });
    }
  } else {
    active = 1;
    const subject = isBooking ? 'booking' : 'order';
    if (callStatus === 'DROPPED') {
      headline = statusView('call', 'DROPPED');
      steps[1].view = view(`No ${subject}`, statusView('call', 'DROPPED').tone);
      notices.push({
        key: 'call_lost',
        tone: statusView('call', 'DROPPED').tone,
        title: `Call lost before the ${subject} was confirmed`,
        description: `No ${subject} and no approval exist, so nothing can be ${isBooking ? 'booked' : 'charged'}. You may want to call the customer back${call?.callerLast4 ? ` (number ending in ${call.callerLast4})` : ''}.`,
      });
    } else if (callStatus === 'FAILED') {
      headline = statusView('call', 'FAILED');
      steps[1].view = view(`No ${subject}`, statusView('call', 'FAILED').tone);
      notices.push({
        key: 'call_failed',
        tone: statusView('call', 'FAILED').tone,
        title: 'The call failed',
        description: `The call ended with an error before a ${subject} was confirmed. Nothing was proposed.`,
      });
    } else {
      headline = {...statusView('call', 'COMPLETED'), label: `Call ended, no ${subject}`};
      steps[1].view = view(`No ${subject}`, statusView('call', 'COMPLETED').tone);
    }
  }

  return {
    ...(base as Journey),
    kind: 'call_only',
    steps,
    activeStep: active,
    headline,
    executions: [],
    paidVerified: false,
    bookedVerified: false,
    notices,
    finished: callStatus !== 'IN_PROGRESS',
  };
}

/** Everything one call journey shows. */
export function deriveJourney(input: JourneyInput): Journey {
  const events = mergeEvents(input.events);
  const started = events.find(is('call.started'));
  const guardrail = events.filter(is('guardrail.refused'));
  const base: Partial<Journey> = {
    callId: input.callId,
    call: input.call,
    events,
    startedAt: input.call?.startedAt ?? started?.occurredAt ?? events[0]?.occurredAt ?? '',
  };
  const normalized = {...input, events};
  const journey = input.order
    ? deriveOrder(normalized, input.order, base)
    : input.booking
      ? deriveBooking(normalized, input.booking, base)
      : deriveCallOnly(normalized, base);
  if (guardrail.length) {
    journey.notices.push({
      key: 'guardrail',
      tone: 'info',
      title: 'The agent refused a request',
      description: `The caller asked for something the agent may not do (${guardrail
        .map((e) => payload(e, 'guardrail.refused')!.rule)
        .join(', ')}). Nothing changed.`,
    });
  }
  return journey;
}

const HALTED = new Set(['UNAVAILABLE', 'RECOVERY_REQUIRED', 'PAYMENT_FAILED', 'CANCELLED', 'SLOT_CONFLICT', 'RETRY_REQUIRED']);

/** True when the approved bundle stopped: steps that have not run will not run on their own. */
export function isHalted(journey: Journey): boolean {
  const status = journey.order?.status ?? journey.booking?.status;
  return !!status && HALTED.has(status);
}

/** The subject ID a timeline names, for calls whose order or booking list has not loaded yet. */
export function subjectIdFromEvents(events: ActivityEvent[]): {orderId?: string; bookingId?: string} {
  for (const event of events) {
    const p = payload(event, 'proposal.created');
    if (p) return p.subjectType === 'order' ? {orderId: p.subjectId} : {bookingId: p.subjectId};
  }
  return {};
}

/** Webhook rejections are not part of a call. Newest first. */
export function rejectedWebhooks(events: ActivityEvent[]): (ActivityEvent & {type: 'webhook.rejected'})[] {
  return mergeEvents(events).filter(is('webhook.rejected')).reverse();
}

/**
 * Who or what the call waits on now, in a few words for the back of the room.
 * `who` is the party ("You", "Square", "The customer"); `what` says what for.
 * Derived only from states already shown, so it never claims more than they do.
 */
export function waitingOn(journey: Journey): {who: string; what: string} {
  const order = journey.order;
  const booking = journey.booking;
  if (journey.approval?.state === 'PENDING') return {who: 'You', what: 'Approve or reject the request.'};
  if (journey.notices.some((n) => n.key.startsWith('review_') || n.key === 'retry' || n.key === 'recovery')) {
    return {who: 'You', what: 'A step needs your review. Read the note below.'};
  }
  if (order) {
    switch (order.status) {
      case 'APPROVED':
      case 'CREATING_CHECKOUT':
        return {who: 'Square (sandbox)', what: 'Creating the checkout link.'};
      case 'PAYMENT_LINK_READY':
        return journey.message?.status === 'SKIPPED' || journey.message?.status === 'NOT_STARTED'
          ? {who: 'The customer', what: 'Paying with the QR code (sandbox).'}
          : {who: 'The message channel', what: 'Sending the link to the customer.'};
      case 'MESSAGE_SENT':
      case 'PAYMENT_PENDING':
        return {who: 'The customer', what: 'Paying with the link (sandbox). Square confirms it.'};
      case 'PAID_VERIFIED':
      case 'FULFILLMENT_READY':
        if (!journey.paidVerified) return {who: 'Square (sandbox)', what: 'Confirming the payment.'};
        if (journey.sync && journey.sync.status !== 'DONE' && journey.sync.status !== 'FAILED') {
          return {who: 'Google Sheets', what: 'Adding the report row. The order is paid.'};
        }
        return {who: 'Nothing', what: 'Paid and verified. Make the order.'};
      case 'PAYMENT_FAILED':
        return {who: 'You', what: 'The payment failed. Call the customer back if you want.'};
      case 'RECOVERY_REQUIRED':
        return {who: 'You', what: 'A step needs your review. Read the note below.'};
      default:
        return {who: 'Nothing', what: 'Closed. Nothing was charged.'};
    }
  }
  if (booking) {
    switch (booking.status) {
      case 'RECHECKING_SLOT':
        return {who: 'Google Calendar', what: 'Checking the slot and creating the event.'};
      case 'BOOKED_VERIFIED':
        if (!journey.bookedVerified) return {who: 'Google Calendar', what: 'Confirming the booking.'};
        if (journey.sync && journey.sync.status !== 'DONE' && journey.sync.status !== 'FAILED') {
          return {who: 'Google Sheets', what: 'Adding the report row. The booking stands.'};
        }
        return {who: 'Nothing', what: 'Booked and verified.'};
      case 'SLOT_CONFLICT':
        return {who: 'You', what: 'The slot was taken. A new time needs a new request.'};
      case 'RETRY_REQUIRED':
        return {who: 'You', what: 'Check Google Calendar. Read the note below.'};
      default:
        return {who: 'Nothing', what: 'Closed. Nothing was booked.'};
    }
  }
  if (!journey.finished) return {who: 'The caller', what: 'The agent is on the call.'};
  return {who: 'Nothing', what: 'The call ended without a proposal.'};
}
