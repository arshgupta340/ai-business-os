import { z } from 'zod';
import { TOOL_CAPABILITY } from './capabilities';
import { ModifierSelectionTypeSchema } from './schemas/catalog';
import { OrderStatusSchema, ReadableFactKindSchema, ToolNameSchema, type ToolName } from './enums';
import { ToolFailureReasonSchema } from './errors';
import { AgentVersionIdSchema, ApprovalIdSchema, BookingIdSchema, BusinessIdSchema, CallIdSchema, OrderIdSchema, QuoteIdSchema, ServiceIdSchema, TestSessionIdSchema } from './ids';
import { IsoDateTimeSchema, JsonValueSchema, LocalDateSchema, LocalTimeSchema, MinorAmountSchema, TimezoneSchema } from './primitives';
import { CartSchema, QuoteSchema } from './schemas/catalog';
import { AvailabilitySlotSchema, BookingCustomerSchema, ContactSchema, FulfillmentSchema } from './schemas/orders';

export { ToolNameSchema, type ToolName } from './enums';
export { TOOL_CAPABILITY } from './capabilities';

// ---- Arguments the model sends (CONTRACTS 8). Server context (businessId, callId, agentVersionId) is never accepted. ----
export const TOOL_INPUT_SCHEMAS = {
  read_catalog: z.strictObject({ query: z.string().optional() }),
  read_business_facts: z.strictObject({ kinds: z.array(ReadableFactKindSchema).optional() }),
  quote_order: z.strictObject({ cart: CartSchema }),
  propose_order: z.strictObject({ cart: CartSchema, contact: ContactSchema, fulfillment: FulfillmentSchema, quoteId: QuoteIdSchema }),
  get_order_status: z.strictObject({ orderId: OrderIdSchema }),
  read_calendar_availability: z.strictObject({
    serviceId: ServiceIdSchema,
    date: LocalDateSchema,
    maxSlots: z.int().min(1).max(5).optional(),
    // Additive (2026-11-15): the time of day the caller asked for, local, 24-hour "HH:MM". With it the free
    // slots nearest to that time are returned, in time order, and not the earliest of the day.
    near: LocalTimeSchema.optional(),
  }),
  propose_booking: z.strictObject({ serviceId: ServiceIdSchema, startUtc: IsoDateTimeSchema, customer: BookingCustomerSchema }),
  propose_menu_message: z.strictObject({}),
} as const satisfies Record<ToolName, z.ZodType>;

export type ToolInput = { [N in ToolName]: z.infer<(typeof TOOL_INPUT_SCHEMAS)[N]> };

// ---- Success payloads, without `ok` (CONTRACTS 8 result table) ----
export const ToolCatalogItemSchema = z.object({
  catalogItemId: z.string().min(1), // the Square item id
  name: z.string(),
  available: z.boolean(),
  variations: z.array(z.object({ id: z.string().min(1), name: z.string(), priceMinor: MinorAmountSchema })),
  modifierLists: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      selectionType: ModifierSelectionTypeSchema,
      modifiers: z.array(z.object({ id: z.string().min(1), name: z.string(), priceMinor: MinorAmountSchema })),
    }),
  ),
});
export type ToolCatalogItem = z.infer<typeof ToolCatalogItemSchema>;

/** proposalId and approvalId are present exactly when missingFields is empty. */
function presentIffNoMissing(v: { proposalId?: string | undefined; approvalId?: string | undefined; missingFields: string[] }, ctx: z.RefinementCtx) {
  const hasIds = [v.proposalId, v.approvalId].map((x) => x !== undefined);
  const ok = v.missingFields.length === 0 ? hasIds.every(Boolean) : !hasIds.some(Boolean);
  if (!ok) {
    ctx.addIssue({ code: 'custom', message: 'proposalId and approvalId must be present exactly when missingFields is empty' });
  }
}

export const TOOL_OUTPUT_SCHEMAS = {
  read_catalog: z.object({ items: z.array(ToolCatalogItemSchema) }),
  read_business_facts: z.object({
    facts: z.array(z.object({ kind: ReadableFactKindSchema, key: z.string(), value: JsonValueSchema })),
    timezone: TimezoneSchema,
  }),
  quote_order: z.object({ quote: QuoteSchema }),
  propose_order: z
    .object({
      proposalId: OrderIdSchema.optional(),
      quote: QuoteSchema,
      missingFields: z.array(z.string()),
      approvalId: ApprovalIdSchema.optional(),
    })
    .superRefine(presentIffNoMissing),
  get_order_status: z.object({ orderId: OrderIdSchema, status: OrderStatusSchema, paid: z.boolean(), checkoutLinkSent: z.boolean() }),
  read_calendar_availability: z.object({ slots: z.array(AvailabilitySlotSchema), timezone: TimezoneSchema }),
  propose_booking: z
    .object({
      proposalId: BookingIdSchema.optional(),
      approvalId: ApprovalIdSchema.optional(),
      missingFields: z.array(z.string()),
      slot: AvailabilitySlotSchema,
    })
    .superRefine(presentIffNoMissing),
  // D-13 demo mode: `sent` is true only when the server sent the menu on this call.
  propose_menu_message: z.object({ sent: z.boolean(), message: z.string().optional() }),
} as const satisfies Record<ToolName, z.ZodType>;

