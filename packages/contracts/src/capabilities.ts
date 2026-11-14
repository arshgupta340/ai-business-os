import { z } from 'zod';
import { ACTION_TYPE_CAPABILITY, BUNDLE_ACTIONS } from './bundles';
import {
  CapabilityIdSchema,
  FactKindSchema,
  MessageDispatchStatusSchema,
  OrderStatusSchema,
  ReadableFactKindSchema,
  SyncRecordTypeSchema,
  type ApprovalMode,
  type BundleType,
  type CapabilityId,
  type Effect,
  type Tier,
  type ToolName,
} from './enums';
import { ApprovalIdSchema, BookingIdSchema, OrderIdSchema, QuoteIdSchema, ServiceIdSchema, SyncJobIdSchema } from './ids';
import { CurrencySchema, IsoDateTimeSchema, JsonValueSchema, LocalDateSchema, MinorAmountSchema, TimezoneSchema } from './primitives';
import { CartSchema, CatalogItemSchema, QuoteSchema } from './schemas/catalog';
import { AvailabilitySlotSchema, BookingCustomerSchema, ContactSchema, FulfillmentSchema } from './schemas/orders';

export { ACTION_TYPE_CAPABILITY, BUNDLE_ACTIONS, DEFERRED_ACTION_TYPES, MESSAGE_ACTION_TYPES, executionStepsFor, isDeferredActionType } from './bundles';

// ---- Capability inputs and outputs (CONTRACTS 2). Server context is never part of an input. ----
export const CatalogReadInputSchema = z.object({ query: z.string().optional(), includeUnavailable: z.boolean().optional() });
export const CatalogReadOutputSchema = z.object({ items: z.array(CatalogItemSchema), syncedAt: IsoDateTimeSchema });

export const FactsReadInputSchema = z.object({ kinds: z.array(FactKindSchema).optional() });
export const FactsReadOutputSchema = z.object({
  facts: z.array(z.object({ kind: ReadableFactKindSchema, key: z.string(), value: JsonValueSchema, version: z.int().min(1) })),
  timezone: TimezoneSchema,
});

export const OrderQuoteInputSchema = z.object({ cart: CartSchema });
export const OrderQuoteOutputSchema = QuoteSchema;

export const OrderProposeInputSchema = z.object({
  cart: CartSchema,
  contact: ContactSchema,
  fulfillment: FulfillmentSchema,
  quoteId: QuoteIdSchema,
});
export const OrderProposeOutputSchema = z.object({
  proposalId: OrderIdSchema.optional(),
  quote: QuoteSchema.optional(),
  missingFields: z.array(z.string()),
  approvalId: ApprovalIdSchema.optional(),
});

export const OrderStatusReadInputSchema = z.object({ orderId: OrderIdSchema });
export const OrderStatusReadOutputSchema = z.object({
  orderId: OrderIdSchema,
  status: OrderStatusSchema,
  paid: z.boolean(),
  checkoutLinkSent: z.boolean(),
});

export const CheckoutPrepareInputSchema = z.object({ orderId: OrderIdSchema, approvalId: ApprovalIdSchema });
export const CheckoutPrepareOutputSchema = z.object({
  squareOrderId: z.string().min(1),
  squarePaymentLinkId: z.string().min(1),
  checkoutUrl: z.url(),
});

/** `SKIPPED` and no `dispatchId` when MESSAGE_CHANNEL is qr_only. */
export const MessageSendOutputSchema = z.object({
  dispatchId: z.string().optional(),
  status: z.union([MessageDispatchStatusSchema, z.literal('SKIPPED')]),
});
export const MessageCheckoutSendInputSchema = z.object({ orderId: OrderIdSchema, approvalId: ApprovalIdSchema });

export const AvailabilityReadInputSchema = z.object({
  serviceId: ServiceIdSchema,
  date: LocalDateSchema, // business timezone
  maxSlots: z.int().min(1).max(5).optional(), // default 5
});
export const AvailabilityReadOutputSchema = z.object({ slots: z.array(AvailabilitySlotSchema), timezone: TimezoneSchema });

