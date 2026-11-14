import { z } from 'zod';
import { ApprovalStateSchema, FactKindSchema, MessageChannelSettingSchema } from '../enums';
import {
  AgentVersionIdSchema,
  ApprovalIdSchema,
  BookingIdSchema,
  BusinessIdSchema,
  CatalogItemRowIdSchema,
  FactIdSchema,
  OrderIdSchema,
  ServiceIdSchema,
  UserIdSchema,
} from '../ids';
import {
  CurrencySchema,
  E164Schema,
  IsoDateTimeSchema,
  JsonValueSchema,
  MinorAmountSchema,
  Sha256HashSchema,
  TimezoneSchema,
  msBetween,
} from '../primitives';
import { APPROVAL_EXPIRY_MS } from '../constants';

// SPEC 2.3: each bundle type carries exactly its own ordered action list.
export const OrderBundleActionsSchema = z.tuple([
  z.literal('square.checkout.create'),
  z.literal('message.checkout.send'),
  z.literal('local.order.record'),
  z.literal('sheets.order.append'),
]);
export const BookingBundleActionsSchema = z.tuple([
  z.literal('calendar.event.create'),
  z.literal('message.booking.confirm'),
  z.literal('local.booking.record'),
  z.literal('sheets.booking.append'),
]);
export const FactEditActionsSchema = z.tuple([z.literal('local.fact.update')]);
export const PriceEditActionsSchema = z.tuple([z.literal('square.catalog.price.update'), z.literal('local.catalog.sync')]);

// CONTRACTS 4: the payload holds only material fields, all required, all hashed.
export const OrderApprovalPayloadSchema = z.object({
  businessId: BusinessIdSchema,
  subjectId: OrderIdSchema,
  agentVersionId: AgentVersionIdSchema, // always from the calls row (SPEC 2.9)
  cartHash: Sha256HashSchema,
  totalMinor: MinorAmountSchema,
  currency: CurrencySchema,
  pickupAt: IsoDateTimeSchema,
  messageRecipient: E164Schema,
  messageChannel: MessageChannelSettingSchema, // the server's MESSAGE_CHANNEL at proposal time
  actionBundle: OrderBundleActionsSchema,
  expiresAt: IsoDateTimeSchema,
});
export type OrderApprovalPayload = z.infer<typeof OrderApprovalPayloadSchema>;

export const BookingApprovalPayloadSchema = z.object({
  businessId: BusinessIdSchema,
  subjectId: BookingIdSchema,
  agentVersionId: AgentVersionIdSchema,
  serviceId: ServiceIdSchema,
  calendarId: z.string().min(1),
  startUtc: IsoDateTimeSchema,
  endUtc: IsoDateTimeSchema,
  timezone: TimezoneSchema,
  messageRecipient: E164Schema,
  messageChannel: MessageChannelSettingSchema,
  actionBundle: BookingBundleActionsSchema,
  expiresAt: IsoDateTimeSchema,
}).refine((p) => msBetween(p.startUtc, p.endUtc) > 0, { path: ['endUtc'], message: 'endUtc must be after startUtc' });
export type BookingApprovalPayload = z.infer<typeof BookingApprovalPayloadSchema>;

export const FactEditApprovalPayloadSchema = z.object({
  businessId: BusinessIdSchema,
  subjectId: FactIdSchema, // the new draft fact
  kind: FactKindSchema,
  key: z.string().min(1),
  fromVersion: z.int().min(0),
  before: JsonValueSchema, // null when the fact is new
  after: JsonValueSchema,
  actionBundle: FactEditActionsSchema,
  expiresAt: IsoDateTimeSchema,
});
export type FactEditApprovalPayload = z.infer<typeof FactEditApprovalPayloadSchema>;

export const PriceEditApprovalPayloadSchema = z.object({
  businessId: BusinessIdSchema,
  subjectId: CatalogItemRowIdSchema, // the cat_ id
  squareItemId: z.string().min(1),
  variationId: z.string().min(1),
  fromPriceMinor: MinorAmountSchema,
  newPriceMinor: MinorAmountSchema,
  currency: CurrencySchema,
  squareVersion: z.int().min(0),
  actionBundle: PriceEditActionsSchema,
  expiresAt: IsoDateTimeSchema,
});
export type PriceEditApprovalPayload = z.infer<typeof PriceEditApprovalPayloadSchema>;

export const ApprovalPayloadSchema = z.union([
  OrderApprovalPayloadSchema,
  BookingApprovalPayloadSchema,
  FactEditApprovalPayloadSchema,
  PriceEditApprovalPayloadSchema,
]);
export type ApprovalPayload = z.infer<typeof ApprovalPayloadSchema>;

const approvalBase = {
  id: ApprovalIdSchema, // apv_mock_ ids from the mock toolset also match
  businessId: BusinessIdSchema,
  payloadHash: Sha256HashSchema,
  state: ApprovalStateSchema,
  expiresAt: IsoDateTimeSchema, // SPEC 2.9: createdAt plus 10 minutes
  decidedBy: UserIdSchema.optional(),
  decidedAt: IsoDateTimeSchema.optional(),
  createdAt: IsoDateTimeSchema,
};

