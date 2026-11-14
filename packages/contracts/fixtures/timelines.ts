// Scripted activity timelines for the mock activity feed (API 7). Each entry is a valid ActivityEvent
// plus its offset in milliseconds from the start of the timeline. Array order is replay order; entries
// that share an offset are written in the same transaction and keep this order.
//
// Order rule where FLOWS lists several events for one step: the specific event first, then the
// `order.status_changed` or `booking.status_changed` it causes, then `execution.succeeded`.
import {
  BUNDLE_ACTIONS,
  type ActivityEvent,
  type ActivityEventPayloads,
  type ActivityEventType,
  type ActorType,
} from '../src/index';
import { approvalBookingConflict, approvalBookingVerified, approvalOrderFulfilled } from './approvals';
import { bookingSlotConflict, bookingVerified } from './bookings';
import { orderFulfilled } from './orders';
import { barberVersionV1, pizzaVersionV2 } from './agents';
import { storedKey } from './hashes';
import { OWNER_USER_ID, addMs, isoUtc, shiftIsoTimes } from './world';

export type TimelineEntry = { offsetMs: number; event: ActivityEvent };

export type ScriptedTimeline = {
  name: string;
  businessId: string;
  correlationId: string;
  /** The `occurredAt` of offset 0 in the stored events. */
  baseStartAt: string;
  entries: TimelineEntry[];
};

function builder(businessId: string, correlationId: string, baseStartAt: string) {
  const entries: TimelineEntry[] = [];
  const add = <T extends ActivityEventType>(id: string, offsetMs: number, type: T, actorType: ActorType, payload: ActivityEventPayloads[T]) => {
    // The test parses every event with ActivityEventSchema, so this assertion is checked.
    const event = { id, businessId, type, correlationId, actorType, occurredAt: addMs(baseStartAt, offsetMs), payload } as unknown as ActivityEvent;
    entries.push({ offsetMs, event });
  };
  return { entries, add };
}

const S = 1000;

// ---- (a) Pizza order, Flow B: call to Sheets sync ----

