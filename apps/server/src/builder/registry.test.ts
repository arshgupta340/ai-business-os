import { describe, expect, it } from 'vitest';
import { ToolNameSchema } from './pending-contracts';
import {
  CAPABILITY_REGISTRY,
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
