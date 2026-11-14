import {
  BookingApprovalPayloadSchema, OrderApprovalPayloadSchema, FactEditApprovalPayloadSchema, PriceEditApprovalPayloadSchema,
  AvailabilitySlotSchema, cartHash, SLOT_CONFLICT_MAX_ALTERNATIVES,
  type ExecutionActionType, type Order, type Booking,
} from '@abos/contracts';
import { ErrorCodeSchema } from '@abos/contracts';
import type { CalendarResult, CheckoutResult, HandlerContext, StepOutcome, SubjectsPort } from './types.js';

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

const field = (error: unknown, key: string): unknown =>
  typeof error === 'object' && error !== null && key in error ? (error as Record<string, unknown>)[key] : undefined;
const validRefs = (refs: unknown): refs is CheckoutResult => typeof refs === 'object' && refs !== null
  && typeof field(refs, 'squareOrderId') === 'string' && !!field(refs, 'squareOrderId')
  && typeof field(refs, 'paymentLinkId') === 'string' && !!field(refs, 'paymentLinkId')
  && typeof field(refs, 'url') === 'string' && !!field(refs, 'url');

export async function createCheckout(c: HandlerContext): Promise<StepOutcome> {
  const { order, approved } = await orderFor(c);
  if (order.status !== 'APPROVED' && order.status !== 'CREATING_CHECKOUT') return failed('Order is not ready for checkout');
  if (order.status === 'APPROVED') await c.deps.subjects.moveOrder(order.businessId, order.id, 'CREATING_CHECKOUT');
  const key = c.execution.idempotencyKey;
  // A saved Square order ID means a link already exists for this step: read it back, never create again.
  const resuming = !!order.squareOrderId;
  let linkCreated: CheckoutResult | undefined;
  try {
    const refs = resuming
      ? await c.external(() => c.deps.checkout.resumeCheckout({
        squareOrderId: order.squareOrderId!, paymentLinkId: order.squarePaymentLinkId,
        approvedTotalMinor: approved.totalMinor, currency: approved.currency, idempotencyKey: key,
      }))
      : await c.external(() => c.deps.checkout.createCheckout({
        order, idempotencyKey: key, approvedTotalMinor: approved.totalMinor, currency: approved.currency,
        onLinkCreated: async (link) => {
          linkCreated = link;
          await c.deps.subjects.saveCheckoutLink(order.businessId, order.id, c.execution.id, link);
        },
      }));
    if (!validRefs(refs)
      || (resuming && refs.squareOrderId !== order.squareOrderId)
      || (linkCreated && (refs.squareOrderId !== linkCreated.squareOrderId || refs.paymentLinkId !== linkCreated.paymentLinkId))) {
      throw { code: 'INTERNAL', ambiguous: true };
    }
    return { status: 'SUCCEEDED', externalRef: refs.squareOrderId,
      apply: (subjects) => subjects.completeCheckout(order.businessId, order.id, refs) };
  } catch (error) {
    const known = field(error, 'squareOrderId') ?? linkCreated?.squareOrderId ?? order.squareOrderId;
    const ref = typeof known === 'string' && known ? { externalRef: known } : {};
    if (field(error, 'orderState') === 'RECOVERY_REQUIRED' || field(error, 'kind') === 'TOTAL_MISMATCH') {
      return { status: 'FAILED', errorCode: 'INVALID_STATE', reason: 'Checkout total mismatch', ...ref,
        apply: (subjects) => subjects.moveOrder(order.businessId, order.id, 'RECOVERY_REQUIRED') };
    }
    const outcome = field(error, 'outcome');
    // Once a link exists, or on a resume, nothing may create another one: the link is withheld for review.
    if (linkCreated || resuming || outcome === 'unknown' || outcome === 'created_unverified') {
      throw { code: field(error, 'code'), ambiguous: true, ...ref };
    }
    if (outcome === 'not_created') throw { code: field(error, 'code'), requestSent: false, retryable: field(error, 'retryable') !== false };
    throw error;
  }
}