export type ToolOutput = { [N in ToolName]: z.infer<(typeof TOOL_OUTPUT_SCHEMAS)[N]> };

export const ToolFailureSchema = z.object({
  ok: z.literal(false),
  reason: ToolFailureReasonSchema,
  message: z.string().optional(),
  quote: QuoteSchema.optional(), // QUOTE_EXPIRED only: a fresh quote to read back
  alternatives: z.array(AvailabilitySlotSchema).max(3).optional(), // SLOT_CONFLICT only
});
export type ToolFailure = z.infer<typeof ToolFailureSchema>;

export type ToolResult<N extends ToolName> = ({ ok: true } & ToolOutput[N]) | ToolFailure;

/** Zod schema for `{ ok: true, ... } | { ok: false, reason }` of one tool. */
export function toolResultSchema<N extends ToolName>(name: N): z.ZodType<ToolResult<N>> {
  const success = z.intersection(z.object({ ok: z.literal(true) }), TOOL_OUTPUT_SCHEMAS[name]);
  return z.union([success, ToolFailureSchema]) as unknown as z.ZodType<ToolResult<N>>;
}

export const ToolContextSchema = z.object({
  businessId: BusinessIdSchema,
  agentVersionId: AgentVersionIdSchema,
  callId: CallIdSchema.optional(),
  testSessionId: TestSessionIdSchema.optional(),
  correlationId: z.string().min(1),
});
export type ToolContext = z.infer<typeof ToolContextSchema>;

/** SPEC 2.6: one interface, two implementations (real and mock). */
export interface ToolHandler {
  readonly toolset: 'real' | 'mock';
  call<N extends ToolName>(name: N, input: ToolInput[N], ctx: ToolContext): Promise<ToolResult<N>>;
}

/** What the real and the mock toolset each implement: one function per tool. */
export type Toolset = { readonly [N in ToolName]: (input: ToolInput[N], ctx: ToolContext) => Promise<ToolResult<N>> };

/**
 * Wraps a `Toolset` as a `ToolHandler`. Arguments that fail their schema return
 * `{ ok: false, reason: "VALIDATION_FAILED" }` without calling the tool.
 */
export function createToolHandler(kind: 'real' | 'mock', toolset: Toolset): ToolHandler {
  return {
    toolset: kind,
    async call<N extends ToolName>(name: N, input: ToolInput[N], ctx: ToolContext): Promise<ToolResult<N>> {
      const parsed = TOOL_INPUT_SCHEMAS[name].safeParse(input);
      if (!parsed.success) return { ok: false, reason: 'VALIDATION_FAILED', message: parsed.error.issues.map((i) => i.message).join('; ') };
      const fn = toolset[name] as (input: ToolInput[N], ctx: ToolContext) => Promise<ToolResult<N>>;
      return fn(parsed.data as ToolInput[N], ctx);
    },
  };
}

// ---- JSON function definitions for the OpenAI Realtime and Responses APIs ----
export type JsonSchemaObject = { [key: string]: unknown };
export type ToolDefinition = { type: 'function'; name: ToolName; description: string; parameters: JsonSchemaObject };

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  read_catalog: "Search this shop's menu. Use exact item, size and topping IDs from the result.",
  read_business_facts: 'Read verified opening hours, policies and services. Answer only from this result.',
  quote_order: 'Get the exact total and tax for a cart. Read the total back to the caller from this result only.',
  propose_order:
    'Send the confirmed order to the owner for approval. Call only after the caller confirmed the read-back of this quote. Record whether the caller consents to messages; without consent, omit the recipient and use the dashboard QR code.',
  get_order_status: 'Read the verified status of an order placed on this call.',
  read_calendar_availability: 'List free appointment slots for one service on one date.',
  propose_booking: 'Send the confirmed appointment to the owner for approval. Call only after the caller confirmed service, time and contact.',
  propose_menu_message: 'Send the menu to the caller by message. Call only when the caller asks for the menu to be sent.',
};

/** Drops the long generated regex where a `format` (date, date-time) already says it; the server still validates fully. */
function simplify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(simplify);
  if (node === null || typeof node !== 'object') return node;
  const out: JsonSchemaObject = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'pattern' && 'format' in node) continue;
    out[k] = simplify(v);
  }
  return out;
}

function toParameters(schema: z.ZodType): JsonSchemaObject {
  // CONTRACTS 8 allows inlining the $defs; the generated schema has no $ref.
  const json = simplify(z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' })) as JsonSchemaObject;
  delete json.$schema;
  return json;
}

/** The agent tools (seven, plus the D-13 demo menu tool) in the `{ type: "function", name, description, parameters }` form. No write or external_message tool exists. */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = ToolNameSchema.options.map((name) => ({
  type: 'function' as const,
  name,
  description: TOOL_DESCRIPTIONS[name],
  parameters: toParameters(TOOL_INPUT_SCHEMAS[name]),
}));

/** Tool definitions for a set of tool names, for example from `toolsForCapabilities(spec.capabilities)`. */
export function toolDefinitionsFor(names: readonly ToolName[]): ToolDefinition[] {
  return TOOL_DEFINITIONS.filter((d) => names.includes(d.name));
}

export function capabilityForTool(name: ToolName) {
  return TOOL_CAPABILITY[name];
}
