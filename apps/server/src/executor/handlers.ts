import {
  BookingApprovalPayloadSchema, OrderApprovalPayloadSchema, FactEditApprovalPayloadSchema,
  AvailabilitySlotSchema, cartHash, SLOT_CONFLICT_MAX_ALTERNATIVES,
  type ExecutionActionType, type Order, type Booking,
} from '@abos/contracts';
import type { HandlerContext, StepOutcome } from './types.js';

const failed = (reason: string): StepOutcome => ({ status: 'FAILED', errorCode: 'INVALID_STATE', reason });

async function orderFor(c: HandlerContext) {
  const approved = OrderApprovalPayloadSchema.parse(c.material);
  const order = await c.deps.subjects.loadOrder(approved.businessId, approved.subjectId);
  if (order.id !== approved.subjectId || order.businessId !== approved.businessId
    || order.cartHash !== approved.cartHash || await cartHash(order.cart) !== approved.cartHash
    || order.totalMinor !== approved.totalMinor || order.currency !== approved.currency
    || Date.parse(order.fulfillment.pickupAt) !== Date.parse(approved.pickupAt)) {
    throw { code: 'PAYLOAD_HASH_MISMATCH', requestSent: false };
  }
  return { order, approved };
}

async function bookingFor(c: HandlerContext) {
  const approved = BookingApprovalPayloadSchema.parse(c.material);
  const booking = await c.deps.subjects.loadBooking(approved.businessId, approved.subjectId);
  if (booking.id !== approved.subjectId || booking.businessId !== approved.businessId
    || booking.serviceId !== approved.serviceId || booking.calendarId !== approved.calendarId
    || Date.parse(booking.startUtc) !== Date.parse(approved.startUtc)
    || Date.parse(booking.endUtc) !== Date.parse(approved.endUtc) || booking.timezone !== approved.timezone) {
    throw { code: 'PAYLOAD_HASH_MISMATCH', requestSent: false };
  }
  return { booking, approved };
}

export async function createCheckout(c: HandlerContext): Promise<StepOutcome> {
  const { order, approved } = await orderFor(c);
  if (order.status !== 'APPROVED' && order.status !== 'CREATING_CHECKOUT') return failed('Order is not ready for checkout');
  if (order.status === 'APPROVED') await c.deps.subjects.moveOrder(order.businessId, order.id, 'CREATING_CHECKOUT');
  try {
    const refs = await c.external(() => c.deps.checkout.createCheckout({
      order, idempotencyKey: c.execution.idempotencyKey,
      approvedTotalMinor: approved.totalMinor, currency: approved.currency,
    }));
    if (!refs.squareOrderId || !refs.paymentLinkId || !refs.url) throw new Error('Missing checkout references');
    return { status: 'SUCCEEDED', externalRef: refs.paymentLinkId, apply: async (subjects) => {
      await subjects.saveCheckout(order.businessId, order.id, refs);
      await subjects.moveOrder(order.businessId, order.id, 'PAYMENT_LINK_READY');
    } };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'kind' in error && error.kind === 'TOTAL_MISMATCH') {
      return { status: 'FAILED', errorCode: 'INVALID_STATE', reason: 'Checkout total mismatch',
        apply: (subjects) => subjects.moveOrder(order.businessId, order.id, 'RECOVERY_REQUIRED') };
    }
    throw error;
  }
}

async function sendMessage(c: HandlerContext, subject: Order | Booking, to: string | undefined, body: () => string, checkout: boolean): Promise<StepOutcome> {
  if (!to) return failed('Approved recipient is missing');
  const text = body();
  const result = await c.external(() => c.deps.messages.sendOnce({ dispatchKey: c.execution.idempotencyKey, to, body: text }));
  switch (result) {
    case 'SENT': return { status: 'SUCCEEDED', ...(checkout ? {
      apply: (subjects) => subjects.moveOrder(subject.businessId, subject.id, 'MESSAGE_SENT'),
    } : {}) };
    case 'skipped': return { status: 'SKIPPED', continueBundle: true };
    case 'FAILED': return { status: 'FAILED', errorCode: 'INTEGRATION_UNAVAILABLE', continueBundle: true, reason: 'Message was refused' };
    case 'UNKNOWN': return { status: 'NEEDS_REVIEW', errorCode: 'INTEGRATION_UNAVAILABLE', continueBundle: true, reason: 'Message outcome is unknown' };
    default: throw new Error('Invalid message result');
  }
}

export async function sendCheckoutMessage(c: HandlerContext): Promise<StepOutcome> {
  const { order, approved } = await orderFor(c);
  if (approved.messageChannel === 'qr_only') return { status: 'SKIPPED', continueBundle: true };
  if (order.status !== 'PAYMENT_LINK_READY' || !order.checkoutUrl) return failed('Verified checkout link is missing');
  return sendMessage(c, order, approved.messageRecipient,
    () => c.deps.templates.checkout({ order, approved, url: order.checkoutUrl! }), true);
}

