// Approval requests, one or more per bundle type, pending and decided.
// `expiresAt` is always `createdAt` plus 10 minutes (SPEC 2.9). Each `payloadHash` is the real hash of
// its payload; the fixture test recomputes it. A payload holds exactly the material fields (CONTRACTS 4),
// and every payload timestamp is in `toISOString()` form (`toCanonicalTimestamp`).
import {
  APPROVAL_EXPIRY_MS,
  BUNDLE_ACTIONS,
  PIZZA_BUSINESS_ID,
  toCanonicalTimestamp,
  type ApprovalRequest,
  type ApprovalState,
  type Booking,
  type BookingApprovalRequest,
  type FactEditApprovalRequest,
  type MessageChannelSetting,
  type Order,
  type OrderApprovalRequest,
  type PriceEditApprovalRequest,
} from '../src/index';
import { SQ, pizzaCatalogRows } from './catalog';
import { calls } from './calls';
import { fridayHoursDraftFact, pizzaHours } from './facts';
import { storedHash } from './hashes';
import {
  orderApprovalExpired,
  orderAwaitingApproval,
  orderFulfilled,
  orderPaid,
  orderPaymentFailed,
  orderPaymentPending,
  orderRejected,
  orderQrOnly,
} from './orders';
import { bookingAwaitingApproval, bookingSlotConflict, bookingVerified, bookingRejected, bookingExpired, bookingRetryRequired, bookingMessageUnknown } from './bookings';
import { OWNER_USER_ID, addMs, shiftIsoTimes } from './world';

type Decision = { state: ApprovalState; decidedAt?: string };

/** `decidedBy` only for APPROVED or REJECTED; `decidedAt` for every state except PENDING (EXPIRED: the expiry time). */
function decisionFields(d: Decision, expiresAt: string): { state: ApprovalState; decidedBy?: string; decidedAt?: string } {
  if (d.state === 'APPROVED' || d.state === 'REJECTED') return { state: d.state, decidedBy: OWNER_USER_ID, decidedAt: d.decidedAt ?? expiresAt };
  if (d.state === 'EXPIRED') return { state: d.state, decidedAt: d.decidedAt ?? expiresAt };
  return { state: d.state };
}

function agentVersionOfCall(callId: string | undefined): string {
  const c = calls.find((x) => x.id === callId);
  if (c === undefined) throw new Error(`fixture approval: unknown call ${String(callId)}`);
  return c.agentVersionId;
}

function orderApproval(order: Order, channel: MessageChannelSetting, d: Decision): OrderApprovalRequest {
  const id = order.approvalId ?? '';
  const createdAt = order.createdAt;
  const expiresAt = toCanonicalTimestamp(addMs(createdAt, APPROVAL_EXPIRY_MS));
  const actionBundle = [...BUNDLE_ACTIONS.order_bundle] as OrderApprovalRequest['actionBundle'];
  return {
    id,
    businessId: order.businessId,
    actorType: 'deployed_agent',
    bundleType: 'order_bundle',
    actionBundle,
    subjectId: order.id,
    payload: {
      businessId: order.businessId,
      subjectId: order.id,
      agentVersionId: agentVersionOfCall(order.callId),
      cartHash: order.cartHash,
      totalMinor: order.totalMinor,
      currency: order.currency,
      pickupAt: toCanonicalTimestamp(order.fulfillment.pickupAt),
      ...(order.contact.messageRecipient === undefined ? {} : { messageRecipient: order.contact.messageRecipient }),
      messageChannel: channel,
      actionBundle,
      expiresAt,
    },
    payloadHash: storedHash(`payload:${id}`),
    expiresAt,
    createdAt,
    ...decisionFields(d, expiresAt),
  };
}

