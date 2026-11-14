import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { cartHash, QuoteSchema } from '@abos/contracts';
import { billPlugin, createBillCheckoutProvider, renderBillHtml, rewriteBillUrl } from '../../../src/adapters/bill';
import type { Bill, BillDeps, BillStore, CatalogRow, CheckoutInput } from '../../../src/adapters/bill';

const time = new Date('2026-11-14T12:00:00Z');
const lines = [{ catalogItemId: 'pizza', variationId: 'large', quantity: 2, modifierIds: ['cheese'] }];
function setup() {
  const saved = new Map<string, Bill>();
  let serial = 0;
  const row: CatalogRow = { businessId: 'biz_pizza_01', catalogItemId: 'pizza', id: 'large', name: 'Pizza', priceMinor: 101, currency: 'USD', available: true, modifierLists: [{ id: 'extras', name: 'Extras', selectionType: 'MULTIPLE', modifiers: [{ id: 'cheese', name: 'Cheese', priceMinor: 25 }] }] };
  const store: BillStore = {
    findByKey: vi.fn(async (businessId, key) => { const bill = saved.get(key); return bill?.businessId === businessId ? bill : undefined; }),
    findById: vi.fn(async (businessId, id) => [...saved.values()].find((b) => b.businessId === businessId && b.billId === id)),
    findByTokenHash: vi.fn(async (hash) => [...saved.values()].find((b) => b.tokenHash === hash)),
    putIfAbsent: vi.fn(async (bill) => { const winner = saved.get(bill.idempotencyKey) ?? structuredClone(bill); saved.set(bill.idempotencyKey, winner); return winner; }),
  };
  const deps: BillDeps = {
    catalog: { list: vi.fn(async () => [row]) }, facts: { taxRateBps: vi.fn(async () => 500) },
    business: { load: vi.fn(async () => ({ name: 'Pizza Co.' })) }, store,
    randomBytes: vi.fn((size) => new Uint8Array(size).fill(++serial)), now: () => new Date(time),
    publicBaseUrl: 'https://demo.example/', billTtlMs: 60000,
  };
  const input: CheckoutInput = { businessId: 'biz_pizza_01', orderId: 'ord_test', approvedTotalMinor: 265, currency: 'USD', lines, idempotencyKey: 'a'.repeat(64), pickupAt: '2026-11-14T13:00:00Z' };
  const provider = createBillCheckoutProvider(deps);
  return { saved, row, deps, store, input, provider };
}