async function sendMessage(c: HandlerContext, subject: Order | Booking, to: string | undefined, body: () => string, checkout: boolean): Promise<StepOutcome> {
  if (!to) return failed('Approved recipient is missing');
  const text = body();
  const result = await c.external(() => c.deps.messages.sendOnce({
    executionId: c.execution.id, workerId: c.deps.workerId, dispatchKey: c.execution.idempotencyKey, to, body: text,
  }));
  const status = typeof result === 'object' && result !== null ? result.status : undefined;
  const review: StepOutcome = { status: 'NEEDS_REVIEW', errorCode: 'INTEGRATION_UNAVAILABLE', continueBundle: true, reason: 'Message outcome is unknown' };
  switch (status) {
    case 'SENT': case 'DELIVERED':
      // The database accepts SUCCEEDED only with the dispatch's provider message ID.
      if (!result.providerMessageId) return review;
      return { status: 'SUCCEEDED', externalRef: result.providerMessageId, ...(checkout ? {
        apply: (subjects: SubjectsPort) => subjects.moveOrder(subject.businessId, subject.id, 'MESSAGE_SENT'),
      } : {}) };
    case 'FAILED': return { status: 'FAILED', errorCode: 'INTEGRATION_UNAVAILABLE', continueBundle: true, reason: 'Message was refused' };
    // The configured channel is qr_only although the approval named a channel: nothing was sent.
    case 'SKIPPED': return { status: 'FAILED', errorCode: 'INTEGRATION_UNAVAILABLE', continueBundle: true, reason: 'Message channel is not available' };
    default: return review; // UNKNOWN, QUEUED or a malformed result: never resent, never marked sent.
  }
}

/** A qr_only message step is created SKIPPED and never claimed. Claiming one means the rows are inconsistent:
 * send nothing and let the bundle go on (a worker cannot finish a step as SKIPPED). */
const qrOnlyClaimed = (): StepOutcome => ({ status: 'FAILED', errorCode: 'INVALID_STATE', continueBundle: true, reason: 'Approved channel is qr_only; nothing was sent' });

export async function sendCheckoutMessage(c: HandlerContext): Promise<StepOutcome> {
  const { order, approved } = await orderFor(c);
  if (approved.messageChannel === 'qr_only') return qrOnlyClaimed();
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
  const conflict = (raw: unknown[]): StepOutcome => {
    const alternatives = raw.slice(0, SLOT_CONFLICT_MAX_ALTERNATIVES).map((s: unknown) => AvailabilitySlotSchema.parse(s));
    return { status: 'FAILED', errorCode: 'SLOT_CONFLICT', reason: 'Approved slot is no longer available',
      apply: (subjects) => subjects.moveBooking(booking.businessId, booking.id, 'SLOT_CONFLICT', alternatives),
      events: [{ id: c.deps.ids.next('evt_'), businessId: booking.businessId, correlationId: c.execution.approvalId,
        actorType: 'system', occurredAt: c.deps.clock.now().toISOString(), type: 'booking.slot_conflict',
        payload: { bookingId: booking.id, approvalId: c.execution.approvalId, startUtc: approved.startUtc, alternatives } }],
    };
  };
  let result: CalendarResult;
  try {
    result = await c.external(() => c.deps.calendar.createEvent({
      bookingId: approved.subjectId, calendarId: approved.calendarId,
      startUtc: approved.startUtc, endUtc: approved.endUtc, idempotencyKey: c.execution.idempotencyKey,
      summary: booking.serviceName, description: `Booking ${approved.subjectId}`,
    }));
  } catch (error) {
    if (field(error, 'code') === 'SLOT_CONFLICT') {
      const raw = field(error, 'alternatives');
      return conflict(Array.isArray(raw) ? raw : []);
    }
    throw error;
  }
  if (typeof result !== 'object' || result === null) throw { code: 'INTERNAL', ambiguous: true };
  if (result.ok === true) {
    if (!result.googleEventId) throw { code: 'INTERNAL', ambiguous: true };
    const eventId = result.googleEventId;
    return { status: 'SUCCEEDED', externalRef: eventId,
      apply: (subjects) => subjects.saveEvent(booking.businessId, booking.id, eventId) };
  }
  if (result.reason === 'SLOT_CONFLICT') return conflict(Array.isArray(result.alternatives) ? result.alternatives : []);
  // The adapter looks the event up by this step's key before every insert, so a retry cannot create a second event.
  const code = ErrorCodeSchema.safeParse(result.reason);
  throw { code: code.success ? code.data : 'INTERNAL', retryable: result.retryable === true, ambiguous: false };
}

