// The capability registry as the builder sees it, and every check the builder
// makes against it. The registry rows are a TEMPORARY transcription of
// docs/CONTRACTS.md section 2. When S-02 merges, import the registry from
// `@abos/contracts` and keep only the functions in this file.

import { z } from 'zod';
import {
  CapabilityIdSchema,
  ToolInputSchemas,
  type AgentTemplate,
  type Capability,
  type CapabilityId,
  type KnowledgeScope,
  type ToolName,
} from './pending-contracts';

const byApproval = z.strictObject({ approvalId: z.string() });

export const CAPABILITY_REGISTRY: readonly Capability[] = Object.freeze([
  cap('catalog.read', 'Search the cached catalog for items, variations and modifiers', 'read', 'none', 'catalog:read', 'catalog.searchCache', 1500, 'MUST', ToolInputSchemas.read_catalog),
  cap('business.facts.read', 'Read verified hours, policies and services', 'read', 'none', 'facts:read', 'facts.readVerified', 1000, 'MUST', ToolInputSchemas.read_business_facts),
  cap('order.quote', 'Authoritative totals and tax from Square CalculateOrder', 'read', 'none', 'square:orders.calculate', 'square.calculateOrder', 5000, 'MUST', ToolInputSchemas.quote_order),
  cap('order.propose', 'Store an immutable order proposal and open an approval request', 'propose', 'creates_approval', 'orders:propose', 'orders.propose', 6000, 'MUST', ToolInputSchemas.propose_order),
  cap('order.status.read', 'Read the verified status of an order', 'read', 'none', 'orders:read', 'orders.readStatus', 1000, 'MUST', ToolInputSchemas.get_order_status),
  cap('order.checkout.prepare', 'Create the Square payment link (which creates the Square order)', 'write', 'required', 'square:checkout.write', 'square.createPaymentLink', 10000, 'MUST', byApproval.extend({ orderId: z.string() })),
  cap('message.checkout.send', 'Send the checkout link to the confirmed recipient', 'external_message', 'required', 'message:send', 'message.sendCheckout', 10000, 'MUST', byApproval.extend({ orderId: z.string() })),
  cap('calendar.availability.read', 'Free slots from Google Calendar free/busy', 'read', 'none', 'calendar:freebusy', 'calendar.freeBusy', 4000, 'MUST', ToolInputSchemas.read_calendar_availability),
  cap('booking.propose', 'Store a booking proposal and open an approval request', 'propose', 'creates_approval', 'bookings:propose', 'bookings.propose', 6000, 'MUST', ToolInputSchemas.propose_booking),
  cap('calendar.event.create', 'Create one Calendar event after a fresh availability check', 'write', 'required', 'calendar:events.write', 'calendar.insertEvent', 8000, 'MUST', byApproval.extend({ bookingId: z.string() })),
  cap('message.booking.confirm', 'Tell the customer the booking is confirmed', 'external_message', 'required', 'message:send', 'message.sendBookingConfirm', 10000, 'MUST', byApproval.extend({ bookingId: z.string() })),
  cap('sheets.rows.append', 'Append one reporting row, deduplicated', 'write', 'required', 'sheets:append', 'sheets.appendRow', 8000, 'MUST', z.strictObject({ recordType: z.enum(['order', 'booking']), recordId: z.string() })),
  cap('catalog.price.update', 'Change a price in Square', 'write', 'required', 'square:catalog.write', 'square.updateVariationPrice', 8000, 'SHOULD', byApproval.extend({ squareItemId: z.string(), variationId: z.string(), newPriceMinor: z.number().int(), currency: z.literal('USD') })),
]);

function cap(
  id: CapabilityId,
  description: string,
  effect: Capability['effect'],
  approvalMode: Capability['approvalMode'],
  scope: string,
  handlerId: string,
  timeoutMs: number,
  tier: Capability['tier'],
  inputSchema: z.ZodType,
): Capability {
  return Object.freeze({ id, description, effect, approvalMode, requiredScopes: [scope], handlerId, timeoutMs, tier, inputSchema, outputSchema: z.unknown() });
}

const BY_ID = new Map<string, Capability>(CAPABILITY_REGISTRY.map((c) => [c.id, c]));

export function getCapability(id: string): Capability | undefined {
  return BY_ID.get(id);
}

export function isRegisteredCapability(id: string): id is CapabilityId {
  return BY_ID.has(id);
}

// Tool name to capability (SPEC 2.6). There is no entry for any write or
// external_message capability, and the check below makes sure of it at load.
export const TOOL_CAPABILITY: Readonly<Record<ToolName, CapabilityId>> = Object.freeze({
  read_catalog: 'catalog.read',
  read_business_facts: 'business.facts.read',
  quote_order: 'order.quote',
  propose_order: 'order.propose',
  get_order_status: 'order.status.read',
  read_calendar_availability: 'calendar.availability.read',
  propose_booking: 'booking.propose',
});