export const OrderApprovalRequestBaseSchema = z.object({
  ...approvalBase,
  actorType: z.literal('deployed_agent'),
  bundleType: z.literal('order_bundle'),
  actionBundle: OrderBundleActionsSchema,
  subjectId: OrderIdSchema,
  payload: OrderApprovalPayloadSchema,
});
export const BookingApprovalRequestBaseSchema = z.object({
  ...approvalBase,
  actorType: z.literal('deployed_agent'),
  bundleType: z.literal('booking_bundle'),
  actionBundle: BookingBundleActionsSchema,
  subjectId: BookingIdSchema,
  payload: BookingApprovalPayloadSchema,
});
// P-09: owner edits reuse the approval table with actorType owner.
export const FactEditApprovalRequestBaseSchema = z.object({
  ...approvalBase,
  actorType: z.literal('owner'),
  bundleType: z.literal('fact_edit'),
  actionBundle: FactEditActionsSchema,
  subjectId: FactIdSchema,
  payload: FactEditApprovalPayloadSchema,
});
export const PriceEditApprovalRequestBaseSchema = z.object({
  ...approvalBase,
  actorType: z.literal('owner'),
  bundleType: z.literal('price_edit'),
  actionBundle: PriceEditActionsSchema,
  subjectId: CatalogItemRowIdSchema,
  payload: PriceEditApprovalPayloadSchema,
});
type ApprovalRequestShape = {
  businessId: string;
  subjectId: string;
  actionBundle: readonly string[];
  expiresAt: string;
  createdAt: string;
  state: string;
  decidedBy?: string | undefined;
  decidedAt?: string | undefined;
  payload: { businessId: string; subjectId: string; actionBundle: readonly string[]; expiresAt: string };
};

/** Cross-field rules shared by the four request variants. */
function checkApprovalRequest(a: ApprovalRequestShape, ctx: z.RefinementCtx): void {
  // The outer copies must be the fields that are hashed, or the UI could show one subject while the hash covers another.
  for (const field of ['businessId', 'subjectId', 'expiresAt'] as const) {
    if (a[field] !== a.payload[field]) ctx.addIssue({ code: 'custom', path: [field], message: `${field} must equal payload.${field}` });
  }
  if (a.actionBundle.length !== a.payload.actionBundle.length || a.actionBundle.some((x, i) => x !== a.payload.actionBundle[i])) {
    ctx.addIssue({ code: 'custom', path: ['actionBundle'], message: 'actionBundle must equal payload.actionBundle' });
  }
  // SPEC 2.9: an approval expires 10 minutes after creation.
  if (msBetween(a.createdAt, a.expiresAt) !== APPROVAL_EXPIRY_MS) {
    ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'expiresAt must be createdAt plus 10 minutes' });
  }
  // DATA-MODEL 2.14 checks: decidedAt is absent exactly while PENDING; decidedBy is present exactly when APPROVED or REJECTED.
  if ((a.state === 'PENDING') !== (a.decidedAt === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['decidedAt'], message: 'decidedAt must be absent while PENDING and present otherwise' });
  }
  if ((a.state === 'APPROVED' || a.state === 'REJECTED') !== (a.decidedBy !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['decidedBy'], message: 'decidedBy must be present exactly when APPROVED or REJECTED' });
  }
}

export const OrderApprovalRequestSchema = OrderApprovalRequestBaseSchema.superRefine(checkApprovalRequest);
export const BookingApprovalRequestSchema = BookingApprovalRequestBaseSchema.superRefine(checkApprovalRequest);
export const FactEditApprovalRequestSchema = FactEditApprovalRequestBaseSchema.superRefine(checkApprovalRequest);
export const PriceEditApprovalRequestSchema = PriceEditApprovalRequestBaseSchema.superRefine(checkApprovalRequest);
export type OrderApprovalRequest = z.infer<typeof OrderApprovalRequestSchema>;
export type BookingApprovalRequest = z.infer<typeof BookingApprovalRequestSchema>;
export type FactEditApprovalRequest = z.infer<typeof FactEditApprovalRequestSchema>;
export type PriceEditApprovalRequest = z.infer<typeof PriceEditApprovalRequestSchema>;

/** Discriminated on `bundleType`. */
export const ApprovalRequestSchema = z.discriminatedUnion('bundleType', [
  OrderApprovalRequestSchema,
  BookingApprovalRequestSchema,
  FactEditApprovalRequestSchema,
  PriceEditApprovalRequestSchema,
]);
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

/** Body of POST /api/approvals/:id/decision. The `Idempotency-Key` header is also accepted. */
export const ApprovalDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  payloadHash: Sha256HashSchema, // the hash the UI displayed
  reason: z.string().optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
