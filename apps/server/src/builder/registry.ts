// The capability registry as the builder sees it, and every check the builder
// makes against it. The registry rows, the tool map and the bundle steps come
// from `@abos/contracts`. This file adds the builder's own rules on top: which
// subsets of the registry form a valid agent, and how the builder fits a set.

import {
  CAPABILITIES,
  CAPABILITY_LIST,
  CapabilityIdSchema,
  TOOL_CAPABILITY,
  capabilitiesForBundle,
  isCapabilityId,
  isToolEffect,
  toolsForCapabilities,
  type AgentTemplate,
  type CapabilityDefinition,
  type CapabilityId,
  type Effect,
  type KnowledgeScope,
  type ToolName,
} from '@abos/contracts';

export const CAPABILITY_REGISTRY: readonly CapabilityDefinition[] = CAPABILITY_LIST;

export function getCapability(id: string): CapabilityDefinition | undefined {
  return isCapabilityId(id) ? CAPABILITIES[id] : undefined;
}

export function isRegisteredCapability(id: string): id is CapabilityId {
  return isCapabilityId(id);
}

// Tool name to capability (SPEC 2.6), from the package. The check below runs
// when this module loads: if a tool ever maps to a write or external_message
// capability, or to an ID the registry does not have, the server does not start.
export { TOOL_CAPABILITY, toolsForCapabilities };

export function assertToolsReadOrPropose(
  map: Readonly<Record<string, string>>,
  effectOf: (capabilityId: string) => Effect | undefined = (id) => getCapability(id)?.effect,
): void {
  for (const [tool, capabilityId] of Object.entries(map)) {
    const effect = effectOf(capabilityId);
    if (effect === undefined || !isToolEffect(effect)) {
      throw new Error(`Tool ${tool} maps to ${capabilityId} with effect ${String(effect)}. Agent tools may only read or propose.`);
    }
  }
}

assertToolsReadOrPropose(TOOL_CAPABILITY);