function buildPizzaTimeline(): ScriptedTimeline {
  const order = orderFulfilled;
  const approval = approvalOrderFulfilled;
  const callId = order.callId;
  const orderId = order.id;
  const approvalId = approval.id;
  const base = '2026-11-14T19:00:00Z';
  const { entries, add } = builder(order.businessId, callId, base);
  const st = (id: string, ms: number, actor: ActorType, from: ActivityEventPayloads['order.status_changed']['from'], to: ActivityEventPayloads['order.status_changed']['to'], withOrder: boolean) => {
    const payload: ActivityEventPayloads['order.status_changed'] = { callId, to };
    if (from !== undefined) payload.from = from;
    if (withOrder) payload.orderId = orderId;
    add(id, ms, 'order.status_changed', actor, payload);
  };

  add('evt_p01', 0, 'call.started', 'provider', { callId, agentId: pizzaVersionV2.agentId, agentVersionId: pizzaVersionV2.id, channel: 'phone', callerLast4: '0123' }); // B2
  st('evt_p02', 0, 'system', undefined, 'CALL_STARTED', false);
  st('evt_p03', 20 * S, 'deployed_agent', 'CALL_STARTED', 'COLLECTING', false); // B6
  st('evt_p04', 95 * S, 'deployed_agent', 'COLLECTING', 'VALIDATING', false); // B8 quote_order
  st('evt_p05', 185 * S, 'deployed_agent', 'VALIDATING', 'CUSTOMER_CONFIRMED', false); // B14
  add('evt_p06', 185 * S, 'proposal.created', 'deployed_agent', { subjectId: orderId, subjectType: 'order', callId, totalMinor: order.totalMinor, currency: order.currency });
  st('evt_p07', 185 * S, 'system', 'CUSTOMER_CONFIRMED', 'AWAITING_OWNER_APPROVAL', true);
  add('evt_p08', 185 * S, 'approval.requested', 'system', {
    approvalId, bundleType: 'order_bundle', subjectId: orderId, actionBundle: [...BUNDLE_ACTIONS.order_bundle],
    expiresAt: approval.expiresAt, totalMinor: order.totalMinor, recipientLast4: '0123',
  });
  add('evt_p09', 215 * S, 'call.ended', 'provider', { callId, status: 'COMPLETED', reason: 'completed', durationSec: 215 }); // B30, caller hung up after the wait script
  add('evt_p10', 250 * S, 'approval.decided', 'owner', { approvalId, subjectId: orderId, decision: 'APPROVED', decidedBy: OWNER_USER_ID }); // B17
  st('evt_p11', 250 * S, 'system', 'AWAITING_OWNER_APPROVAL', 'APPROVED', true);
  add('evt_p12', 251 * S, 'execution.started', 'system', { executionId: 'exe_demo_01_0', approvalId, actionType: 'square.checkout.create', stepIndex: 0, attempt: 1 }); // B18
  st('evt_p13', 251 * S, 'system', 'APPROVED', 'CREATING_CHECKOUT', true);
  add('evt_p14', 253 * S, 'checkout.created', 'system', { orderId, squareOrderId: 'SQ_ORDER_DEMO_01', squarePaymentLinkId: 'SQ_PAYLINK_DEMO_01', totalMinor: order.totalMinor, currency: 'USD', sandbox: true }); // B19
  st('evt_p15', 253 * S, 'system', 'CREATING_CHECKOUT', 'PAYMENT_LINK_READY', true);
  add('evt_p16', 253 * S, 'execution.succeeded', 'system', { executionId: 'exe_demo_01_0', actionType: 'square.checkout.create', externalRef: 'SQ_PAYLINK_DEMO_01' });
  add('evt_p17', 253.5 * S, 'execution.started', 'system', { executionId: 'exe_demo_01_1', approvalId, actionType: 'message.checkout.send', stepIndex: 1, attempt: 1 }); // B21
  add('evt_p18', 255 * S, 'message.sent', 'system', { dispatchId: 'msg_demo_01', subjectId: orderId, channel: 'surge', template: 'checkout_link', recipientLast4: '0123' });
  st('evt_p19', 255 * S, 'system', 'PAYMENT_LINK_READY', 'MESSAGE_SENT', true);
  add('evt_p20', 255 * S, 'execution.succeeded', 'system', { executionId: 'exe_demo_01_1', actionType: 'message.checkout.send', externalRef: 'msg_demo_01' });
  add('evt_p21', 255.5 * S, 'execution.started', 'system', { executionId: 'exe_demo_01_2', approvalId, actionType: 'local.order.record', stepIndex: 2, attempt: 1 }); // B22
  st('evt_p22', 256 * S, 'system', 'MESSAGE_SENT', 'PAYMENT_PENDING', true);
  add('evt_p23', 256 * S, 'execution.succeeded', 'system', { executionId: 'exe_demo_01_2', actionType: 'local.order.record' });
  add('evt_p24', 390 * S, 'payment.verified', 'provider', { orderId, squarePaymentId: 'SQ_PAYMENT_DEMO_01', amountMinor: order.totalMinor, currency: 'USD', sandbox: true }); // B26
  st('evt_p25', 390 * S, 'system', 'PAYMENT_PENDING', 'PAID_VERIFIED', true);
  add('evt_p26', 390 * S, 'sync.queued', 'system', { target: 'google_sheets', syncJobId: 'syn_demo_01', recordType: 'order', recordId: orderId }); // B28
  st('evt_p27', 391 * S, 'system', 'PAID_VERIFIED', 'FULFILLMENT_READY', true);
  add('evt_p28', 394 * S, 'sync.succeeded', 'system', { target: 'google_sheets', syncJobId: 'syn_demo_01', recordType: 'order', recordId: orderId }); // B29

  return { name: 'pizza-order', businessId: order.businessId, correlationId: callId, baseStartAt: base, entries };
}

// ---- (b) Barbershop booking, Flow C: call to booking.verified and the Sheets sync ----

type BookingStatusPayload = ActivityEventPayloads['booking.status_changed'];