function bookingApproval(booking: Booking, channel: MessageChannelSetting, d: Decision): BookingApprovalRequest {
  const id = booking.approvalId ?? '';
  const createdAt = booking.createdAt;
  const expiresAt = toCanonicalTimestamp(addMs(createdAt, APPROVAL_EXPIRY_MS));
  const actionBundle = [...BUNDLE_ACTIONS.booking_bundle] as BookingApprovalRequest['actionBundle'];
  return {
    id,
    businessId: booking.businessId,
    actorType: 'deployed_agent',
    bundleType: 'booking_bundle',
    actionBundle,
    subjectId: booking.id,
    payload: {
      businessId: booking.businessId,
      subjectId: booking.id,
      agentVersionId: agentVersionOfCall(booking.callId),
      serviceId: booking.serviceId,
      calendarId: booking.calendarId,
      startUtc: toCanonicalTimestamp(booking.startUtc),
      endUtc: toCanonicalTimestamp(booking.endUtc),
      timezone: booking.timezone,
      ...(booking.customer.messageRecipient === undefined ? {} : { messageRecipient: booking.customer.messageRecipient }),
      messageChannel: channel,
      actionBundle,
      expiresAt,
    },
    payloadHash: storedHash(`payload:${id}`),
    expiresAt,
    createdAt,
    ...decisionFields(d, expiresAt),
  };
}

// ---- Order bundles ----
export const approvalOrderFulfilled = orderApproval(orderFulfilled, 'surge', { state: 'APPROVED', decidedAt: '2026-11-14T19:04:10Z' });
export const approvalOrderPaid = orderApproval(orderPaid, 'qr_only', { state: 'APPROVED', decidedAt: '2026-11-14T19:22:40Z' });
export const approvalOrderPaymentPending = orderApproval(orderPaymentPending, 'surge', { state: 'APPROVED', decidedAt: '2026-11-14T19:43:30Z' });
/** The pending order bundle on the Approvals screen. */
export const approvalOrderPending = orderApproval(orderAwaitingApproval, 'surge', { state: 'PENDING' });
export const approvalOrderRejected = orderApproval(orderRejected, 'surge', { state: 'REJECTED', decidedAt: '2026-11-14T19:53:00Z' });
export const approvalOrderExpired = orderApproval(orderApprovalExpired, 'surge', { state: 'EXPIRED' });
export const approvalOrderPaymentFailed = orderApproval(orderPaymentFailed, 'surge', { state: 'APPROVED', decidedAt: '2026-11-14T20:02:30Z' });

export const approvalOrderQrOnly = orderApproval(orderQrOnly, 'qr_only', { state: 'PENDING' });

// ---- Booking bundles ----
export const approvalBookingPending = bookingApproval(bookingAwaitingApproval, 'surge', { state: 'PENDING' });
export const approvalBookingVerified = bookingApproval(bookingVerified, 'surge', { state: 'APPROVED', decidedAt: '2026-11-14T17:33:00Z' });
export const approvalBookingConflict = bookingApproval(bookingSlotConflict, 'surge', { state: 'APPROVED', decidedAt: '2026-11-14T17:52:00Z' });

// ---- Owner edits (P-09) ----
const FACT_EDIT_CREATED_AT = '2026-11-14T20:28:00Z';
const FACT_EDIT_EXPIRES_AT = toCanonicalTimestamp(addMs(FACT_EDIT_CREATED_AT, APPROVAL_EXPIRY_MS));

/** Flow D: Friday close 22:00 to 23:00, waiting for the owner to confirm. */
export const approvalFactEditPending = {
  id: 'apv_demo_f01',
  businessId: PIZZA_BUSINESS_ID,
  actorType: 'owner',
  bundleType: 'fact_edit',
  actionBundle: [...BUNDLE_ACTIONS.fact_edit],
  subjectId: fridayHoursDraftFact.id,
  payload: {
    businessId: PIZZA_BUSINESS_ID,
    subjectId: fridayHoursDraftFact.id,
    kind: 'hours',
    key: 'fri',
    fromVersion: 1,
    before: pizzaHours.fri,
    after: fridayHoursDraftFact.value,
    actionBundle: [...BUNDLE_ACTIONS.fact_edit],
    expiresAt: FACT_EDIT_EXPIRES_AT,
  },
  payloadHash: storedHash('payload:apv_demo_f01'),
  state: 'PENDING',
  expiresAt: FACT_EDIT_EXPIRES_AT,
  createdAt: FACT_EDIT_CREATED_AT,
} satisfies FactEditApprovalRequest;