export const BookingProposeInputSchema = z.object({
  serviceId: ServiceIdSchema,
  startUtc: IsoDateTimeSchema,
  customer: BookingCustomerSchema,
});
export const BookingProposeOutputSchema = z.object({
  proposalId: BookingIdSchema.optional(),
  approvalId: ApprovalIdSchema.optional(),
  missingFields: z.array(z.string()),
  slot: AvailabilitySlotSchema.optional(),
});

export const CalendarEventCreateInputSchema = z.object({ bookingId: BookingIdSchema, approvalId: ApprovalIdSchema });
export const CalendarEventCreateOutputSchema = z.object({ googleEventId: z.string().min(1), calendarId: z.string().min(1) });

export const MessageBookingConfirmInputSchema = z.object({ bookingId: BookingIdSchema, approvalId: ApprovalIdSchema });

export const SheetsAppendInputSchema = z.object({ recordType: SyncRecordTypeSchema, recordId: z.string().min(1) });
export const SheetsAppendOutputSchema = z.object({ syncJobId: SyncJobIdSchema });

export const PriceUpdateInputSchema = z.object({
  squareItemId: z.string().min(1),
  variationId: z.string().min(1),
  newPriceMinor: MinorAmountSchema,
  currency: CurrencySchema,
  approvalId: ApprovalIdSchema,
});
export const PriceUpdateOutputSchema = z.object({
  variationId: z.string().min(1),
  priceMinor: MinorAmountSchema,
  squareVersion: z.int().min(0),
});

// ---- The registry ----
export type CapabilityDefinition = {
  id: CapabilityId;
  description: string;
  effect: Effect;
  approvalMode: ApprovalMode;
  requiredScopes: readonly string[]; // checked by the policy engine against the agent version
  handlerId: string; // server function that runs it
  timeoutMs: number;
  tier: Tier;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
};