export function toolEffect(tool: ToolName): 'read' | 'propose' {
  // Safe: the load-time check above proves every tool is read or propose.
  return CAPABILITIES[TOOL_CAPABILITY[tool]].effect as 'read' | 'propose';
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

// ---------------------------------------------------------------------------
// Capability set rules (P-13: a custom agent is any validated subset).
//
// This is the one table of dependency rules. Every rule below is checked by
// validateCapabilitySet, for every template, and nowhere else.
//
// - `needs`: capabilities that must be in the same set, because this one
//   cannot work on a call without them. Taken from the tool inputs in SPEC 2.6
//   and CONTRACTS.md section 8, and from FLOWS.md B14 and C5.
// - `bundle`: only on a propose capability. The bundleType it opens and the
//   capabilities that bundle's action types exercise, read from the package
//   (`capabilitiesForBundle`, SPEC 2.3). An approved bundle runs all its
//   steps, so a propose capability needs every one of them in the set.
//
// A write or external_message capability has no rule of its own. It is valid
// only when a propose capability in the same set opens a bundle that runs it
// (SPEC 2.2: "Only the action executor runs those, and only for an approved
// bundle"). A write that no agent bundle runs (catalog.price.update, which runs
// only in a price_edit the owner starts) is never valid in an agent spec.
export interface CapabilityRule {
  needs: readonly CapabilityId[];
  // Why `needs` holds, in one plain sentence for the owner.
  needsReason?: string;
  bundle?: { bundleType: 'order_bundle' | 'booking_bundle'; runs: readonly CapabilityId[] };
}

export const CAPABILITY_RULES: Readonly<Partial<Record<CapabilityId, CapabilityRule>>> = Object.freeze({
  'order.quote': {
    needs: ['catalog.read'],
    needsReason: 'A quote is built from exact item and size IDs, which only the catalog gives.',
  },
  'order.propose': {
    needs: ['catalog.read', 'order.quote'],
    needsReason: 'An order is proposed on a quote the caller heard read back, built from catalog IDs.',
    bundle: { bundleType: 'order_bundle', runs: capabilitiesForBundle('order_bundle') },
  },
  'order.status.read': {
    needs: ['order.propose'],
    needsReason: 'It reads the status of an order placed on the call, so the agent must be able to propose orders.',
  },
  'calendar.availability.read': {
    needs: ['business.facts.read'],
    needsReason: 'Free slots are asked for one service, and the services come from the business facts.',
  },
  'booking.propose': {
    needs: ['business.facts.read', 'calendar.availability.read'],
    needsReason: 'A booking is proposed for a slot the agent found free, for a service it read.',
    bundle: { bundleType: 'booking_bundle', runs: capabilitiesForBundle('booking_bundle') },
  },
});

// The propose capabilities whose bundle runs a given write or external_message
// capability. Derived from the table above, never written by hand.
export function openedBy(id: CapabilityId): CapabilityId[] {
  return (Object.entries(CAPABILITY_RULES) as [CapabilityId, CapabilityRule][])
    .filter(([, rule]) => rule.bundle?.runs.includes(id))
    .map(([proposer]) => proposer);
}

export interface CapabilitySetIssue extends SpecIssue {
  capabilityId: string;
}

// Checks one capability set against the registry and the rules above. Returns
// one issue per broken rule, in set order. An empty list means the set is
// valid. The agent's tools then follow from it through toolsForCapabilities.
export function validateCapabilitySet(capabilities: readonly unknown[]): CapabilitySetIssue[] {
  const issues: CapabilitySetIssue[] = [];
  const set = new Set(capabilities.filter((c): c is CapabilityId => typeof c === 'string' && isRegisteredCapability(c)));
  if (capabilities.length === 0) {
    issues.push({ path: 'capabilities', capabilityId: '', message: 'An agent needs at least one capability.' });
  }
  capabilities.forEach((raw, index) => {
    const path = `capabilities.${index}`;
    if (typeof raw !== 'string' || !isRegisteredCapability(raw)) {
      issues.push({ path, capabilityId: String(raw), message: `Capability ${String(raw)} is not in the registry.` });
      return;
    }
    const id = raw;
    const effect = CAPABILITIES[id].effect;
    if (!isToolEffect(effect)) {
      const openers = openedBy(id);
      if (openers.length === 0) {
        issues.push({ path, capabilityId: id, message: `${id} is never part of a phone agent. It runs only when the owner approves that change directly.` });
      } else if (!openers.some((p) => set.has(p))) {
        issues.push({
          path,
          capabilityId: id,
          message: `${id} runs only inside an approved bundle that ${openers.join(' or ')} opens. It cannot be chosen on its own.`,
        });
      }
      return;
    }
    const rule = CAPABILITY_RULES[id];
    if (!rule) return;
    const missingNeeds = rule.needs.filter((n) => !set.has(n));
    if (missingNeeds.length > 0) {
      issues.push({ path, capabilityId: id, message: `${id} needs ${missingNeeds.join(' and ')}. ${rule.needsReason ?? ''}`.trim() });
    }
    const missingSteps = rule.bundle?.runs.filter((n) => !set.has(n)) ?? [];
    if (missingSteps.length > 0) {
      issues.push({
        path,
        capabilityId: id,
        message: `${id} opens the ${rule.bundle!.bundleType}, which runs ${missingSteps.join(' and ')} after approval, so those must be in the set too.`,
      });
    }
  });
  return issues;
}

export interface CapabilitySetFit {
  kept: CapabilityId[];
  dropped: { capabilityId: CapabilityId; reason: string }[];
}

// The builder's use of the rules: remove every capability that breaks one,
// repeat until the set is stable, and say why each was removed. It never adds
// a capability the model or the template did not name.
export function fitCapabilitySet(capabilities: readonly CapabilityId[]): CapabilitySetFit {
  let kept = [...new Set(capabilities)];
  const dropped: CapabilitySetFit['dropped'] = [];
  for (;;) {
    const issues = validateCapabilitySet(kept).filter((i) => i.capabilityId !== '');
    if (issues.length === 0) break;
    const bad = new Set(issues.map((i) => i.capabilityId));
    for (const issue of issues) {
      if (!dropped.some((d) => d.capabilityId === issue.capabilityId)) {
        dropped.push({ capabilityId: issue.capabilityId as CapabilityId, reason: issue.message });
      }
    }
    kept = kept.filter((c) => !bad.has(c));
  }
  return { kept, dropped };
}

// Knowledge scopes that follow from a capability, for a custom agent whose
// scopes the model did not name. The pairing is the builder's choice; the
// scope values are from CONTRACTS.md.
const CAPABILITY_KNOWLEDGE_SCOPES: Partial<Record<CapabilityId, readonly KnowledgeScope[]>> = {
  'catalog.read': ['catalog'],
  'business.facts.read': ['hours', 'faq'],
  'order.propose': ['order_policies'],
  'calendar.availability.read': ['services'],
  'booking.propose': ['services'],
};

export function knowledgeScopesForCapabilities(capabilities: readonly CapabilityId[]): KnowledgeScope[] {
  const out: KnowledgeScope[] = [...TEMPLATE_KNOWLEDGE_SCOPES.custom];
  for (const id of capabilities) for (const s of CAPABILITY_KNOWLEDGE_SCOPES[id] ?? []) if (!out.includes(s)) out.push(s);
  return out;
}

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

// What the builder model sees of the registry, including the set rules, so it
// can pick a valid subset. The builder checks the result anyway.
export function registryForModel(): {
  id: CapabilityId;
  description: string;
  effect: Effect;
  needs: CapabilityId[];
  onlyWith: CapabilityId[];
}[] {
  return CAPABILITY_REGISTRY.map(({ id, description, effect }) => {
    const rule = CAPABILITY_RULES[id];
    const needs = [...(rule?.needs ?? []), ...(rule?.bundle?.runs ?? [])];
    const onlyWith = isToolEffect(effect) ? [] : openedBy(id);
    return { id, description, effect, needs, onlyWith };
  });
}

// Re-exported so callers need one import for capability IDs.
export { CapabilityIdSchema };
