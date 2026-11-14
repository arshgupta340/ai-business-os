import { describe, expect, it } from 'vitest';
import { CAPABILITIES, CAPABILITY_LIST, TOOL_CAPABILITY as PACKAGE_TOOL_CAPABILITY, ToolNameSchema, type CapabilityId } from '@abos/contracts';
import {
  assertToolsReadOrPropose,
  CAPABILITY_REGISTRY,
  CAPABILITY_RULES,
  fitCapabilitySet,
  knowledgeScopesForCapabilities,
  openedBy,
  registryForModel,
  validateCapabilitySet,
  getCapability,
  permissionSummary,
  splitRequestedCapabilities,
  TEMPLATE_CAPABILITIES,
  TOOL_CAPABILITY,
  toolsForCapabilities,
  validateCapabilitiesAgainstRegistry,
} from './registry';

describe('capability registry', () => {
  it('has the thirteen capabilities of CONTRACTS.md section 2', () => {
    expect(CAPABILITY_REGISTRY.map((c) => c.id)).toHaveLength(13);
    expect(getCapability('order.checkout.prepare')).toMatchObject({ effect: 'write', approvalMode: 'required' });
    expect(getCapability('order.propose')).toMatchObject({ effect: 'propose', approvalMode: 'creates_approval' });
  });

  it('maps every agent tool to a read or propose capability, never a write', () => {
    for (const tool of ToolNameSchema.options) {
      const effect = getCapability(TOOL_CAPABILITY[tool])!.effect;
      expect(['read', 'propose']).toContain(effect);
    }
    const writeIds = CAPABILITY_REGISTRY.filter((c) => c.effect === 'write' || c.effect === 'external_message').map((c) => c.id);
    expect(Object.values(TOOL_CAPABILITY).some((id) => writeIds.includes(id))).toBe(false);
  });

  it('takes the registry rows and the tool map from the package', () => {
    expect(TOOL_CAPABILITY).toBe(PACKAGE_TOOL_CAPABILITY);
    expect(CAPABILITY_REGISTRY).toBe(CAPABILITY_LIST);
    expect(getCapability('order.propose')).toBe(CAPABILITIES['order.propose']);
    expect(getCapability('payment.refund.issue')).toBeUndefined();
  });

  it('the load-time check fails when a tool maps to a write, a message or an unknown capability', () => {
    expect(() => assertToolsReadOrPropose(TOOL_CAPABILITY)).not.toThrow();
    expect(() => assertToolsReadOrPropose({ ...TOOL_CAPABILITY, propose_order: 'order.checkout.prepare' })).toThrow(/propose_order maps to order.checkout.prepare with effect write/);
    expect(() => assertToolsReadOrPropose({ send_link: 'message.checkout.send' })).toThrow(/effect external_message/);
    expect(() => assertToolsReadOrPropose({ refund: 'payment.refund.issue' })).toThrow(/effect undefined/);
  });

  it('strips an unregistered capability and reports it', () => {
    const split = splitRequestedCapabilities(['catalog.read', 'marketing.sms.broadcast', 'catalog.read', 42, ' order.quote ']);
    expect(split.allowed).toEqual(['catalog.read', 'order.quote']);
    expect(split.unsupported).toEqual(['marketing.sms.broadcast', '42']);
  });

  it('flags unregistered capabilities in a spec by position', () => {
    expect(validateCapabilitiesAgainstRegistry(['catalog.read', 'publish_agent'])).toEqual([
      { path: 'capabilities.1', message: 'Capability publish_agent is not in the registry.' },
    ]);
    expect(validateCapabilitiesAgainstRegistry(TEMPLATE_CAPABILITIES.restaurant_order_taker)).toEqual([]);
  });

  it('turns only read and propose capabilities into tools', () => {
    expect(toolsForCapabilities([...TEMPLATE_CAPABILITIES.restaurant_order_taker])).toEqual([
      'read_catalog',
      'read_business_facts',
      'quote_order',
      'propose_order',
      'get_order_status',
    ]);
    expect(toolsForCapabilities(['order.checkout.prepare', 'message.checkout.send', 'sheets.rows.append', 'catalog.price.update'])).toEqual([]);
  });

  it('summarizes permissions by effect', () => {
    expect(permissionSummary([...TEMPLATE_CAPABILITIES.restaurant_order_taker])).toEqual({
      readOnly: ['catalog.read', 'business.facts.read', 'order.quote', 'order.status.read'],
      proposes: ['order.propose'],
      approvalRequired: ['order.checkout.prepare', 'message.checkout.send', 'sheets.rows.append'],
    });
  });
});