const PRICE_EDIT_CREATED_AT = '2026-11-14T20:29:00Z';
const PRICE_EDIT_EXPIRES_AT = toCanonicalTimestamp(addMs(PRICE_EDIT_CREATED_AT, APPROVAL_EXPIRY_MS));
const largePepperoniRow = pizzaCatalogRows.find((r) => r.squareVariationId === SQ.varPepperoniLarge);

/** Flow E (SHOULD): Large Pepperoni 2200 to 1900 in Square sandbox. */
export const approvalPriceEditPending = {
  id: 'apv_demo_p01',
  businessId: PIZZA_BUSINESS_ID,
  actorType: 'owner',
  bundleType: 'price_edit',
  actionBundle: [...BUNDLE_ACTIONS.price_edit],
  subjectId: largePepperoniRow?.id ?? 'cat_pep_lg',
  payload: {
    businessId: PIZZA_BUSINESS_ID,
    subjectId: largePepperoniRow?.id ?? 'cat_pep_lg',
    squareItemId: SQ.itemPepperoni,
    variationId: SQ.varPepperoniLarge,
    fromPriceMinor: largePepperoniRow?.priceMinor ?? 2200,
    newPriceMinor: 1900,
    currency: 'USD',
    squareVersion: largePepperoniRow?.squareVariationVersion ?? 3,
    actionBundle: [...BUNDLE_ACTIONS.price_edit],
    expiresAt: PRICE_EDIT_EXPIRES_AT,
  },
  payloadHash: storedHash('payload:apv_demo_p01'),
  state: 'PENDING',
  expiresAt: PRICE_EDIT_EXPIRES_AT,
  createdAt: PRICE_EDIT_CREATED_AT,
} satisfies PriceEditApprovalRequest;

export const approvalBookingRejected = bookingApproval(bookingRejected, 'surge', { state: 'REJECTED', decidedAt: '2026-11-14T19:01:00Z' });
export const approvalBookingExpired = bookingApproval(bookingExpired, 'surge', { state: 'EXPIRED' });
export const approvalBookingRetry = bookingApproval(bookingRetryRequired, 'surge', { state: 'APPROVED', decidedAt: '2026-11-14T19:01:00Z' });
export const approvalBookingUnknown = bookingApproval(bookingMessageUnknown, 'surge', { state: 'APPROVED', decidedAt: '2026-11-14T17:33:00Z' });

function decidedFactEdit(id: string, state: 'APPROVED' | 'REJECTED' | 'EXPIRED'): FactEditApprovalRequest {
  const base = shiftIsoTimes(approvalFactEditPending, -60 * 60 * 1000);
  return { ...base, id, payloadHash: storedHash(`payload:${id}`), ...decisionFields({ state, decidedAt: state === 'EXPIRED' ? base.expiresAt : addMs(base.createdAt, 60000) }, base.expiresAt) };
}
export const approvalFactEditApproved = decidedFactEdit('apv_demo_f88a', 'APPROVED');
export const approvalFactEditRejected = decidedFactEdit('apv_demo_f88r', 'REJECTED');
export const approvalFactEditExpired = decidedFactEdit('apv_demo_f88e', 'EXPIRED');
const pastPriceEdit = shiftIsoTimes(approvalPriceEditPending, -60 * 60 * 1000);
export const approvalPriceEditRejected: PriceEditApprovalRequest = { ...pastPriceEdit, id: 'apv_demo_p88r', state: 'REJECTED', decidedBy: OWNER_USER_ID, decidedAt: addMs(pastPriceEdit.createdAt, 60000), payloadHash: storedHash('payload:apv_demo_p88r') };

export const approvals: ApprovalRequest[] = [
  approvalBookingRejected, approvalBookingExpired, approvalBookingRetry, approvalBookingUnknown,
  approvalFactEditApproved, approvalFactEditRejected, approvalFactEditExpired, approvalPriceEditRejected,
  approvalOrderQrOnly,
  approvalPriceEditPending,
  approvalFactEditPending,
  approvalOrderPending,
  approvalBookingPending,
  approvalOrderPaymentFailed,
  approvalOrderRejected,
  approvalOrderPaymentPending,
  approvalOrderPaid,
  approvalOrderExpired,
  approvalOrderFulfilled,
  approvalBookingConflict,
  approvalBookingVerified,
];

export const pendingApprovals: ApprovalRequest[] = approvals.filter((a) => a.state === 'PENDING');
