import { z } from 'zod';
import { BookingStatusSchema, OrderStatusSchema } from '../enums';
import { ApprovalIdSchema, BookingIdSchema, BusinessIdSchema, CallIdSchema, OrderIdSchema, ServiceIdSchema } from '../ids';
import { CurrencySchema, E164Schema, IsoDateTimeSchema, MinorAmountSchema, Sha256HashSchema, TimezoneSchema } from '../primitives';
import { CartSchema, QuoteSchema } from './catalog';

export const ContactSchema = z.object({
  name: z.string().min(1),
  messageRecipient: E164Schema,
  messageConsent: z.literal(true), // CONTRACTS 3: must be true
  consentAt: IsoDateTimeSchema,
});
export type Contact = z.infer<typeof ContactSchema>;

export const FulfillmentSchema = z.object({
  type: z.literal('pickup'),
  pickupAt: IsoDateTimeSchema, // UTC, inside verified hours
});
export type Fulfillment = z.infer<typeof FulfillmentSchema>;

export const OrderSchema = z.object({
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
export type Order = z.infer<typeof OrderSchema>;

export const BookingCustomerSchema = z.object({
  name: z.string().min(1),
  messageRecipient: E164Schema,
  messageConsent: z.boolean(),
});
export type BookingCustomer = z.infer<typeof BookingCustomerSchema>;

export const BookingSchema = z.object({
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
export type Booking = z.infer<typeof BookingSchema>;

export const AvailabilitySlotSchema = z.object({
  serviceId: ServiceIdSchema,
  startUtc: IsoDateTimeSchema,
  endUtc: IsoDateTimeSchema,
  timezone: TimezoneSchema,
});
export type AvailabilitySlot = z.infer<typeof AvailabilitySlotSchema>;