describe('local bill pricing', () => {
  it('prices quantities and modifiers with the shared quote schema and hash', async () => {
    const { provider } = setup();
    const result = await provider.quoteLocal({ businessId: 'biz_pizza_01', lines });
    expect(result).toMatchObject({ ok: true, quote: { subtotalMinor: 252, taxMinor: 13, totalMinor: 265, currency: 'USD', cartHash: await cartHash({ lines }), lines: [{ unitPriceMinor: 101, lineTotalMinor: 252, quantity: 2, modifiers: [{ priceMinor: 25 }] }] } });
    if (result.ok) expect(QuoteSchema.safeParse(result.quote).success).toBe(true);
  });
  it.each([[1, 4999, 0], [1, 5000, 1], [1, 5001, 1], [3, 5000, 2], [101, 0, 0]])('rounds %i cents at %i bps to %i cents tax', async (price, rate, tax) => {
    const { provider, row, deps } = setup(); row.priceMinor = price; deps.facts.taxRateBps = async () => rate;
    expect(await provider.quoteLocal({ businessId: row.businessId, lines: [{ ...lines[0]!, quantity: 1, modifierIds: [] }] })).toMatchObject({ ok: true, quote: { taxMinor: tax } });
  });
  it('rounds once across multiple lines', async () => {
    const { provider, row, deps } = setup(); row.priceMinor = 1; deps.facts.taxRateBps = async () => 5000;
    const line = { ...lines[0]!, quantity: 1, modifierIds: [] };
    expect(await provider.quoteLocal({ businessId: row.businessId, lines: [line, line] })).toMatchObject({ ok: true, quote: { taxMinor: 1, subtotalMinor: 2 } });
  });
  it.each([0, -1, 1.5, 21, Number.MAX_SAFE_INTEGER + 1])('refuses invalid quantity %s', async (quantity) => {
    const { provider } = setup(); expect(await provider.quoteLocal({ businessId: 'biz_pizza_01', lines: [{ ...lines[0]!, quantity }] })).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
  });
  it.each(['missing', 'unavailable', 'modifier', 'foreign'])('refuses %s items or modifiers', async (kind) => {
    const { provider, row } = setup();
    if (kind === 'missing') row.id = 'other';
    if (kind === 'unavailable') row.available = false;
    if (kind === 'modifier') row.modifierLists = [];
    if (kind === 'foreign') row.businessId = 'biz_other';
    expect(await provider.quoteLocal({ businessId: 'biz_pizza_01', lines })).toMatchObject({ ok: false, code: 'ITEM_UNAVAILABLE' });
  });
  it('refuses non-USD catalog prices', async () => {
    const { provider, row } = setup(); row.currency = 'EUR'; expect(await provider.quoteLocal({ businessId: row.businessId, lines })).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
  });
  it('refuses a missing verified tax rate', async () => {
    const { provider, deps } = setup(); deps.facts.taxRateBps = async () => undefined;
    expect(await provider.quoteLocal({ businessId: 'biz_pizza_01', lines })).toMatchObject({ ok: false, code: 'INTEGRATION_UNAVAILABLE' });
  });
  it.each([-1, 1.5, 10001, Number.MAX_SAFE_INTEGER + 1])('refuses an invalid tax rate of %s basis points', async (rate) => {
    const { provider, deps } = setup(); deps.facts.taxRateBps = async () => rate;
    expect(await provider.quoteLocal({ businessId: 'biz_pizza_01', lines })).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
  });
  it('rejects overflow without losing integer precision', async () => {
    const { provider, row } = setup(); row.priceMinor = Number.MAX_SAFE_INTEGER;
    expect(await provider.quoteLocal({ businessId: row.businessId, lines })).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
  });
  it('rejects duplicate and excess SINGLE modifiers', async () => {
    const { provider, row } = setup();
    expect(await provider.quoteLocal({ businessId: row.businessId, lines: [{ ...lines[0]!, modifierIds: ['cheese', 'cheese'] }] })).toMatchObject({ ok: false });
    row.modifierLists[0]!.selectionType = 'SINGLE'; row.modifierLists[0]!.modifiers.push({ id: 'olives', name: 'Olives', priceMinor: 0 });
    expect(await provider.quoteLocal({ businessId: row.businessId, lines: [{ ...lines[0]!, modifierIds: ['cheese', 'olives'] }] })).toMatchObject({ ok: false });
  });
});

