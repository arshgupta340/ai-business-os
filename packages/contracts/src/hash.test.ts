import { createHash } from 'node:crypto'; // test only: cross-checks the Web Crypto implementation
import { describe, expect, it } from 'vitest';
import {
  MATERIAL_FIELDS,
  approvalPayloadHash,
  canonicalJson,
  cartHash,
  hashCanonical,
  toCanonicalTimestamp,
  idempotencyKey,
  newId,
  normalizeCart,
  payloadHash,
  pickMaterialFields,
  sha256Hex,
  verifyPayloadHash,
  type OrderApprovalPayload,
} from './index';

const nodeSha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const orderPayload: OrderApprovalPayload = {
  businessId: 'biz_pizza_01',
  subjectId: 'ord_123',
  agentVersionId: 'agv_pizza_01_v2',
  cartHash: `sha256:${'ab'.repeat(32)}`,
  totalMinor: 3264,
  currency: 'USD',
  pickupAt: '2026-11-14T02:00:00Z',
  messageRecipient: '+15555550123',
  messageChannel: 'surge',
  actionBundle: ['square.checkout.create', 'message.checkout.send', 'local.order.record', 'sheets.order.append'],
  expiresAt: '2026-11-13T19:52:00Z',
};

describe('canonical JSON', () => {
  it('sorts keys at every depth, no whitespace, keeps array order, omits undefined', () => {
    expect(canonicalJson({ b: [2, { d: 'x', c: null }], a: 1, z: undefined })).toBe('{"a":1,"b":[2,{"c":null,"d":"x"}]}');
  });
  it('is key-order independent', () => {
    const one = { x: { q: 1, p: [3, 2, 1] }, a: 'A', m: true };
    const two = { m: true, a: 'A', x: { p: [3, 2, 1], q: 1 } };
    expect(canonicalJson(one)).toBe(canonicalJson(two));
  });
  it('sorts by code point, not UTF-16 unit', () => {
    // U+FF5E (BMP, high) sorts before U+1F600 (astral) by code point; UTF-16 unit order would flip them.
    expect(canonicalJson({ '\u{1F600}': 1, '～': 2 })).toBe('{"～":2,"\u{1F600}":1}');
  });
  it('refuses values JSON cannot represent', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow();
    expect(() => canonicalJson({ f: () => 1 })).toThrow();
  });
});

describe('hashes (Web Crypto)', () => {
  it('sha256Hex known answer', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256Hex('é ✓ \u{1F600}')).toBe(nodeSha('é ✓ \u{1F600}'));
  });

  it('hashCanonical known answer', async () => {
    expect(await hashCanonical({ b: [2, { d: 'x', c: null }], a: 1 })).toBe('sha256:b4f0036845818c4edffa7f8a39a31a071b41811a62ccbdeaa149f2c006dbb271');
  });

  it('payload hash matches node:crypto over the canonical JSON', async () => {
    const h = await payloadHash(orderPayload);
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(h).toBe(`sha256:${nodeSha(canonicalJson(orderPayload))}`);
  });

  it('idempotency key known answer: hex of sha256(businessId:subjectId:actionType:approvalId)', async () => {
    const key = await idempotencyKey({ businessId: 'biz_pizza_01', subjectId: 'ord_123', actionType: 'square.checkout.create', approvalId: 'apv_123' });
    expect(key).toBe('2fd6d973a180e400b74a9947b499dc765bae29b092d3e26166f234da71177985');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changing any one material field of an order payload changes the hash', async () => {
    const base = await approvalPayloadHash('order_bundle', orderPayload);
    const changes: Partial<Record<keyof OrderApprovalPayload, unknown>> = {
      businessId: 'biz_barber_01',
      subjectId: 'ord_124',
      agentVersionId: 'agv_pizza_01_v3',
      cartHash: `sha256:${'cd'.repeat(32)}`,
      totalMinor: 3265,
      pickupAt: '2026-11-14T02:15:00Z',
      messageRecipient: '+15555550124',
      messageChannel: 'qr_only',
      expiresAt: '2026-11-13T19:53:00Z',
    };
    for (const [field, value] of Object.entries(changes)) {
      expect(await approvalPayloadHash('order_bundle', { ...orderPayload, [field]: value }), field).not.toBe(base);
    }
    // currency and actionBundle are literals, so a change cannot even parse.
    expect(() => pickMaterialFields('order_bundle', { ...orderPayload, currency: 'EUR' })).toThrow();
    expect(MATERIAL_FIELDS.order_bundle).toHaveLength(11);
  });

  it('a non-material field does not change the hash', async () => {
    const base = await approvalPayloadHash('order_bundle', orderPayload);
    const withExtras = { ...orderPayload, callId: 'call_77', quote: { quoteId: 'qte_1' }, contact: { name: 'Sam' } };
    expect(await approvalPayloadHash('order_bundle', withExtras)).toBe(base);
    expect(await verifyPayloadHash('order_bundle', withExtras, base)).toBe(true);
    expect(await verifyPayloadHash('order_bundle', { ...withExtras, totalMinor: 1 }, base)).toBe(false);
  });

  it('a missing material field is refused', () => {
    const { pickupAt: _omit, ...rest } = orderPayload;
    expect(() => pickMaterialFields('order_bundle', rest)).toThrow();
  });

  it('fact_edit keeps before: null in the hash', async () => {
    const fact = {
      businessId: 'biz_pizza_01', subjectId: 'fact_new_1', kind: 'faq', key: 'parking', fromVersion: 0,
      before: null, after: { answer: 'Street parking' }, actionBundle: ['local.fact.update'], expiresAt: '2026-11-13T20:10:00Z',
    };
    const picked = pickMaterialFields('fact_edit', fact);
    expect(canonicalJson(picked)).toContain('"before":null');
    expect(() => pickMaterialFields('fact_edit', { ...fact, before: undefined })).toThrow();
  });
});