function buildBookingTimeline(): ScriptedTimeline {
  const booking = bookingVerified;
  const approval = approvalBookingVerified;
  const callId = booking.callId ?? '';
  const bookingId = booking.id;
  const approvalId = approval.id;
  const base = '2026-11-14T17:30:00Z';
  const googleEventId = storedKey('idem:exe_demo_b02_0');
  const { entries, add } = builder(booking.businessId, callId, base);
  const st = (id: string, ms: number, actor: ActorType, from: BookingStatusPayload['from'], to: BookingStatusPayload['to'], withBooking: boolean) => {
    const payload: BookingStatusPayload = { callId, to };
    if (from !== undefined) payload.from = from;
    if (withBooking) payload.bookingId = bookingId;
    add(id, ms, 'booking.status_changed', actor, payload);
  };

  add('evt_b01', 0, 'call.started', 'provider', { callId, agentId: barberVersionV1.agentId, agentVersionId: barberVersionV1.id, channel: 'phone', callerLast4: '0141' }); // C1 (B2)
  st('evt_b02', 0, 'system', undefined, 'INQUIRY', false);
  st('evt_b03', 40 * S, 'deployed_agent', 'INQUIRY', 'SLOT_SEARCH', false); // C3
  st('evt_b04', 70 * S, 'deployed_agent', 'SLOT_SEARCH', 'PROPOSAL', false); // C4
  st('evt_b05', 120 * S, 'deployed_agent', 'PROPOSAL', 'CUSTOMER_CONFIRMED', false); // C5
  add('evt_b06', 120 * S, 'proposal.created', 'deployed_agent', { subjectId: bookingId, subjectType: 'booking', callId, serviceName: booking.serviceName, startUtc: booking.startUtc });
  st('evt_b07', 120 * S, 'system', 'CUSTOMER_CONFIRMED', 'AWAITING_OWNER_APPROVAL', true);
  add('evt_b08', 120 * S, 'approval.requested', 'system', {
    approvalId, bundleType: 'booking_bundle', subjectId: bookingId, actionBundle: [...BUNDLE_ACTIONS.booking_bundle],
    expiresAt: approval.expiresAt, recipientLast4: '0141',
  });
  add('evt_b09', 150 * S, 'call.ended', 'provider', { callId, status: 'COMPLETED', reason: 'completed', durationSec: 150 });
  add('evt_b10', 180 * S, 'approval.decided', 'owner', { approvalId, subjectId: bookingId, decision: 'APPROVED', decidedBy: OWNER_USER_ID }); // C7
  st('evt_b11', 180 * S, 'system', 'AWAITING_OWNER_APPROVAL', 'RECHECKING_SLOT', true);
  add('evt_b12', 180.5 * S, 'execution.started', 'system', { executionId: 'exe_demo_b02_0', approvalId, actionType: 'calendar.event.create', stepIndex: 0, attempt: 1 }); // C8
  add('evt_b13', 183 * S, 'execution.succeeded', 'system', { executionId: 'exe_demo_b02_0', actionType: 'calendar.event.create', externalRef: googleEventId });
  add('evt_b14', 183.5 * S, 'execution.started', 'system', { executionId: 'exe_demo_b02_1', approvalId, actionType: 'message.booking.confirm', stepIndex: 1, attempt: 1 }); // C9
  add('evt_b15', 185 * S, 'message.sent', 'system', { dispatchId: 'msg_demo_b02', subjectId: bookingId, channel: 'surge', template: 'booking_confirmed', recipientLast4: '0141' });
  add('evt_b16', 185 * S, 'execution.succeeded', 'system', { executionId: 'exe_demo_b02_1', actionType: 'message.booking.confirm', externalRef: 'msg_demo_b02' });
  add('evt_b17', 185.5 * S, 'execution.started', 'system', { executionId: 'exe_demo_b02_2', approvalId, actionType: 'local.booking.record', stepIndex: 2, attempt: 1 }); // C10
  add('evt_b18', 186 * S, 'booking.verified', 'system', { bookingId, googleEventId, serviceName: booking.serviceName, startUtc: booking.startUtc, timezone: booking.timezone });
  st('evt_b19', 186 * S, 'system', 'RECHECKING_SLOT', 'BOOKED_VERIFIED', true);
  add('evt_b20', 186 * S, 'execution.succeeded', 'system', { executionId: 'exe_demo_b02_2', actionType: 'local.booking.record' });
  add('evt_b21', 186 * S, 'sync.queued', 'system', { target: 'google_sheets', syncJobId: 'syn_demo_b02', recordType: 'booking', recordId: bookingId }); // C11
  add('evt_b22', 190 * S, 'sync.succeeded', 'system', { target: 'google_sheets', syncJobId: 'syn_demo_b02', recordType: 'booking', recordId: bookingId });

  return { name: 'barber-booking', businessId: booking.businessId, correlationId: callId, baseStartAt: base, entries };
}

/** The alternatives the mock availability rules give for a Beard trim on 2026-11-17 (C3 rules, at most 3). */
export const slotConflictAlternatives = [
  { startUtc: '2026-11-17T18:30:00Z', endUtc: '2026-11-17T18:45:00Z' },
  { startUtc: '2026-11-17T19:30:00Z', endUtc: '2026-11-17T19:45:00Z' },
  { startUtc: '2026-11-17T19:45:00Z', endUtc: '2026-11-17T20:00:00Z' },
];

// ---- (b2) Short variant: the fresh free/busy read finds the slot busy (FLOWS X1, X2) ----

