import { z } from 'zod';
import { BookingStatusSchema, OrderStatusSchema } from '../enums';
import { ApprovalIdSchema, BookingIdSchema, BusinessIdSchema, CallIdSchema, OrderIdSchema, ServiceIdSchema } from '../ids';
import { CurrencySchema, E164Schema, IsoDateTimeSchema, MinorAmountSchema, Sha256HashSchema, TimezoneSchema, msBetween } from '../primitives';
import { CartSchema, QuoteSchema } from './catalog';

/** Shared by contacts, customers and approval payloads (whose consent metadata is optional). */
export function checkMessageConsent(value: { messageConsent?: boolean | undefined; messageRecipient?: string | undefined }, ctx: z.RefinementCtx): void {
  if (value.messageConsent === true && value.messageRecipient === undefined) {
    ctx.addIssue({ code: 'custom', path: ['messageRecipient'], message: 'Consent requires a messageRecipient' });
  }
  if (value.messageConsent === false && value.messageRecipient !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['messageRecipient'], message: 'messageRecipient must be absent without consent' });
  }
}

export const ContactBaseSchema = z.object({
  name: z.string().min(1),
  messageRecipient: E164Schema.optional(),
  messageConsent: z.boolean(),
  consentAt: IsoDateTimeSchema.optional(),
});
export const ContactSchema = ContactBaseSchema.superRefine((contact, ctx) => {
  checkMessageConsent(contact, ctx);
  if (contact.messageConsent && contact.consentAt === undefined) {
    ctx.addIssue({ code: 'custom', path: ['consentAt'], message: 'Consent requires consentAt' });
  }
});
export type Contact = z.infer<typeof ContactSchema>;

export const FulfillmentSchema = z.object({
  type: z.literal('pickup'),
  pickupAt: IsoDateTimeSchema, // UTC, inside verified hours
});
export type Fulfillment = z.infer<typeof FulfillmentSchema>;

/** The fields without cross-field checks, for `.extend()`, `.pick()` and `.partial()`. */
export const OrderBaseSchema = z.object({
  id: OrderIdSchema,
  businessId: BusinessIdSchema,
  callId: CallIdSchema,
  status: OrderStatusSchema,
  cart: CartSchema,
  cartHash: Sha256HashSchema,
  quote: QuoteSchema,
  totalMinor: MinorAmountSchema, // SPEC 2.9: copied from the quote when the proposal is stored
  currency: CurrencySchema,
  contact: ContactSchema,
  fulfillment: FulfillmentSchema,
  approvalId: ApprovalIdSchema.optional(),
  squareOrderId: z.string().optional(),
  squarePaymentLinkId: z.string().optional(),
  checkoutUrl: z.url().optional(),
  squarePaymentId: z.string().optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

// DATA-MODEL 2.15 checks: these statuses need the Square link fields; the paid ones also need the payment id.
const LINK_STATUSES = ['PAYMENT_LINK_READY', 'MESSAGE_SENT', 'PAYMENT_PENDING', 'PAID_VERIFIED', 'FULFILLMENT_READY'] as const;
const PAID_STATUSES = ['PAID_VERIFIED', 'FULFILLMENT_READY'] as const;

export const OrderSchema = OrderBaseSchema.superRefine((o, ctx) => {
  // SPEC 2.9 "Order totals": totalMinor and currency are copied from the quote; the quote is for this cart.
  if (o.totalMinor !== o.quote.totalMinor) ctx.addIssue({ code: 'custom', path: ['totalMinor'], message: 'totalMinor must equal quote.totalMinor' });
  if (o.currency !== o.quote.currency) ctx.addIssue({ code: 'custom', path: ['currency'], message: 'currency must equal quote.currency' });
  if (o.cartHash !== o.quote.cartHash) ctx.addIssue({ code: 'custom', path: ['cartHash'], message: 'cartHash must equal quote.cartHash' });
  if ((LINK_STATUSES as readonly string[]).includes(o.status) && (o.squareOrderId === undefined || o.squarePaymentLinkId === undefined || o.checkoutUrl === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['status'], message: `${o.status} needs squareOrderId, squarePaymentLinkId and checkoutUrl` });
  }
  if ((PAID_STATUSES as readonly string[]).includes(o.status) && o.squarePaymentId === undefined) {
    ctx.addIssue({ code: 'custom', path: ['squarePaymentId'], message: `${o.status} needs squarePaymentId (SPEC 1.3 rule 5)` });
  }
});
export type Order = z.infer<typeof OrderSchema>;

export const BookingCustomerBaseSchema = z.object({
  name: z.string().min(1),
  messageRecipient: E164Schema.optional(),
  messageConsent: z.boolean(),
});
export const BookingCustomerSchema = BookingCustomerBaseSchema.superRefine(checkMessageConsent);
export type BookingCustomer = z.infer<typeof BookingCustomerSchema>;

export const BookingBaseSchema = z.object({
  id: BookingIdSchema,
  businessId: BusinessIdSchema,
  callId: CallIdSchema.optional(),
  status: BookingStatusSchema,
  serviceId: ServiceIdSchema,
  serviceName: z.string(),
  startUtc: IsoDateTimeSchema,
  endUtc: IsoDateTimeSchema,
  timezone: TimezoneSchema,
  calendarId: z.string().min(1), // SPEC 2.9: the no-overlap rule is per calendar
  customer: BookingCustomerSchema,
  approvalId: ApprovalIdSchema.optional(),
  googleEventId: z.string().optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export const BookingSchema = BookingBaseSchema.superRefine((b, ctx) => {
  if (msBetween(b.startUtc, b.endUtc) <= 0) ctx.addIssue({ code: 'custom', path: ['endUtc'], message: 'endUtc must be after startUtc' });
  // DATA-MODEL 2.16: BOOKED_VERIFIED needs the Google event id.
  if (b.status === 'BOOKED_VERIFIED' && b.googleEventId === undefined) {
    ctx.addIssue({ code: 'custom', path: ['googleEventId'], message: 'BOOKED_VERIFIED needs googleEventId' });
  }
});
export type Booking = z.infer<typeof BookingSchema>;

export const AvailabilitySlotSchema = z
  .object({
    serviceId: ServiceIdSchema,
    startUtc: IsoDateTimeSchema,
    endUtc: IsoDateTimeSchema,
    timezone: TimezoneSchema,
  })
  .refine((s) => msBetween(s.startUtc, s.endUtc) > 0, { path: ['endUtc'], message: 'endUtc must be after startUtc' });
export type AvailabilitySlot = z.infer<typeof AvailabilitySlotSchema>;