describe('cart hash', () => {
  it('ignores line order and modifier order', async () => {
    const a = { lines: [
      { catalogItemId: 'SQ_ITEM_MARG', variationId: 'SQ_VAR_MARG_LG', quantity: 1, modifierIds: ['SQ_MOD_OLV', 'SQ_MOD_MUSH'] },
      { catalogItemId: 'SQ_ITEM_PEP', variationId: 'SQ_VAR_PEP_LG', quantity: 1, modifierIds: [] },
    ] };
    const b = { lines: [
      { catalogItemId: 'SQ_ITEM_PEP', variationId: 'SQ_VAR_PEP_LG', quantity: 1, modifierIds: [] },
      { catalogItemId: 'SQ_ITEM_MARG', variationId: 'SQ_VAR_MARG_LG', quantity: 1, modifierIds: ['SQ_MOD_MUSH', 'SQ_MOD_OLV'] },
    ] };
    expect(await cartHash(a)).toBe(await cartHash(b));
    expect(await cartHash(a)).not.toBe(await cartHash({ lines: [{ ...a.lines[0]!, quantity: 2 }, a.lines[1]!] }));
    expect(normalizeCart(a).lines[0]?.modifierIds).toEqual(['SQ_MOD_MUSH', 'SQ_MOD_OLV']);
  });
  it('breaks ties on the same variation by modifiers, then note', () => {
    const cart = { lines: [
      { catalogItemId: 'I', variationId: 'V', quantity: 1, modifierIds: ['M2'], note: 'b' },
      { catalogItemId: 'I', variationId: 'V', quantity: 1, modifierIds: ['M1'] },
      { catalogItemId: 'I', variationId: 'V', quantity: 1, modifierIds: ['M2'], note: 'a' },
    ] };
    expect(normalizeCart(cart).lines.map((l) => `${l.modifierIds.join(',')}|${l.note ?? ''}`)).toEqual(['M1|', 'M2|a', 'M2|b']);
  });
});

describe('newId', () => {
  it('makes a prefixed id like gen_id', () => {
    expect(newId('ord_')).toMatch(/^ord_[0-9a-f]{32}$/);
    expect(newId('ord_')).not.toBe(newId('ord_'));
  });
});

describe('toCanonicalTimestamp', () => {
  it('gives one toISOString() form for every spelling of an instant, so the hash is the same', async () => {
    const forms = ['2026-11-14T20:30:00Z', '2026-11-14T20:30:00.000Z', '2026-11-14T20:30:00+00:00', '2026-11-14T12:30:00-08:00'];
    for (const f of forms) expect(toCanonicalTimestamp(f)).toBe('2026-11-14T20:30:00.000Z');
    expect(toCanonicalTimestamp(new Date('2026-11-14T20:30:00Z'))).toBe('2026-11-14T20:30:00.000Z');
    expect(toCanonicalTimestamp(Date.parse('2026-11-14T20:30:00Z'))).toBe('2026-11-14T20:30:00.000Z');
    expect(await hashCanonical({ t: '2026-11-14T20:30:00Z' })).not.toBe(await hashCanonical({ t: '2026-11-14T20:30:00+00:00' }));
    expect(await hashCanonical({ t: toCanonicalTimestamp('2026-11-14T20:30:00Z') })).toBe(await hashCanonical({ t: toCanonicalTimestamp('2026-11-14T20:30:00+00:00') }));
    expect(() => toCanonicalTimestamp('not a time')).toThrow();
  });
});