/** CONTRACTS 2. Server-owned: the model may request a capability by id, never register one or change its effect. */
export const CAPABILITIES = {
  'catalog.read': {
    id: 'catalog.read', description: 'Search the cached catalog for items, variations and modifiers',
    effect: 'read', approvalMode: 'none', requiredScopes: ['catalog:read'], handlerId: 'catalog.searchCache', timeoutMs: 1500, tier: 'MUST',
    inputSchema: CatalogReadInputSchema, outputSchema: CatalogReadOutputSchema,
  },
  'business.facts.read': {
    id: 'business.facts.read', description: 'Read verified hours, policies and services',
    effect: 'read', approvalMode: 'none', requiredScopes: ['facts:read'], handlerId: 'facts.readVerified', timeoutMs: 1000, tier: 'MUST',
    inputSchema: FactsReadInputSchema, outputSchema: FactsReadOutputSchema,
  },
  'order.quote': {
    id: 'order.quote', description: 'Authoritative totals and tax from Square CalculateOrder',
    effect: 'read', approvalMode: 'none', requiredScopes: ['square:orders.calculate'], handlerId: 'square.calculateOrder', timeoutMs: 5000, tier: 'MUST',
    inputSchema: OrderQuoteInputSchema, outputSchema: OrderQuoteOutputSchema,
  },
  'order.propose': {
    id: 'order.propose', description: 'Store an immutable order proposal and open an approval request',
    effect: 'propose', approvalMode: 'creates_approval', requiredScopes: ['orders:propose'], handlerId: 'orders.propose', timeoutMs: 6000, tier: 'MUST',
    inputSchema: OrderProposeInputSchema, outputSchema: OrderProposeOutputSchema,
  },
  'order.status.read': {
    id: 'order.status.read', description: 'Read the verified status of an order',
    effect: 'read', approvalMode: 'none', requiredScopes: ['orders:read'], handlerId: 'orders.readStatus', timeoutMs: 1000, tier: 'MUST',
    inputSchema: OrderStatusReadInputSchema, outputSchema: OrderStatusReadOutputSchema,
  },
  'order.checkout.prepare': {
    id: 'order.checkout.prepare', description: 'Create the Square payment link (which creates the Square order)',
    effect: 'write', approvalMode: 'required', requiredScopes: ['square:checkout.write'], handlerId: 'square.createPaymentLink', timeoutMs: 10000, tier: 'MUST',
    inputSchema: CheckoutPrepareInputSchema, outputSchema: CheckoutPrepareOutputSchema,
  },
  'message.checkout.send': {
    id: 'message.checkout.send', description: 'Send the checkout link to the confirmed recipient',
    effect: 'external_message', approvalMode: 'required', requiredScopes: ['message:send'], handlerId: 'message.sendCheckout', timeoutMs: 10000, tier: 'MUST',
    inputSchema: MessageCheckoutSendInputSchema, outputSchema: MessageSendOutputSchema,
  },
  'calendar.availability.read': {
    id: 'calendar.availability.read', description: 'Free slots from Google Calendar free/busy',
    effect: 'read', approvalMode: 'none', requiredScopes: ['calendar:freebusy'], handlerId: 'calendar.freeBusy', timeoutMs: 4000, tier: 'MUST',
    inputSchema: AvailabilityReadInputSchema, outputSchema: AvailabilityReadOutputSchema,
  },
  'booking.propose': {
    id: 'booking.propose', description: 'Store a booking proposal and open an approval request',
    effect: 'propose', approvalMode: 'creates_approval', requiredScopes: ['bookings:propose'], handlerId: 'bookings.propose', timeoutMs: 6000, tier: 'MUST',
    inputSchema: BookingProposeInputSchema, outputSchema: BookingProposeOutputSchema,
  },
  'calendar.event.create': {
    id: 'calendar.event.create', description: 'Create one Calendar event after a fresh availability check',
    effect: 'write', approvalMode: 'required', requiredScopes: ['calendar:events.write'], handlerId: 'calendar.insertEvent', timeoutMs: 8000, tier: 'MUST',
    inputSchema: CalendarEventCreateInputSchema, outputSchema: CalendarEventCreateOutputSchema,
  },
  'message.booking.confirm': {
    id: 'message.booking.confirm', description: 'Tell the customer the booking is confirmed',
    effect: 'external_message', approvalMode: 'required', requiredScopes: ['message:send'], handlerId: 'message.sendBookingConfirm', timeoutMs: 10000, tier: 'MUST',
    inputSchema: MessageBookingConfirmInputSchema, outputSchema: MessageSendOutputSchema,
  },
  'sheets.rows.append': {
    id: 'sheets.rows.append', description: 'Append one reporting row, deduplicated',
    effect: 'write', approvalMode: 'required', requiredScopes: ['sheets:append'], handlerId: 'sheets.appendRow', timeoutMs: 8000, tier: 'MUST',
    inputSchema: SheetsAppendInputSchema, outputSchema: SheetsAppendOutputSchema,
  },
  'catalog.price.update': {
    id: 'catalog.price.update', description: 'Change a price in Square',
    effect: 'write', approvalMode: 'required', requiredScopes: ['square:catalog.write'], handlerId: 'square.updateVariationPrice', timeoutMs: 8000, tier: 'SHOULD',
    inputSchema: PriceUpdateInputSchema, outputSchema: PriceUpdateOutputSchema,
  },
} as const satisfies Record<CapabilityId, CapabilityDefinition>;

export const CAPABILITY_LIST: readonly CapabilityDefinition[] = CapabilityIdSchema.options.map((id) => CAPABILITIES[id]);

export function getCapability(id: CapabilityId): CapabilityDefinition {
  return CAPABILITIES[id];
}

export function isCapabilityId(value: string): value is CapabilityId {
  return CapabilityIdSchema.safeParse(value).success;
}

/** SPEC 2.6: the tool the model sees for each read or propose capability. */
export const TOOL_CAPABILITY = {
  read_catalog: 'catalog.read',
  read_business_facts: 'business.facts.read',
  quote_order: 'order.quote',
  propose_order: 'order.propose',
  get_order_status: 'order.status.read',
  read_calendar_availability: 'calendar.availability.read',
  propose_booking: 'booking.propose',
} as const satisfies Record<ToolName, CapabilityId>;