const ORDER_BUNDLE: CapabilityId[] = ['order.checkout.prepare', 'message.checkout.send', 'sheets.rows.append'];
const BOOKING_BUNDLE: CapabilityId[] = ['calendar.event.create', 'message.booking.confirm', 'sheets.rows.append'];
const messages = (set: readonly unknown[]) => validateCapabilitySet(set).map((i) => [i.path, i.message]);

describe('capability set rules (P-13)', () => {
  it('accepts the FAQ-only subset and both template sets', () => {
    expect(validateCapabilitySet(['catalog.read', 'business.facts.read'])).toEqual([]);
    expect(validateCapabilitySet(['business.facts.read'])).toEqual([]);
    expect(validateCapabilitySet(TEMPLATE_CAPABILITIES.restaurant_order_taker)).toEqual([]);
    expect(validateCapabilitySet(TEMPLATE_CAPABILITIES.appointment_booker)).toEqual([]);
    expect(validateCapabilitySet(['catalog.read', 'business.facts.read', 'order.quote'])).toEqual([]);
  });

  it('gives the FAQ-only agent read tools and no propose tool', () => {
    const tools = toolsForCapabilities(['catalog.read', 'business.facts.read']);
    expect(tools).toEqual(['read_catalog', 'read_business_facts']);
    expect(tools.some((t) => t.startsWith('propose_'))).toBe(false);
  });

  it('refuses an empty set and an unregistered capability', () => {
    expect(messages([])).toEqual([['capabilities', 'An agent needs at least one capability.']]);
    expect(messages(['catalog.read', 'refund.issue'])).toEqual([['capabilities.1', 'Capability refund.issue is not in the registry.']]);
  });

  it('refuses a read or propose capability without what it needs, with the reason', () => {
    expect(messages(['order.quote'])).toEqual([
      ['capabilities.0', 'order.quote needs catalog.read. A quote is built from exact item and size IDs, which only the catalog gives.'],
    ]);
    expect(messages(['catalog.read', 'order.propose', ...ORDER_BUNDLE])).toEqual([
      ['capabilities.1', 'order.propose needs order.quote. An order is proposed on a quote the caller heard read back, built from catalog IDs.'],
    ]);
    expect(messages(['catalog.read', 'business.facts.read', 'order.status.read'])).toEqual([
      ['capabilities.2', 'order.status.read needs order.propose. It reads the status of an order placed on the call, so the agent must be able to propose orders.'],
    ]);
    expect(messages(['calendar.availability.read'])).toEqual([
      ['capabilities.0', 'calendar.availability.read needs business.facts.read. Free slots are asked for one service, and the services come from the business facts.'],
    ]);
    expect(messages(['business.facts.read', 'booking.propose', ...BOOKING_BUNDLE])).toEqual([
      ['capabilities.1', 'booking.propose needs calendar.availability.read. A booking is proposed for a slot the agent found free, for a service it read.'],
    ]);
  });

  it('refuses a propose capability whose approved bundle steps are not in the set', () => {
    expect(messages(['catalog.read', 'order.quote', 'order.propose'])).toEqual([
      ['capabilities.2', 'order.propose opens the order_bundle, which runs order.checkout.prepare and message.checkout.send and sheets.rows.append after approval, so those must be in the set too.'],
    ]);
    expect(messages(['business.facts.read', 'calendar.availability.read', 'booking.propose', 'calendar.event.create', 'sheets.rows.append'])).toEqual([
      ['capabilities.2', 'booking.propose opens the booking_bundle, which runs message.booking.confirm after approval, so those must be in the set too.'],
    ]);
  });

  it('never lets a write or message capability be chosen on its own', () => {
    expect(messages(['business.facts.read', 'message.checkout.send'])).toEqual([
      ['capabilities.1', 'message.checkout.send runs only inside an approved bundle that order.propose opens. It cannot be chosen on its own.'],
    ]);
    expect(messages(['catalog.read', 'order.checkout.prepare'])).toEqual([
      ['capabilities.1', 'order.checkout.prepare runs only inside an approved bundle that order.propose opens. It cannot be chosen on its own.'],
    ]);
    expect(messages(['business.facts.read', 'calendar.event.create'])).toEqual([
      ['capabilities.1', 'calendar.event.create runs only inside an approved bundle that booking.propose opens. It cannot be chosen on its own.'],
    ]);
    expect(messages(['business.facts.read', 'message.booking.confirm'])).toEqual([
      ['capabilities.1', 'message.booking.confirm runs only inside an approved bundle that booking.propose opens. It cannot be chosen on its own.'],
    ]);
    expect(messages(['business.facts.read', 'sheets.rows.append'])).toEqual([
      ['capabilities.1', 'sheets.rows.append runs only inside an approved bundle that order.propose or booking.propose opens. It cannot be chosen on its own.'],
    ]);
    // No agent bundle runs a price change, so even a full order set cannot hold it.
    expect(messages([...TEMPLATE_CAPABILITIES.restaurant_order_taker, 'catalog.price.update'])).toEqual([
      ['capabilities.8', 'catalog.price.update is never part of a phone agent. It runs only when the owner approves that change directly.'],
    ]);
  });

  it('keeps the rules in one table and derives the bundle openers from it', () => {
    expect(Object.keys(CAPABILITY_RULES).sort()).toEqual(['booking.propose', 'calendar.availability.read', 'order.propose', 'order.quote', 'order.status.read']);
    expect(openedBy('sheets.rows.append')).toEqual(['order.propose', 'booking.propose']);
    expect(openedBy('catalog.price.update')).toEqual([]);
    // Every bundle step is a write or message capability, never a tool.
    for (const rule of Object.values(CAPABILITY_RULES)) {
      for (const id of rule!.bundle?.runs ?? []) expect(['write', 'external_message']).toContain(getCapability(id)!.effect);
    }
  });

  it('fits a set by removing what breaks a rule, repeating until stable, never adding', () => {
    expect(fitCapabilitySet(['catalog.read', 'order.quote', 'order.propose', 'order.checkout.prepare'])).toEqual({
      kept: ['catalog.read', 'order.quote'],
      dropped: [
        { capabilityId: 'order.propose', reason: expect.stringContaining('order.propose opens the order_bundle') },
        { capabilityId: 'order.checkout.prepare', reason: expect.stringContaining('runs only inside an approved bundle') },
      ],
    });
    expect(fitCapabilitySet(['catalog.read', 'business.facts.read'])).toEqual({ kept: ['catalog.read', 'business.facts.read'], dropped: [] });
  });

  it('derives knowledge scopes from capabilities and tells the model the rules', () => {
    expect(knowledgeScopesForCapabilities(['catalog.read', 'business.facts.read'])).toEqual(['business_profile', 'catalog', 'hours', 'faq']);
    const forModel = registryForModel();
    expect(forModel.find((c) => c.id === 'order.propose')).toMatchObject({ needs: ['catalog.read', 'order.quote', ...ORDER_BUNDLE], onlyWith: [] });
    expect(forModel.find((c) => c.id === 'message.checkout.send')).toMatchObject({ needs: [], onlyWith: ['order.propose'] });
  });
});