describe('bill checkout', () => {
  it('creates nothing on an approved total mismatch', async () => {
    const { provider, input, store, deps } = setup(); input.approvedTotalMinor++;
    await expect(provider.createCheckout(input)).rejects.toMatchObject({ outcome: 'total_mismatch', code: 'INVALID_STATE', orderState: 'RECOVERY_REQUIRED' });
    expect(store.putIfAbsent).not.toHaveBeenCalled(); expect(deps.randomBytes).not.toHaveBeenCalled();
  });
  it('returns the same bill on retry and resume without repricing', async () => {
    const { provider, input, deps } = setup(); const callback = vi.fn(); input.onLinkCreated = callback;
    const first = await provider.createCheckout(input);
    deps.catalog.list = async () => { throw new Error('not read'); };
    expect(await provider.createCheckout(input)).toEqual(first);
    expect(await provider.resumeCheckout(input)).toEqual(first);
    expect(await provider.resumeCheckout({ businessId: input.businessId, orderId: input.orderId, squareOrderId: first.squareOrderId, paymentLinkId: first.paymentLinkId, approvedTotalMinor: input.approvedTotalMinor, currency: input.currency })).toEqual(first);
    expect(callback).toHaveBeenCalledTimes(2); expect(callback).toHaveBeenCalledWith(first);
    expect(deps.randomBytes).toHaveBeenCalledWith(32);
  });
  it('concurrent creates return the atomic stored winner', async () => {
    const { provider, input, saved } = setup(); const results = await Promise.all([provider.createCheckout(input), provider.createCheckout(input)]);
    expect(results[0]).toEqual(results[1]); expect(saved.size).toBe(1);
  });
  it('different keys generate different canonical 32-byte tokens', async () => {
    const { provider, input } = setup(); const first = await provider.createCheckout(input); const second = await provider.createCheckout({ ...input, idempotencyKey: 'b'.repeat(64) });
    expect(first.url).not.toBe(second.url); expect(first.url).toMatch(/^https:\/\/demo.example\/bill\/[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(first.url.split('/').at(-1)!, 'base64url')).toHaveLength(32);
  });
  it('refuses reuse of a key for changed approved material', async () => {
    const { provider, input } = setup(); await provider.createCheckout(input);
    await expect(provider.createCheckout({ ...input, orderId: 'ord_other' })).rejects.toMatchObject({ code: 'PAYLOAD_HASH_MISMATCH' });
  });
  it('awaits the callback and recovers after its failure across a provider restart', async () => {
    const { provider, input, deps } = setup(); input.onLinkCreated = async () => { throw new Error('sensitive details'); };
    await expect(provider.createCheckout(input)).rejects.toMatchObject({ outcome: 'created_unverified', message: 'The demo bill could not be prepared.' });
    const restarted = createBillCheckoutProvider(deps);
    const recovered = await restarted.resumeCheckout(input);
    expect(recovered.billId).toMatch(/^bill_/);
    expect(await restarted.createCheckout({ ...input, onLinkCreated: undefined })).toEqual(recovered);
  });
  it('uses an unknown outcome when an insert acknowledgement fails before persistence', async () => {
    const { provider, input, store } = setup(); store.putIfAbsent = async () => { throw new Error('secret'); };
    await expect(provider.createCheckout(input)).rejects.toMatchObject({ outcome: 'unknown' });
  });
  it('recovers the committed bill after an insert acknowledgement is lost', async () => {
    const { input, store, deps, saved } = setup();
    let throwAfterCommit = true;
    const originalInsert = store.putIfAbsent;
    store.putIfAbsent = async (bill) => {
      const savedBill = await originalInsert(bill);
      if (throwAfterCommit) { throwAfterCommit = false; throw new Error('acknowledgement lost'); }
      return savedBill;
    };
    const firstProvider = createBillCheckoutProvider(deps);
    await expect(firstProvider.createCheckout(input)).rejects.toMatchObject({ outcome: 'unknown' });
    const restarted = createBillCheckoutProvider(deps);
    const recovered = await restarted.resumeCheckout(input);
    const repeated = await restarted.createCheckout(input);
    expect(repeated).toEqual(recovered);
    expect(saved.size).toBe(1);
  });
  it('does not create from resume', async () => {
    const { provider, input, store } = setup(); await expect(provider.resumeCheckout(input)).rejects.toMatchObject({ code: 'NOT_FOUND' }); expect(store.putIfAbsent).not.toHaveBeenCalled();
  });
  it('refuses changed totals on resume', async () => {
    const { provider, input } = setup(); await provider.createCheckout(input);
    await expect(provider.resumeCheckout({ ...input, approvedTotalMinor: 1 })).rejects.toMatchObject({ outcome: 'total_mismatch' });
  });
  it.each([
    { businessId: 'biz_other', orderId: 'ord_test' },
    { businessId: 'biz_pizza_01', orderId: 'ord_other' },
  ])('does not reveal a bill to a foreign business or order through either private lookup', async (scope) => {
    const { provider, input } = setup(); const created = await provider.createCheckout(input);
    await expect(provider.resumeCheckout({ ...input, ...scope })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(provider.resumeCheckout({ ...input, ...scope, idempotencyKey: undefined, squareOrderId: created.squareOrderId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('rejects a reused generated token before storing another bill', async () => {
    const { provider, input, deps, store } = setup();
    await provider.createCheckout(input);
    deps.randomBytes = () => new Uint8Array(32).fill(1);
    await expect(provider.createCheckout({ ...input, idempotencyKey: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT_UNRESOLVED' });
    expect(store.putIfAbsent).toHaveBeenCalledTimes(1);
  });
  it('retains an expired key tombstone instead of creating a second bill', async () => {
    const { provider, input, saved, store } = setup(); await provider.createCheckout(input);
    saved.values().next().value!.expiresAt = time.toISOString();
    await expect(provider.createCheckout(input)).rejects.toMatchObject({ outcome: 'created_unverified' });
    expect(store.putIfAbsent).toHaveBeenCalledTimes(1); expect(saved.size).toBe(1);
  });
  it('rejects one of two concurrent creates that reuse a key for different material', async () => {
    const { provider, input, saved } = setup();
    const results = await Promise.allSettled([
      provider.createCheckout(input),
      provider.createCheckout({ ...input, orderId: 'ord_other' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(saved.size).toBe(1);
  });
  it('rejects an invalid idempotency key and random byte count', async () => {
    const { provider, input, deps } = setup(); await expect(provider.createCheckout({ ...input, idempotencyKey: 'bad' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    deps.randomBytes = () => new Uint8Array(31); await expect(provider.createCheckout(input)).rejects.toMatchObject({ code: 'INTERNAL', outcome: 'not_created' });
  });
});

describe('bill page', () => {
  it('escapes every untrusted name and pickup value and includes the sandbox line', async () => {
    const { provider, input, saved } = setup(); await provider.createCheckout(input); const bill = [...saved.values()][0]!;
    bill.businessName = '<script>alert("x")</script>&'; bill.quote.lines[0]!.name = '<img src=x onerror=x>'; bill.quote.lines[0]!.modifiers[0]!.name = "<b>'Cheese'</b>"; bill.pickupAt = '<iframe>';
    const html = renderBillHtml(bill);
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;'); expect(html).toContain('&lt;img src=x onerror=x&gt;'); expect(html).toContain('&lt;b&gt;&#39;Cheese&#39;&lt;/b&gt;'); expect(html).toContain('&lt;iframe&gt;');
    expect(html).toContain('Demo bill. Sandbox. No payment is taken.'); expect(html).not.toMatch(/<script|<img|<iframe|https?:\/\//); expect(html).toContain('$2.65 USD');
  });
  it('serves HTML and privacy headers with identical unknown, malformed and expired 404s; never logs tokens', async () => {
    const { provider, input, saved, store } = setup(); const link = await provider.createCheckout(input);
    let logs = ''; const stream = new Writable({ write(chunk: Buffer, _encoding, done) { logs += chunk.toString(); done(); } });
    const app = Fastify({ rewriteUrl: rewriteBillUrl, logger: { level: 'trace', stream } });
    await app.register(billPlugin, { store, now: () => new Date(time) });
    try {
      const ok = await app.inject({ url: link.url }); expect(ok.statusCode).toBe(200); expect(ok.headers['content-type']).toContain('text/html');
      for (const [header, value] of Object.entries({ 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer' })) expect(ok.headers[header]).toBe(value);
      expect(ok.headers['content-security-policy']).toContain("default-src 'none'; style-src 'unsafe-inline'");
      const unknownToken = Buffer.alloc(32, 99).toString('base64url');
      const unknown = await app.inject({ url: `/bill/${unknownToken}` });
      const malformed = await app.inject({ url: '/bill/malformed-secret' });
      saved.values().next().value!.expiresAt = time.toISOString();
      const expired = await app.inject({ url: link.url });
      const malformedUri = await app.inject({ url: '/bill/%ZZ-secret' });
      const oversized = await app.inject({ url: '/bill/' + 'long-secret'.repeat(20) });
      for (const response of [unknown, malformed, expired, malformedUri, oversized]) { expect(response.statusCode).toBe(404); expect(response.body).toBe('Bill not found.'); expect(response.headers['cache-control']).toBe('no-store'); }
      expect(logs).not.toContain(link.url.split('/').at(-1)); expect(logs).not.toContain(unknownToken); expect(logs).not.toContain('malformed-secret'); expect(logs).not.toContain('%ZZ-secret'); expect(logs).not.toContain('long-secret');
    } finally { await app.close(); }
  });
  it.each(['POST', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'] as const)('does not disclose bill tokens for unsupported %s requests', async (method) => {
    const { provider, input, store } = setup(); const link = await provider.createCheckout(input);
    let logs = ''; const stream = new Writable({ write(chunk: Buffer, _encoding, done) { logs += chunk.toString(); done(); } });
    const app = Fastify({ rewriteUrl: rewriteBillUrl, logger: { level: 'trace', stream } });
    await app.register(billPlugin, { store, now: () => new Date(time) });
    const token = link.url.split('/').at(-1)!;
    try {
      for (const url of [link.url, `/bill/${Buffer.alloc(32, 99).toString('base64url')}`, '/bill/malformed-secret']) {
        const response = await app.inject({ method, url });
        expect(response.statusCode).toBe(404); expect(response.body).toBe('Bill not found.');
        expect(response.headers['cache-control']).toBe('no-store'); expect(response.body).not.toContain(token);
      }
      expect(logs).not.toContain(token); expect(logs).not.toContain('malformed-secret');
    } finally { await app.close(); }
  });
});
