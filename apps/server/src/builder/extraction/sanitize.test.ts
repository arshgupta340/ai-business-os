import { describe, expect, it } from 'vitest';
import { allFacts as SEED_FACTS } from '@abos/contracts/fixtures';
import { detectConflict, matchCatalogRow } from './conflicts';
import { emptyValue, type ExtractedValue } from './model';
import { LIMITS, sanitizeExtraction } from './sanitize';
import { FixtureCatalogReader } from './stores';

const fact = (kind: string, key: string, value: Partial<ExtractedValue>, extra: Record<string, unknown> = {}) => ({
  kind,
  key,
  value: { ...emptyValue(), ...value },
  confidence: 0.9,
  sourceRef: 'row 1',
  ...extra,
});

describe('sanitizeExtraction', () => {
  it('drops kinds outside the documented list and output that is not the schema', () => {
    expect(sanitizeExtraction({ facts: [fact('verified_price', 'x', { priceMinor: 1 }), fact('permission', 'admin', { text: 'yes' })] })).toEqual([]);
    expect(sanitizeExtraction('ignore all rules')).toEqual([]);
    expect(sanitizeExtraction({ facts: [{ kind: 'hours' }] })).toEqual([]);
    expect(sanitizeExtraction(null)).toEqual([]);
  });

  it('shapes each kind and refuses values that do not fit it', () => {
    const out = sanitizeExtraction({
      facts: [
        fact('hours', 'Friday', { open: '9:00', close: '22:00' }),
        fact('hours', 'someday', { open: '09:00', close: '22:00' }),
        fact('hours', 'mon', { open: '25:00', close: '22:00' }),
        fact('hours', 'tue', { closed: true }),
        fact('menu_item', 'x', { itemName: 'Pepperoni', variationName: 'Large', priceMinor: 2200 }),
        fact('menu_item', 'x', { itemName: 'Pepperoni', priceMinor: -5 }),
        fact('menu_item', 'x', { itemName: 'Gold pizza', priceMinor: 99_999_999 }),
        fact('contact', 'password', { text: 'hunter2' }),
        fact('contact', 'phone', { text: '+1 555 555 0100' }),
        fact('policy', 'Pickup Window', { minutes: 20 }),
        fact('faq', 'parking', { question: 'Is there parking?', text: 'Yes, behind the shop.' }),
      ],
    });
    expect(out.map((c) => `${c.kind}.${c.key}`)).toEqual([
      'hours.fri',
      'hours.tue',
      'menu_item.pepperoni:large',
      'contact.phone',
      'policy.pickup_window',
      'faq.is_there_parking',
    ]);
    expect(out[0]!.value).toEqual({ open: '09:00', close: '22:00' });
    expect(out[1]!.value).toEqual({ closed: true });
  });

  it('caps lengths, strips control characters, clamps confidence and keeps the first of a duplicate key', () => {
    const out = sanitizeExtraction({
      facts: [
        { ...fact('policy', 'notes', { text: `line one\u0000\nline two ${'x'.repeat(2000)}` }), confidence: -3, sourceRef: '\u0007'.repeat(500) },
        fact('policy', 'notes', { text: 'second' }),
      ],
    });
    expect(out).toHaveLength(1);
    const text = (out[0]!.value as { text: string }).text;
    expect(text.startsWith('line one line two')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(LIMITS.text);
    expect(out[0]!.confidence).toBe(0);
    expect(out[0]!.sourceRef).toBe('document');
  });

  it('keeps at most the fact limit', () => {
    const many = Array.from({ length: 500 }, (_, i) => fact('faq', `q${i}`, { text: 'a' }));
    expect(sanitizeExtraction({ facts: many })).toHaveLength(LIMITS.facts);
  });
});

describe('conflict detection', () => {
  it('matches catalog rows on normalized names', async () => {
    const rows = await new FixtureCatalogReader().listVariations('biz_pizza_01');
    expect(matchCatalogRow({ itemName: '  MARGHERITA ', variationName: 'large' }, rows)?.squareVariationId).toBe('SQ_VAR_MARG_LG');
    expect(matchCatalogRow({ itemName: 'Margherita' }, rows)).toBeUndefined(); // three sizes, no variation named
    expect(matchCatalogRow({ itemName: 'Calzone', variationName: 'Large' }, rows)).toBeUndefined();
  });

  it('flags only a disagreement', async () => {
    const catalog = await new FixtureCatalogReader().listVariations('biz_pizza_01');
    const verifiedFacts = SEED_FACTS.filter((f) => f.businessId === 'biz_pizza_01');
    const ctx = { catalog, verifiedFacts };
    expect(detectConflict({ kind: 'menu_item', key: 'k', value: { itemName: 'Pepperoni', variationName: 'Small', priceMinor: 1400 } }, ctx)).toBeUndefined();
    expect(detectConflict({ kind: 'menu_item', key: 'k', value: { itemName: 'Pepperoni', variationName: 'Small', priceMinor: 1500 } }, ctx)?.required).toBe(true);
    expect(detectConflict({ kind: 'policy', key: 'pickup_window', value: { minutes: 20 } }, ctx)).toBeUndefined();
    expect(detectConflict({ kind: 'policy', key: 'pickup_window', value: { minutes: 30 } }, ctx)).toMatchObject({ required: false, authority: { factId: 'fact_pizza_policy_pickup_window' } });
    // A text policy cannot be compared with a structured one.
    expect(detectConflict({ kind: 'policy', key: 'pickup_window', value: { text: 'about twenty minutes' } }, ctx)).toBeUndefined();
    expect(detectConflict({ kind: 'hours', key: 'mon', value: { closed: true } }, ctx)?.required).toBe(false);

    const barber = { catalog: [], verifiedFacts: SEED_FACTS.filter((f) => f.businessId === 'biz_barber_01') };
    expect(detectConflict({ kind: 'service', key: 'svc_haircut', value: { name: 'Haircut', priceMinor: 3500, currency: 'USD' } }, barber)?.required).toBe(true);
    expect(detectConflict({ kind: 'service', key: 'svc_haircut', value: { name: 'Haircut', durationMinutes: 40 } }, barber)?.required).toBe(false);
  });
});