for (const [tool, capabilityId] of Object.entries(TOOL_CAPABILITY)) {
  const effect = getCapability(capabilityId)?.effect;
  if (effect !== 'read' && effect !== 'propose') {
    throw new Error(`Tool ${tool} maps to ${capabilityId} with effect ${String(effect)}. Agent tools may only read or propose.`);
  }
}

export function toolEffect(tool: ToolName): 'read' | 'propose' {
  // Safe: the load-time check above proves every tool is read or propose.
  return getCapability(TOOL_CAPABILITY[tool])!.effect as 'read' | 'propose';
}

// Capability sets per template (CONTRACTS.md section 3, comments under AgentSpec).
export const TEMPLATE_CAPABILITIES: Readonly<Record<Exclude<AgentTemplate, 'custom'>, readonly CapabilityId[]>> = Object.freeze({
  restaurant_order_taker: [
    'catalog.read',
    'business.facts.read',
    'order.quote',
    'order.propose',
    'order.status.read',
    'order.checkout.prepare',
    'message.checkout.send',
    'sheets.rows.append',
  ],
  appointment_booker: [
    'business.facts.read',
    'calendar.availability.read',
    'booking.propose',
    'calendar.event.create',
    'message.booking.confirm',
    'sheets.rows.append',
  ],
});

// Default knowledge scopes per template. The scope values are from CONTRACTS.md;
// which template gets which scope is the builder's choice.
export const TEMPLATE_KNOWLEDGE_SCOPES: Readonly<Record<AgentTemplate, readonly KnowledgeScope[]>> = Object.freeze({
  restaurant_order_taker: ['business_profile', 'catalog', 'hours', 'order_policies'],
  appointment_booker: ['business_profile', 'hours', 'services'],
  custom: ['business_profile'],
});

export interface CapabilitySplit {
  allowed: CapabilityId[];
  unsupported: string[];
}

// The one place model-supplied capability IDs enter the system. Anything not in
// the registry is removed and reported. Duplicates are dropped. Order is kept.
export function splitRequestedCapabilities(requested: readonly unknown[]): CapabilitySplit {
  const allowed: CapabilityId[] = [];
  const unsupported: string[] = [];
  for (const raw of requested) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (id && isRegisteredCapability(id)) {
      if (!allowed.includes(id)) allowed.push(id);
    } else {
      const label = typeof raw === 'string' ? raw.trim().slice(0, 80) : String(raw).slice(0, 80);
      if (label && !unsupported.includes(label)) unsupported.push(label);
    }
  }
  return { allowed, unsupported };
}

export interface SpecIssue {
  path: string;
  message: string;
}

// Checks a spec's capability list against the registry. A spec built by the
// builder always passes; this is the check for a spec that arrives by API.
export function validateCapabilitiesAgainstRegistry(capabilities: readonly unknown[]): SpecIssue[] {
  const issues: SpecIssue[] = [];
  capabilities.forEach((id, index) => {
    if (typeof id !== 'string' || !isRegisteredCapability(id)) {
      issues.push({ path: `capabilities.${index}`, message: `Capability ${String(id)} is not in the registry.` });
    }
  });
  return issues;
}

// The tools an agent with these capabilities may call. Only read and propose
// capabilities become tools. write and external_message ones are the bundle
// the executor runs after approval, never a tool.
export function toolsForCapabilities(capabilities: readonly CapabilityId[]): ToolName[] {
  const set = new Set(capabilities);
  return (Object.keys(TOOL_CAPABILITY) as ToolName[]).filter((tool) => set.has(TOOL_CAPABILITY[tool]));
}

export interface PermissionSummary {
  readOnly: CapabilityId[];
  proposes: CapabilityId[];
  approvalRequired: CapabilityId[];
}

export function permissionSummary(capabilities: readonly CapabilityId[]): PermissionSummary {
  const summary: PermissionSummary = { readOnly: [], proposes: [], approvalRequired: [] };
  for (const id of capabilities) {
    const c = getCapability(id);
    if (!c) continue;
    if (c.effect === 'read') summary.readOnly.push(id);
    else if (c.effect === 'propose') summary.proposes.push(id);
    else summary.approvalRequired.push(id);
  }
  return summary;
}

export function registryForModel(): { id: CapabilityId; description: string; effect: Capability['effect'] }[] {
  return CAPABILITY_REGISTRY.map(({ id, description, effect }) => ({ id, description, effect }));
}

// Re-exported so callers need one import for capability IDs.
export { CapabilityIdSchema };