export async function recordOrder(c: HandlerContext): Promise<StepOutcome> {
  const { order } = await orderFor(c);
  if (!order.squareOrderId || !order.squarePaymentLinkId || !order.checkoutUrl
    || (order.status !== 'PAYMENT_LINK_READY' && order.status !== 'MESSAGE_SENT')) return failed('Verified checkout references are missing');
  return { status: 'SUCCEEDED', apply: (subjects) => subjects.moveOrder(order.businessId, order.id, 'PAYMENT_PENDING') };
}

export async function createCalendarEvent(c: HandlerContext): Promise<StepOutcome> {
  const { booking, approved } = await bookingFor(c);
  if (booking.status !== 'RECHECKING_SLOT') return failed('Booking does not hold the slot lock');
  try {
    const event = await c.external(() => c.deps.calendar.createEvent({
      bookingId: approved.subjectId, calendarId: approved.calendarId,
      startUtc: approved.startUtc, endUtc: approved.endUtc,
      summary: booking.serviceName, description: `Booking ${approved.subjectId}`,
    }));
    if (!event.id) throw new Error('Missing event id');
    return { status: 'SUCCEEDED', externalRef: event.id,
      apply: (subjects) => subjects.saveEvent(booking.businessId, booking.id, event.id) };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'SLOT_CONFLICT') {
      const raw = 'alternatives' in error && Array.isArray(error.alternatives) ? error.alternatives : [];
      const alternatives = raw.slice(0, SLOT_CONFLICT_MAX_ALTERNATIVES).map((s: unknown) => AvailabilitySlotSchema.parse(s));
      return { status: 'FAILED', errorCode: 'SLOT_CONFLICT', reason: 'Approved slot is no longer available',
        apply: (subjects) => subjects.moveBooking(booking.businessId, booking.id, 'SLOT_CONFLICT', alternatives),
        events: [{ id: c.deps.ids.next('evt_'), businessId: booking.businessId, correlationId: c.execution.approvalId,
          actorType: 'system', occurredAt: c.deps.clock.now().toISOString(), type: 'booking.slot_conflict',
          payload: { bookingId: booking.id, approvalId: c.execution.approvalId, startUtc: approved.startUtc, alternatives } }],
      };
    }
    throw error;
  }
}

export async function sendBookingConfirmation(c: HandlerContext): Promise<StepOutcome> {
  const { booking, approved } = await bookingFor(c);
  if (approved.messageChannel === 'qr_only') return { status: 'SKIPPED', continueBundle: true };
  if (!booking.googleEventId || booking.status !== 'RECHECKING_SLOT') return failed('Verified calendar event is missing');
  return sendMessage(c, booking, approved.messageRecipient, () => c.deps.templates.booking({ booking, approved }), false);
}

export async function recordBooking(c: HandlerContext): Promise<StepOutcome> {
  const { booking } = await bookingFor(c);
  if (!booking.googleEventId || booking.status !== 'RECHECKING_SLOT') return failed('Verified calendar event is missing');
  return { status: 'SUCCEEDED', apply: (subjects) => subjects.moveBooking(booking.businessId, booking.id, 'BOOKED_VERIFIED') };
}

export async function updateFact(c: HandlerContext): Promise<StepOutcome> {
  const approved = FactEditApprovalPayloadSchema.parse(c.material);
  return { status: 'SUCCEEDED', apply: (subjects) => subjects.updateFact(approved.businessId, approved) };
}

export async function updateCatalogPrice(_c: HandlerContext): Promise<StepOutcome> {
  return { status: 'FAILED', errorCode: 'CAPABILITY_NOT_ALLOWED', reason: 'square.catalog.price.update is not implemented' };
}
export async function syncCatalog(_c: HandlerContext): Promise<StepOutcome> {
  return { status: 'FAILED', errorCode: 'CAPABILITY_NOT_ALLOWED', reason: 'local.catalog.sync is not implemented' };
}

export const handlers = {
  'square.checkout.create': createCheckout,
  'message.checkout.send': sendCheckoutMessage,
  'local.order.record': recordOrder,
  'calendar.event.create': createCalendarEvent,
  'message.booking.confirm': sendBookingConfirmation,
  'local.booking.record': recordBooking,
  'local.fact.update': updateFact,
  'square.catalog.price.update': updateCatalogPrice,
  'local.catalog.sync': syncCatalog,
} satisfies Record<ExecutionActionType, (context: HandlerContext) => Promise<StepOutcome>>;
