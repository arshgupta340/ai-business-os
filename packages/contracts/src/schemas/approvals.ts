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

// SPEC 2.9 "Customer who declines messages": without consent there is no recipient and the channel is
// qr_only. The payload carries no consent flag: a qr_only payload with no messageRecipient says it.
function checkMessageChannel(payload: { messageRecipient?: string | undefined; messageChannel: string }, ctx: z.RefinementCtx): void {
  if (payload.messageChannel !== 'qr_only' && payload.messageRecipient === undefined) {
    ctx.addIssue({ code: 'custom', path: ['messageRecipient'], message: 'A message channel other than qr_only requires messageRecipient' });
  }
}

// CONTRACTS 4: a payload holds exactly the material fields, so each payload schema is strict and an
// extra field is refused. payloadHash is the hash of the whole payload.
export const OrderApprovalPayloadBaseSchema = z.strictObject({
  businessId: BusinessIdSchema,
  subjectId: OrderIdSchema,
  agentVersionId: AgentVersionIdSchema, // always from the calls row (SPEC 2.9)
  cartHash: Sha256HashSchema,
  totalMinor: MinorAmountSchema,
  currency: CurrencySchema,
  pickupAt: IsoDateTimeSchema,
  messageRecipient: E164Schema.optional(),
  messageChannel: MessageChannelSettingSchema, // the server's MESSAGE_CHANNEL at proposal time
  actionBundle: OrderBundleActionsSchema,
  expiresAt: IsoDateTimeSchema,
});
export const OrderApprovalPayloadSchema = OrderApprovalPayloadBaseSchema.superRefine(checkMessageChannel);
export type OrderApprovalPayload = z.infer<typeof OrderApprovalPayloadSchema>;

export const BookingApprovalPayloadBaseSchema = z.strictObject({
  businessId: BusinessIdSchema,
  subjectId: BookingIdSchema,
  agentVersionId: AgentVersionIdSchema,
  serviceId: ServiceIdSchema,
  calendarId: z.string().min(1),
  startUtc: IsoDateTimeSchema,
  endUtc: IsoDateTimeSchema,
  timezone: TimezoneSchema,
  messageRecipient: E164Schema.optional(),
  messageChannel: MessageChannelSettingSchema,
  actionBundle: BookingBundleActionsSchema,
  expiresAt: IsoDateTimeSchema,
});
export const BookingApprovalPayloadSchema = BookingApprovalPayloadBaseSchema.superRefine(checkMessageChannel)
  .refine((p) => msBetween(p.startUtc, p.endUtc) > 0, { path: ['endUtc'], message: 'endUtc must be after startUtc' });
export type BookingApprovalPayload = z.infer<typeof BookingApprovalPayloadSchema>;

export const FactEditApprovalPayloadSchema = z.strictObject({
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

export const PriceEditApprovalPayloadSchema = z.strictObject({
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
  // Issue #108, additive. The decider's display name, read from the users row when the approval is
  // served. Display only: it is outside `payload`, so it is not hashed and not stored on the approval.
  decidedByName: z.string().min(1).optional(),
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
  // Issue #108, additive. The catalog names of the `cat_` row in `subjectId`, read from the catalog
  // cache when the approval is served. Display only: they are outside `payload`, so they are not
  // hashed, and they are not a record of the names at proposal time (CONTRACTS section 12).
  itemName: z.string().min(1).optional(),
  variationName: z.string().min(1).optional(),
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
  for (const field of ['businessId', 'subjectId'] as const) {
    if (a[field] !== a.payload[field]) ctx.addIssue({ code: 'custom', path: [field], message: `${field} must equal payload.${field}` });
  }
  if (Math.abs(msBetween(a.expiresAt, a.payload.expiresAt)) > 2000) {
    ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'expiresAt must equal payload.expiresAt within 2 seconds' });
  }
  if (a.actionBundle.length !== a.payload.actionBundle.length || a.actionBundle.some((x, i) => x !== a.payload.actionBundle[i])) {
    ctx.addIssue({ code: 'custom', path: ['actionBundle'], message: 'actionBundle must equal payload.actionBundle' });
  }
  // SPEC 2.9: an approval expires 10 minutes after creation.
  if (Math.abs(msBetween(a.createdAt, a.expiresAt) - APPROVAL_EXPIRY_MS) > 2000) {
    ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'expiresAt must be createdAt plus 10 minutes within 2 seconds' });
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