function buildSlotConflictTimeline(): ScriptedTimeline {
  const booking = bookingSlotConflict;
  const approval = approvalBookingConflict;
  const callId = booking.callId ?? '';
  const bookingId = booking.id;
  const approvalId = approval.id;
  const base = '2026-11-14T17:48:00Z';
  const { entries, add } = builder(booking.businessId, callId, base);

  add('evt_x01', 0, 'call.started', 'provider', { callId, agentId: barberVersionV1.agentId, agentVersionId: barberVersionV1.id, channel: 'phone', callerLast4: '0142' });
  add('evt_x02', 0, 'booking.status_changed', 'system', { callId, to: 'INQUIRY' });
  add('evt_x03', 120 * S, 'proposal.created', 'deployed_agent', { subjectId: bookingId, subjectType: 'booking', callId, serviceName: booking.serviceName, startUtc: booking.startUtc });
  add('evt_x04', 120 * S, 'booking.status_changed', 'system', { bookingId, callId, from: 'CUSTOMER_CONFIRMED', to: 'AWAITING_OWNER_APPROVAL' });
  add('evt_x05', 120 * S, 'approval.requested', 'system', {
    approvalId, bundleType: 'booking_bundle', subjectId: bookingId, actionBundle: [...BUNDLE_ACTIONS.booking_bundle],
    expiresAt: approval.expiresAt, recipientLast4: '0142',
  });
  add('evt_x06', 150 * S, 'call.ended', 'provider', { callId, status: 'COMPLETED', reason: 'completed', durationSec: 150 });
  add('evt_x07', 240 * S, 'approval.decided', 'owner', { approvalId, subjectId: bookingId, decision: 'APPROVED', decidedBy: OWNER_USER_ID });
  add('evt_x08', 240 * S, 'booking.status_changed', 'system', { bookingId, callId, from: 'AWAITING_OWNER_APPROVAL', to: 'RECHECKING_SLOT' });
  add('evt_x09', 240.5 * S, 'execution.started', 'system', { executionId: 'exe_demo_b03_0', approvalId, actionType: 'calendar.event.create', stepIndex: 0, attempt: 1 });
  add('evt_x10', 242 * S, 'booking.slot_conflict', 'system', { bookingId, approvalId, startUtc: booking.startUtc, alternatives: slotConflictAlternatives });
  add('evt_x11', 242 * S, 'booking.status_changed', 'system', { bookingId, callId, from: 'RECHECKING_SLOT', to: 'SLOT_CONFLICT' });
  add('evt_x12', 242 * S, 'execution.failed', 'system', { executionId: 'exe_demo_b03_0', actionType: 'calendar.event.create', errorCode: 'SLOT_CONFLICT', retryable: false, nextStatus: 'FAILED' });

  return { name: 'barber-slot-conflict', businessId: booking.businessId, correlationId: callId, baseStartAt: base, entries };
}

export const pizzaOrderTimeline: ScriptedTimeline = buildPizzaTimeline();
export const barberBookingTimeline: ScriptedTimeline = buildBookingTimeline();
export const barberSlotConflictTimeline: ScriptedTimeline = buildSlotConflictTimeline();
export const timelines: ScriptedTimeline[] = [pizzaOrderTimeline, barberBookingTimeline, barberSlotConflictTimeline];

export type MaterializeOptions = {
  /** Also move timestamps inside payloads (expiresAt, startUtc, alternatives) by the same amount. Default true. */
  shiftPayloadTimes?: boolean;
};

/**
 * Turns offsets into ISO UTC timestamps: `occurredAt` becomes `startAt` plus the entry's offset. By default
 * every ISO timestamp inside a payload moves by the same amount, so an approval's `expiresAt` stays 10
 * minutes after its request. For fast replay, divide offsets yourself before scheduling; this keeps real time.
 */
export function materializeTimeline(timeline: ScriptedTimeline, startAt: Date, options: MaterializeOptions = {}): ActivityEvent[] {
  const start = startAt.getTime();
  const deltaMs = start - Date.parse(timeline.baseStartAt);
  const shift = options.shiftPayloadTimes ?? true;
  return timeline.entries.map(({ offsetMs, event }) => {
    const payload = shift ? shiftIsoTimes(event.payload, deltaMs) : event.payload;
    return { ...event, occurredAt: isoUtc(start + offsetMs), payload } as ActivityEvent;
  });
}

/**
 * Moves a whole timeline so its offset 0 is `startAt`: `baseStartAt`, every `occurredAt` and every payload
 * timestamp shift by the same amount, and offsets stay the same. This helper is for elapsed-time replay.
 */
export function shiftTimeline(timeline: ScriptedTimeline, startAt: Date): ScriptedTimeline {
  return shiftIsoTimes(timeline, startAt.getTime() - Date.parse(timeline.baseStartAt));
}