export async function sendBookingConfirmation(c: HandlerContext): Promise<StepOutcome> {
  const { booking, approved } = await bookingFor(c);
  if (approved.messageChannel === 'qr_only') return qrOnlyClaimed();
  // verify_booking (0005) stores the event and moves the booking to BOOKED_VERIFIED in the calendar step.
  if (!booking.googleEventId || (booking.status !== 'RECHECKING_SLOT' && booking.status !== 'BOOKED_VERIFIED')) return failed('Verified calendar event is missing');
  return sendMessage(c, booking, approved.messageRecipient, () => c.deps.templates.booking({ booking, approved }), false);
}

export async function recordBooking(c: HandlerContext): Promise<StepOutcome> {
  const { booking } = await bookingFor(c);
  if (!booking.googleEventId || (booking.status !== 'RECHECKING_SLOT' && booking.status !== 'BOOKED_VERIFIED')) return failed('Verified calendar event is missing');
  return { status: 'SUCCEEDED', apply: (subjects) => subjects.moveBooking(booking.businessId, booking.id, 'BOOKED_VERIFIED') };
}

export async function updateFact(c: HandlerContext): Promise<StepOutcome> {
  const approved = FactEditApprovalPayloadSchema.parse(c.material);
  return { status: 'SUCCEEDED', apply: (subjects) => subjects.updateFact(approved.businessId, approved) };
}

export async function updateCatalogPrice(c: HandlerContext): Promise<StepOutcome> {
  const prices = c.deps.prices;
  if (!prices) return { status: 'FAILED', errorCode: 'CAPABILITY_NOT_ALLOWED', reason: 'Price changes are not configured' };
  const approved = PriceEditApprovalPayloadSchema.parse(c.material);
  const r = await c.external(() => prices.update({ executionId: c.execution.id, approvalId: c.execution.approvalId, idempotencyKey: c.execution.idempotencyKey, attempt: c.execution.attempts }));
  switch (r.state) {
    // The provider reference names the variation and the version Square returned after the write.
    case 'SUCCEEDED': return { status: 'SUCCEEDED', externalRef: `${approved.variationId}@${r.squareVersion}` };
    case 'QUEUED': return { status: 'QUEUED', errorCode: r.code, delayMs: 1000 * 2 ** Math.max(0, c.execution.attempts - 1), reason: 'Square refused the write before applying it' };
    case 'FAILED': return { status: 'FAILED', errorCode: r.code, reason: 'Price change failed' };
    default: return { status: 'NEEDS_REVIEW', errorCode: r.code, reason: 'Price change outcome is unknown' };
  }
}
export async function syncCatalog(c: HandlerContext): Promise<StepOutcome> {
  const prices = c.deps.prices;
  if (!prices) return { status: 'FAILED', errorCode: 'CAPABILITY_NOT_ALLOWED', reason: 'Price changes are not configured' };
  const r = await prices.sync({ businessId: c.execution.businessId, attempt: c.execution.attempts });
  if (r.state === 'SUCCEEDED') return { status: 'SUCCEEDED' };
  return r.state === 'QUEUED' ? { status: 'QUEUED', errorCode: r.code, delayMs: 1000, reason: 'Catalog sync will retry' } : { status: 'FAILED', errorCode: r.code, reason: 'Catalog sync failed' };
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