/** Effects a deployed agent (phone, sim-call or test console) may hold as tools. */
export const TOOL_EFFECTS = ['read', 'propose'] as const satisfies readonly Effect[];

export function isToolEffect(effect: Effect): effect is (typeof TOOL_EFFECTS)[number] {
  return effect === 'read' || effect === 'propose';
}

/** The tools an agent spec gets: the SPEC 2.6 tools whose capability is in the spec. Write capabilities never yield a tool. */
export function toolsForCapabilities(capabilityIds: readonly CapabilityId[]): ToolName[] {
  return (Object.keys(TOOL_CAPABILITY) as ToolName[]).filter((tool) => capabilityIds.includes(TOOL_CAPABILITY[tool]));
}

/** The capabilities an agent tool set may use: the read and propose subset of the given list. */
export function toolCapabilities(capabilityIds: readonly CapabilityId[]): CapabilityId[] {
  return capabilityIds.filter((id) => isToolEffect(CAPABILITIES[id].effect));
}

export type CapabilityValidation =
  | { ok: true; capabilities: CapabilityId[] }
  | { ok: false; code: 'CAPABILITY_NOT_ALLOWED'; unknown: string[]; notAllowed: CapabilityId[] };

/**
 * AGENTS rule 6, CONTRACTS 2: a deployed agent may hold only `read` and `propose` capabilities as tools.
 * Returns `CAPABILITY_NOT_ALLOWED` for an id not in the registry, or a `write` or `external_message` capability offered as a tool.
 */
export function validateToolCapabilities(ids: readonly string[]): CapabilityValidation {
  const unknown: string[] = [];
  const notAllowed: CapabilityId[] = [];
  const capabilities: CapabilityId[] = [];
  for (const id of ids) {
    if (!isCapabilityId(id)) unknown.push(id);
    else if (!isToolEffect(CAPABILITIES[id].effect)) notAllowed.push(id);
    else capabilities.push(id);
  }
  if (unknown.length > 0 || notAllowed.length > 0) return { ok: false, code: 'CAPABILITY_NOT_ALLOWED', unknown, notAllowed };
  return { ok: true, capabilities };
}

export class CapabilityNotAllowedError extends Error {
  readonly code = 'CAPABILITY_NOT_ALLOWED' as const;
  constructor(
    readonly unknown: string[],
    readonly notAllowed: CapabilityId[],
  ) {
    super(`Capability not allowed as a tool: ${[...unknown, ...notAllowed].join(', ')}`);
    this.name = 'CapabilityNotAllowedError';
  }
}

/** Throwing form of `validateToolCapabilities`. */
export function assertToolCapabilities(ids: readonly string[]): CapabilityId[] {
  const result = validateToolCapabilities(ids);
  if (!result.ok) throw new CapabilityNotAllowedError(result.unknown, result.notAllowed);
  return result.capabilities;
}

/**
 * Checks an `AgentSpec.capabilities` list: every id must be in the registry. Write and external_message
 * ids are allowed here only as the executor bundle; they never become tools (`toolsForCapabilities`).
 */
export function validateSpecCapabilities(ids: readonly string[]): CapabilityValidation {
  const unknown = ids.filter((id) => !isCapabilityId(id));
  if (unknown.length > 0) return { ok: false, code: 'CAPABILITY_NOT_ALLOWED', unknown, notAllowed: [] };
  return { ok: true, capabilities: ids as CapabilityId[] };
}

/** The capabilities a bundle exercises, in order, without the local steps. */
export function capabilitiesForBundle(bundleType: BundleType): CapabilityId[] {
  const out: CapabilityId[] = [];
  for (const action of BUNDLE_ACTIONS[bundleType]) {
    const cap = ACTION_TYPE_CAPABILITY[action];
    if (cap !== null && !out.includes(cap)) out.push(cap);
  }
  return out;
}
