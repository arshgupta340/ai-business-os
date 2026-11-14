import { describe, expect, it } from 'vitest';
import {
  ACTION_TYPE_CAPABILITY,
  ActionTypeSchema,
  BUNDLE_ACTIONS,
  CAPABILITIES,
  CAPABILITY_LIST,
  CapabilityIdSchema,
  CapabilityNotAllowedError,
  TOOL_CAPABILITY,
  TOOL_DEFINITIONS,
  ToolNameSchema,
  assertToolCapabilities,
  capabilitiesForBundle,
  executionStepsFor,
  toolCapabilities,
  toolsForCapabilities,
  validateSpecCapabilities,
  validateToolCapabilities,
} from './index';

// SPEC 2.2, written out.
const SPEC_CAPABILITIES = [
  ['catalog.read', 'read', 'none', 'MUST'],
  ['business.facts.read', 'read', 'none', 'MUST'],
  ['order.quote', 'read', 'none', 'MUST'],
  ['order.propose', 'propose', 'creates_approval', 'MUST'],
  ['order.status.read', 'read', 'none', 'MUST'],
  ['order.checkout.prepare', 'write', 'required', 'MUST'],
  ['message.checkout.send', 'external_message', 'required', 'MUST'],
  ['calendar.availability.read', 'read', 'none', 'MUST'],
  ['booking.propose', 'propose', 'creates_approval', 'MUST'],
  ['calendar.event.create', 'write', 'required', 'MUST'],
  ['message.booking.confirm', 'external_message', 'required', 'MUST'],
  ['sheets.rows.append', 'write', 'required', 'MUST'],
  ['catalog.price.update', 'write', 'required', 'SHOULD'],
] as const;

describe('capability registry', () => {
  it('has exactly the SPEC 2.2 capabilities with the right effect, approval mode and tier', () => {
    expect(CapabilityIdSchema.options.length).toBe(SPEC_CAPABILITIES.length);
    for (const [id, effect, approvalMode, tier] of SPEC_CAPABILITIES) {
      const cap = CAPABILITIES[id];
      expect(cap.id).toBe(id);
      expect(cap.effect).toBe(effect);
      expect(cap.approvalMode).toBe(approvalMode);
      expect(cap.tier).toBe(tier);
    }
  });

  it('obeys the database checks: write/external_message iff required, propose iff creates_approval', () => {
    for (const cap of CAPABILITY_LIST) {
      expect(cap.effect === 'write' || cap.effect === 'external_message').toBe(cap.approvalMode === 'required');
      expect(cap.effect === 'propose').toBe(cap.approvalMode === 'creates_approval');
      expect(cap.timeoutMs).toBeGreaterThanOrEqual(100);
      expect(cap.timeoutMs).toBeLessThanOrEqual(60000);
      expect(cap.id).toMatch(/^[a-z]+(\.[a-z]+)+$/);
    }
  });

  it('maps every action type as SPEC 2.3 says', () => {
    expect(ACTION_TYPE_CAPABILITY).toEqual({
      'square.checkout.create': 'order.checkout.prepare',
      'message.checkout.send': 'message.checkout.send',
      'calendar.event.create': 'calendar.event.create',
      'message.booking.confirm': 'message.booking.confirm',
      'sheets.order.append': 'sheets.rows.append',
      'sheets.booking.append': 'sheets.rows.append',
      'square.catalog.price.update': 'catalog.price.update',
      'local.order.record': null,
      'local.booking.record': null,
      'local.fact.update': null,
      'local.catalog.sync': null,
    });
    expect(Object.keys(ACTION_TYPE_CAPABILITY).sort()).toEqual([...ActionTypeSchema.options].sort());
  });

  it('has the SPEC 2.3 bundles in order', () => {
    expect(BUNDLE_ACTIONS).toEqual({
      order_bundle: ['square.checkout.create', 'message.checkout.send', 'local.order.record', 'sheets.order.append'],
      booking_bundle: ['calendar.event.create', 'message.booking.confirm', 'local.booking.record', 'sheets.booking.append'],
      fact_edit: ['local.fact.update'],
      price_edit: ['square.catalog.price.update', 'local.catalog.sync'],
    });
    expect(capabilitiesForBundle('order_bundle')).toEqual(['order.checkout.prepare', 'message.checkout.send', 'sheets.rows.append']);
  });

  it('creates no execution row for the Sheets step at approval (SPEC 2.9)', () => {
    expect(executionStepsFor('order_bundle')).toEqual([
      { actionType: 'square.checkout.create', stepIndex: 0 },
      { actionType: 'message.checkout.send', stepIndex: 1 },
      { actionType: 'local.order.record', stepIndex: 2 },
    ]);
    expect(executionStepsFor('booking_bundle').map((s) => s.actionType)).not.toContain('sheets.booking.append');
    expect(executionStepsFor('fact_edit')).toEqual([{ actionType: 'local.fact.update', stepIndex: 0 }]);
  });

  it('maps tools as SPEC 2.6 says, and no tool maps to a write or external_message capability', () => {
    expect(TOOL_CAPABILITY).toEqual({
      read_catalog: 'catalog.read',
      read_business_facts: 'business.facts.read',
      quote_order: 'order.quote',
      propose_order: 'order.propose',
      get_order_status: 'order.status.read',
      read_calendar_availability: 'calendar.availability.read',
      propose_booking: 'booking.propose',
    });
    for (const tool of ToolNameSchema.options) {
      const effect = CAPABILITIES[TOOL_CAPABILITY[tool]].effect;
      expect(['read', 'propose']).toContain(effect);
    }
    expect(TOOL_DEFINITIONS).toHaveLength(7);
  });

  it('refuses a write or external_message capability as a tool, and unknown ids', () => {
    expect(validateToolCapabilities(['catalog.read', 'order.propose'])).toEqual({ ok: true, capabilities: ['catalog.read', 'order.propose'] });
    const bad = validateToolCapabilities(['catalog.read', 'order.checkout.prepare', 'message.checkout.send', 'sms.checkout.send']);
    expect(bad).toEqual({ ok: false, code: 'CAPABILITY_NOT_ALLOWED', unknown: ['sms.checkout.send'], notAllowed: ['order.checkout.prepare', 'message.checkout.send'] });
    expect(() => assertToolCapabilities(['calendar.event.create'])).toThrow(CapabilityNotAllowedError);
    expect(validateSpecCapabilities(['order.checkout.prepare']).ok).toBe(true);
    expect(validateSpecCapabilities(['made.up']).ok).toBe(false);
  });

  it('derives tools from a spec: the pizza spec gets five tools, never a write', () => {
    const pizza = ['catalog.read', 'business.facts.read', 'order.quote', 'order.propose', 'order.status.read', 'order.checkout.prepare', 'message.checkout.send', 'sheets.rows.append'] as const;
    expect(toolsForCapabilities(pizza)).toEqual(['read_catalog', 'read_business_facts', 'quote_order', 'propose_order', 'get_order_status']);
    expect(toolCapabilities(pizza)).toEqual(['catalog.read', 'business.facts.read', 'order.quote', 'order.propose', 'order.status.read']);
    const barber = ['business.facts.read', 'calendar.availability.read', 'booking.propose', 'calendar.event.create', 'message.booking.confirm', 'sheets.rows.append'] as const;
    expect(toolsForCapabilities(barber)).toEqual(['read_business_facts', 'read_calendar_availability', 'propose_booking']);
  });
});
