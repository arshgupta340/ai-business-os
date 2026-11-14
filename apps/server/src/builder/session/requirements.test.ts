import { describe, expect, it } from 'vitest';
import type { BusinessFact } from '@abos/contracts';
import { TEMPLATE_CAPABILITIES } from '../registry';
import { FixtureBusinessKnowledge, type BusinessContext } from './knowledge';
import { computeFieldStatus, requiredFields, stopConditions, suggestions } from './requirements';

const knowledge = new FixtureBusinessKnowledge();

// The shared fixtures already hold the consent and notice policies (seeded as
// if an earlier interview had answered them). These tests remove them to show
// how a missing field is found and then answered.
async function contextWithout(businessId: string, keys: string[]): Promise<BusinessContext> {
  const ctx = (await knowledge.getContext(businessId))!;
  return { ...ctx, verifiedFacts: ctx.verifiedFacts.filter((f) => !(f.kind === 'policy' && keys.includes(f.key))) };
}
const pizzaSpec = { template: 'restaurant_order_taker' as const, capabilities: [...TEMPLATE_CAPABILITIES.restaurant_order_taker] };
const barberSpec = { template: 'appointment_booker' as const, capabilities: [...TEMPLATE_CAPABILITIES.appointment_booker] };

function draft(businessId: string, kind: BusinessFact['kind'], key: string): BusinessFact {
  return {
    id: `fact_d_${key}`,
    businessId,
    kind,
    key,
    value: { text: 'x' },
    sourceType: 'owner_chat',
    sourceRef: 'bld_1',
    status: 'draft',
    confidence: 0.8,
    version: 1,
    createdAt: '2026-11-13T00:00:00Z',
    updatedAt: '2026-11-13T00:00:00Z',
  };
}

describe('missing-field computation', () => {
  it('needs nothing before a template is chosen', () => {
    expect(requiredFields({})).toEqual([]);
  });

  it('is the union of the capability requirements, without duplicates', () => {
    const fields = requiredFields(barberSpec);
    expect(fields).toContain('services');
    expect(fields).toContain('policy.min_notice');
    expect(fields.filter((f) => f === 'policy.message_consent')).toHaveLength(1);
  });

  it('subtracts verified facts and the catalog for the pizza shop', async () => {
    const full = computeFieldStatus({ ...pizzaSpec, name: 'A', goal: 'B' }, (await knowledge.getContext('biz_pizza_01'))!, []);
    expect(full.missing).toEqual([]);
    expect(full.evidence).toContain('fact_pizza_policy_message_consent');
    const status = computeFieldStatus({ ...pizzaSpec, name: 'A', goal: 'B' }, await contextWithout('biz_pizza_01', ['message_consent']), []);
    expect(status.missing).toEqual(['policy.message_consent']);
    expect(status.evidence).toContain('fact_pizza_policy_pickup_window');
  });

  it('counts a draft answer from this session as answered', async () => {
    expect(computeFieldStatus({ ...barberSpec, name: 'A', goal: 'B' }, (await knowledge.getContext('biz_barber_01'))!, []).missing).toEqual([]);
    const ctx = await contextWithout('biz_barber_01', ['min_notice', 'message_consent']);
    const before = computeFieldStatus({ ...barberSpec, name: 'A', goal: 'B' }, ctx, []);
    expect(before.missing).toEqual(['policy.min_notice', 'policy.message_consent']);
    const after = computeFieldStatus({ ...barberSpec, name: 'A', goal: 'B' }, ctx, [draft('biz_barber_01', 'policy', 'min_notice')]);
    expect(after.missing).toEqual(['policy.message_consent']);
  });

  it('reports missing name, goal, catalog and the stop conditions', () => {
    const ctx: BusinessContext = { profile: { id: 'biz_x', name: 'X', category: 'restaurant' }, verifiedFacts: [], catalogItemCount: 0, openRequiredConflictIds: ['cfl_1'] };
    const status = computeFieldStatus(pizzaSpec, ctx, []);
    expect(status.missing).toEqual(expect.arrayContaining(['name', 'goal', 'catalog.items', 'hours.mon', 'policy.message_consent']));
    expect(suggestions(status)).toEqual(['Upload menu', 'Use Square catalog']);
    expect(stopConditions(pizzaSpec, ctx, status).map((s) => s.code)).toEqual(['missing_timezone', 'open_conflict', 'missing_message_consent_policy']);
  });
});

describe('missing fields for the FAQ-only subset', () => {
  const faqSpec = { template: 'custom' as const, capabilities: ['catalog.read', 'business.facts.read'] as const };

  it('follow from the two read capabilities only', () => {
    const fields = requiredFields({ ...faqSpec, capabilities: [...faqSpec.capabilities] });
    expect(fields).toEqual(['name', 'goal', 'catalog.items', 'hours.mon', 'hours.tue', 'hours.wed', 'hours.thu', 'hours.fri', 'hours.sat', 'hours.sun']);
    for (const f of ['policy.pickup_window', 'policy.special_requests', 'policy.message_consent', 'policy.min_notice', 'services']) {
      expect(fields).not.toContain(f);
    }
  });

  it('asks a business with nothing known for hours and a menu, and raises no consent stop condition', () => {
    const ctx: BusinessContext = { profile: { id: 'biz_x', name: 'X', category: 'cafe', timezone: 'America/Los_Angeles' }, verifiedFacts: [], catalogItemCount: 0, openRequiredConflictIds: [] };
    const spec = { ...faqSpec, capabilities: [...faqSpec.capabilities], name: 'A', goal: 'B' };
    const status = computeFieldStatus(spec, ctx, []);
    expect(status.missing).toEqual(['catalog.items', 'hours.mon', 'hours.tue', 'hours.wed', 'hours.thu', 'hours.fri', 'hours.sat', 'hours.sun']);
    expect(stopConditions(spec, ctx, status)).toEqual([]);
    expect(suggestions(status)).toEqual(['Upload menu', 'Use Square catalog']);
  });

  it('needs nothing more at the pizza shop, and only the menu at the barbershop', async () => {
    const spec = { ...faqSpec, capabilities: [...faqSpec.capabilities], name: 'A', goal: 'B' };
    expect(computeFieldStatus(spec, (await knowledge.getContext('biz_pizza_01'))!, []).missing).toEqual([]);
    expect(computeFieldStatus(spec, (await knowledge.getContext('biz_barber_01'))!, []).missing).toEqual(['catalog.items']);
  });
});
