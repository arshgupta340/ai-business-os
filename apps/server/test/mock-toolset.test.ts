import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  CAPABILITY_LIST,
  TOOL_CAPABILITY,
  ToolNameSchema,
  isToolEffect,
  toolResultSchema,
  toolsForCapabilities,
  validateToolCapabilities,
  type Cart,
  type CapabilityId,
  type ToolContext,
  type ToolName,
  type ToolInput,
} from '@abos/contracts';
import {
  BARBER_CALENDAR_ID,
  FIXTURE_NOW,
  SQ,
  bookingSlotConflict,
  orderFulfilled,
  orders,
  serviceBeardTrim,
  serviceHaircut,
  slotConflictAlternatives,
} from '@abos/contracts/fixtures';
import { createMockToolset } from '../src/tools/mock/index';

const PIZZA = 'biz_pizza_01';
const BARBER = 'biz_barber_01';
const pizzaCtx: ToolContext = { businessId: PIZZA, agentVersionId: 'agv_pizza_01_v2', testSessionId: 'tst_demo_01', correlationId: 'tst_demo_01' };
const barberCtx: ToolContext = { businessId: BARBER, agentVersionId: 'agv_barber_01_v1', testSessionId: 'tst_demo_02', correlationId: 'tst_demo_02' };

const contact = { name: 'Maya', messageRecipient: '+15555550123', messageConsent: true as const, consentAt: FIXTURE_NOW };
const fulfillment = { type: 'pickup' as const, pickupAt: '2026-11-14T21:00:00Z' };
const twoPizzas: Cart = {
  lines: [
    { catalogItemId: SQ.itemMargherita, variationId: SQ.varMargheritaLarge, quantity: 1, modifierIds: [SQ.modMushrooms] },
    { catalogItemId: SQ.itemPepperoni, variationId: SQ.varPepperoniLarge, quantity: 1, modifierIds: [] },
  ],
};

/** A clock the test can move. */
function clock(start = FIXTURE_NOW) {
  let t = Date.parse(start);
  return { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
}

function expectValid<N extends ToolName>(name: N, result: unknown) {
  const r = toolResultSchema(name).safeParse(result);
  if (!r.success) throw new Error(JSON.stringify(r.error.issues));
}

async function quote(ts: ReturnType<typeof createMockToolset>, cart: Cart) {
  const r = await ts.tools.quote_order({ cart }, pizzaCtx);
  if (!r.ok) throw new Error(`quote failed: ${r.reason}`);
  return r.quote;
}

describe('mock toolset shape', () => {
  it('exposes exactly the seven read and propose tools, and no write or external_message path', () => {
    const ts = createMockToolset({ businessId: PIZZA });
    expect(ts.handler.toolset).toBe('mock');
    expect(Object.keys(ts.tools).sort()).toEqual([...ToolNameSchema.options].sort());
    const caps = Object.keys(ts.tools).map((n) => TOOL_CAPABILITY[n as ToolName]);
    expect(validateToolCapabilities(caps).ok).toBe(true);
    for (const cap of caps) expect(isToolEffect(CAPABILITIES[cap].effect)).toBe(true);
    // Every write and external_message capability is unreachable: no tool maps to it.
    const forbidden = CAPABILITY_LIST.filter((c) => !isToolEffect(c.effect)).map((c) => c.id);
    expect(forbidden.length).toBeGreaterThan(0);
    for (const id of forbidden) expect(caps).not.toContain(id);
    expect(toolsForCapabilities(CAPABILITY_LIST.map((c) => c.id) as CapabilityId[]).sort()).toEqual(Object.keys(ts.tools).sort());
  });

  it('refuses a context from another business (AC-17)', async () => {
    const ts = createMockToolset({ businessId: PIZZA });
    const r = await ts.tools.read_catalog({}, barberCtx);
    expect(r).toMatchObject({ ok: false, reason: 'CAPABILITY_NOT_ALLOWED' });
  });

  it('returns VALIDATION_FAILED for arguments that break the tool schema, and still traces them', async () => {
    const ts = createMockToolset({ businessId: PIZZA });
    const bad = { cart: { lines: [] } } as unknown as ToolInput['quote_order'];
    expect(await ts.handler.call('quote_order', bad, pizzaCtx)).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
    const extra = { query: 'x', businessId: BARBER } as unknown as ToolInput['read_catalog'];
    expect(await ts.handler.call('read_catalog', extra, pizzaCtx)).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
    expect(ts.trace().map((e) => e.tool)).toEqual(['quote_order', 'read_catalog']);
  });
});

describe('read_catalog', () => {
  it('searches by text across item, size and topping names', async () => {
    const ts = createMockToolset({ businessId: PIZZA });
    const r = await ts.tools.read_catalog({ query: 'large pepperoni' }, pizzaCtx);
    expectValid('read_catalog', r);
    expect(r.ok && r.items.map((i) => i.catalogItemId)).toEqual([SQ.itemPepperoni]);
    const all = await ts.tools.read_catalog({}, pizzaCtx);
    expect(all.ok && all.items.length).toBe(2);
    const mush = await ts.tools.read_catalog({ query: 'pizzas with mushrooms' }, pizzaCtx);
    expect(mush.ok && mush.items.length).toBe(2);
    const item = all.ok ? all.items[0] : undefined;
    expect(item?.variations.map((v) => v.name)).toEqual(['Small', 'Medium', 'Large']);
    expect(item?.modifierLists[0]?.modifiers.length).toBe(3);
  });

  it('returns an empty list, not an error, for an unknown item', async () => {
    const ts = createMockToolset({ businessId: PIZZA });
    expect(await ts.tools.read_catalog({ query: 'calzone' }, pizzaCtx)).toEqual({ ok: true, items: [] });
    const barber = createMockToolset({ businessId: BARBER });
    expect(await barber.tools.read_catalog({ query: 'pizza' }, barberCtx)).toEqual({ ok: true, items: [] });
  });

  it('marks a sold-out item unavailable', async () => {
    const ts = createMockToolset({ businessId: PIZZA, unavailableItemIds: [SQ.itemPepperoni] });
    const r = await ts.tools.read_catalog({ query: 'pepperoni' }, pizzaCtx);
    expect(r.ok && r.items[0]?.available).toBe(false);
  });
});

describe('read_business_facts', () => {
  it('returns verified hours, policies and services, never menu_item drafts', async () => {
    const pizza = createMockToolset({ businessId: PIZZA });
    const r = await pizza.tools.read_business_facts({}, pizzaCtx);
    expectValid('read_business_facts', r);
    if (!r.ok) throw new Error('failed');
    expect(r.timezone).toBe('America/Los_Angeles');
    expect(r.facts.filter((f) => f.kind === 'hours').length).toBe(7);
    expect(r.facts.find((f) => f.kind === 'hours' && f.key === 'fri')?.value).toEqual({ open: '11:00', close: '22:00' });
    expect(r.facts.some((f) => (f.kind as string) === 'menu_item')).toBe(false);
    const hours = await pizza.tools.read_business_facts({ kinds: ['policy'] }, pizzaCtx);
    expect(hours.ok && hours.facts.every((f) => f.kind === 'policy')).toBe(true);

    const barber = createMockToolset({ businessId: BARBER });
    const s = await barber.tools.read_business_facts({ kinds: ['service'] }, barberCtx);
    expect(s.ok && s.facts.map((f) => f.key)).toEqual(['svc_haircut', 'svc_beard_trim', 'svc_haircut_beard']);
  });
});

describe('quote_order', () => {
  it('prices the cart deterministically and totals add up', async () => {
    const ts = createMockToolset({ businessId: PIZZA });
    const r = await ts.tools.quote_order({ cart: twoPizzas }, pizzaCtx);
    expectValid('quote_order', r);
    if (!r.ok) throw new Error('failed');
    const q = r.quote;
    expect(q.quoteId).toBe('qte_mock_0001');
    expect([q.subtotalMinor, q.taxMinor, q.totalMinor]).toEqual([4350, 381, 4731]);
    expect(q.lines.reduce((s, l) => s + l.lineTotalMinor, 0)).toBe(q.subtotalMinor);
    expect(q.subtotalMinor + q.taxMinor).toBe(q.totalMinor);
    expect(q.cartHash).toBe(orderFulfilled.cartHash);
    expect(q.quotedAt).toBe(FIXTURE_NOW);
    expect(Date.parse(q.expiresAt) - Date.parse(q.quotedAt)).toBe(5 * 60 * 1000);
  });

  it('agrees with every fixture order quote', async () => {
    const ts = createMockToolset({ businessId: PIZZA });
    for (const o of orders) {
      const q = await quote(ts, o.cart);
      expect([q.subtotalMinor, q.taxMinor, q.totalMinor, q.cartHash], o.id).toEqual([o.quote.subtotalMinor, o.quote.taxMinor, o.quote.totalMinor, o.quote.cartHash]);
      expect(q.lines).toEqual(o.quote.lines);
    }
  });

  it('refuses unknown or unavailable items with ITEM_UNAVAILABLE', async () => {
    const ts = createMockToolset({ businessId: PIZZA, unavailableItemIds: [SQ.itemPepperoni] });
    const unknownVariation = await ts.tools.quote_order({ cart: { lines: [{ catalogItemId: SQ.itemMargherita, variationId: 'SQ_VAR_XL', quantity: 1, modifierIds: [] }] } }, pizzaCtx);
    expect(unknownVariation).toMatchObject({ ok: false, reason: 'ITEM_UNAVAILABLE' });
    const unknownModifier = await ts.tools.quote_order({ cart: { lines: [{ catalogItemId: SQ.itemMargherita, variationId: SQ.varMargheritaSmall, quantity: 1, modifierIds: ['SQ_MOD_PINEAPPLE'] }] } }, pizzaCtx);
    expect(unknownModifier).toMatchObject({ ok: false, reason: 'ITEM_UNAVAILABLE' });
    const soldOut = await ts.tools.quote_order({ cart: twoPizzas }, pizzaCtx);
    expect(soldOut).toMatchObject({ ok: false, reason: 'ITEM_UNAVAILABLE', message: 'line 2: Pepperoni is not available' });
    expectValid('quote_order', soldOut);
  });
});

describe('propose_order', () => {
  it('stores a mock proposal and returns apv_mock_ and ord_ IDs', async () => {
    const ts = createMockToolset({ businessId: PIZZA });
    const q = await quote(ts, twoPizzas);
    const r = await ts.tools.propose_order({ cart: twoPizzas, contact, fulfillment, quoteId: q.quoteId }, pizzaCtx);
    expectValid('propose_order', r);
    expect(r).toMatchObject({ ok: true, proposalId: 'ord_mock_0001', approvalId: 'apv_mock_0001', missingFields: [] });
    const status = await ts.tools.get_order_status({ orderId: 'ord_mock_0001' }, pizzaCtx);
    expect(status).toEqual({ ok: true, orderId: 'ord_mock_0001', status: 'AWAITING_OWNER_APPROVAL', paid: false, checkoutLinkSent: false });
  });

  it('refuses an expired quote with QUOTE_EXPIRED and a fresh quote', async () => {
    const c = clock();
    const ts = createMockToolset({ businessId: PIZZA, now: c.now });
    const q = await quote(ts, twoPizzas);
    c.advance(5 * 60 * 1000 + 1);
    const r = await ts.tools.propose_order({ cart: twoPizzas, contact, fulfillment, quoteId: q.quoteId }, pizzaCtx);
    expectValid('propose_order', r);
    expect(r).toMatchObject({ ok: false, reason: 'QUOTE_EXPIRED' });
    if (r.ok) throw new Error('expected failure');
    expect(r.quote?.quoteId).toBe('qte_mock_0002');
    expect(r.quote?.totalMinor).toBe(4731);
  });

  it('refuses a cart that differs from the quote, and an unknown quote', async () => {
    const ts = createMockToolset({ businessId: PIZZA });
    const q = await quote(ts, twoPizzas);
    const changed: Cart = { lines: [{ catalogItemId: SQ.itemMargherita, variationId: SQ.varMargheritaSmall, quantity: 1, modifierIds: [] }] };
    expect(await ts.tools.propose_order({ cart: changed, contact, fulfillment, quoteId: q.quoteId }, pizzaCtx)).toMatchObject({ ok: false, reason: 'QUOTE_EXPIRED' });
    expect(await ts.tools.propose_order({ cart: twoPizzas, contact, fulfillment, quoteId: 'qte_unknown' }, pizzaCtx)).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
  });

  it('requires consent and a recipient', async () => {
    const ts = createMockToolset({ businessId: PIZZA });
    const q = await quote(ts, twoPizzas);
    const noConsent = { cart: twoPizzas, contact: { ...contact, messageConsent: false }, fulfillment, quoteId: q.quoteId } as unknown as ToolInput['propose_order'];
    expect(await ts.handler.call('propose_order', noConsent, pizzaCtx)).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
    const { messageRecipient: _dropped, ...noRecipientContact } = contact;
    const noRecipient = { cart: twoPizzas, contact: noRecipientContact, fulfillment, quoteId: q.quoteId } as unknown as ToolInput['propose_order'];
    expect(await ts.handler.call('propose_order', noRecipient, pizzaCtx)).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
  });

  it('accepts an order without message consent or a recipient and lists only missing names', async () => {
    const ts = createMockToolset({ businessId: PIZZA });
    const q = await quote(ts, twoPizzas);
    const contact = { name: 'Sam', messageConsent: false };
    const missing = await ts.tools.propose_order({ cart: twoPizzas, contact: { ...contact, name: ' ' }, fulfillment, quoteId: q.quoteId }, pizzaCtx);
    expectValid('propose_order', missing);
    expect(missing).toEqual({ ok: true, quote: q, missingFields: ['contact.name'] });
    const result = await ts.tools.propose_order({ cart: twoPizzas, contact, fulfillment, quoteId: q.quoteId }, pizzaCtx);
    expectValid('propose_order', result);
    expect(result).toMatchObject({ ok: true, proposalId: 'ord_mock_0001', approvalId: 'apv_mock_0001', missingFields: [] });
  });

  it('lists missingFields and stores nothing when a field is blank', async () => {
    const ts = createMockToolset({ businessId: PIZZA });
    const q = await quote(ts, twoPizzas);
    const r = await ts.tools.propose_order({ cart: twoPizzas, contact: { ...contact, name: '   ' }, fulfillment, quoteId: q.quoteId }, pizzaCtx);
    expectValid('propose_order', r);
    expect(r).toEqual({ ok: true, quote: q, missingFields: ['contact.name'] });
  });

  it('refuses a pickup time outside verified hours or in the past', async () => {
    const ts = createMockToolset({ businessId: PIZZA });
    const q = await quote(ts, twoPizzas);
    // Saturday 23:30 local, after the 22:00 close.
    const late = { type: 'pickup' as const, pickupAt: '2026-11-15T07:30:00Z' };
    expect(await ts.tools.propose_order({ cart: twoPizzas, contact, fulfillment: late, quoteId: q.quoteId }, pizzaCtx)).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
    const past = { type: 'pickup' as const, pickupAt: '2026-11-14T19:30:00Z' };
    expect(await ts.tools.propose_order({ cart: twoPizzas, contact, fulfillment: past, quoteId: q.quoteId }, pizzaCtx)).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
  });
});

describe('get_order_status', () => {
  it('reads fixture orders, and only those bound to the current call', async () => {
    const ts = createMockToolset({ businessId: PIZZA });
    const r = await ts.tools.get_order_status({ orderId: 'ord_demo_01' }, pizzaCtx);
    expectValid('get_order_status', r);
    expect(r).toEqual({ ok: true, orderId: 'ord_demo_01', status: 'FULFILLMENT_READY', paid: true, checkoutLinkSent: true });
    // qr_only: paid, but no message was ever sent.
    expect(await ts.tools.get_order_status({ orderId: 'ord_demo_02' }, pizzaCtx)).toMatchObject({ paid: true, checkoutLinkSent: false });
    expect(await ts.tools.get_order_status({ orderId: 'ord_demo_04' }, pizzaCtx)).toMatchObject({ status: 'AWAITING_OWNER_APPROVAL', paid: false });
    const onCall = { ...pizzaCtx, callId: 'call_demo_01' };
    expect(await ts.tools.get_order_status({ orderId: 'ord_demo_01' }, onCall)).toMatchObject({ ok: true });
    expect(await ts.tools.get_order_status({ orderId: 'ord_demo_03' }, onCall)).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    expect(await ts.tools.get_order_status({ orderId: 'ord_nope' }, pizzaCtx)).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
  });
});

describe('read_calendar_availability', () => {
  it('returns at most 5 free slots inside hours from the fixture busy blocks', async () => {
    const ts = createMockToolset({ businessId: BARBER });
    const r = await ts.tools.read_calendar_availability({ serviceId: serviceHaircut.id, date: '2026-11-17' }, barberCtx);
    expectValid('read_calendar_availability', r);
    if (!r.ok) throw new Error('failed');
    expect(r.timezone).toBe('America/Los_Angeles');
    expect(r.slots.map((s) => s.startUtc)).toEqual(['2026-11-17T19:30:00Z', '2026-11-17T19:45:00Z', '2026-11-17T20:00:00Z', '2026-11-17T20:15:00Z', '2026-11-17T22:00:00Z']);
    for (const s of r.slots) expect(Date.parse(s.endUtc) - Date.parse(s.startUtc)).toBe(30 * 60 * 1000);
    const two = await ts.tools.read_calendar_availability({ serviceId: serviceHaircut.id, date: '2026-11-17', maxSlots: 2 }, barberCtx);
    expect(two.ok && two.slots.length).toBe(2);
  });

  it('returns no slots on a closed day and honors the minimum notice', async () => {
    const ts = createMockToolset({ businessId: BARBER });
    expect(await ts.tools.read_calendar_availability({ serviceId: serviceHaircut.id, date: '2026-11-16' }, barberCtx)).toEqual({ ok: true, slots: [], timezone: 'America/Los_Angeles' });
    const soon = createMockToolset({ businessId: BARBER, now: () => new Date('2026-11-17T19:00:00Z') });
    const r = await soon.tools.read_calendar_availability({ serviceId: serviceHaircut.id, date: '2026-11-17' }, barberCtx);
    // Two hours of notice: nothing before 21:00Z, and lunch blocks 21:00Z to 22:00Z.
    expect(r.ok && r.slots[0]?.startUtc).toBe('2026-11-17T22:00:00Z');
  });

  it('refuses an unknown service', async () => {
    const ts = createMockToolset({ businessId: BARBER });
    expect(await ts.tools.read_calendar_availability({ serviceId: 'svc_perm', date: '2026-11-17' }, barberCtx)).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    const pizza = createMockToolset({ businessId: PIZZA });
    expect(await pizza.tools.read_calendar_availability({ serviceId: serviceHaircut.id, date: '2026-11-17' }, pizzaCtx)).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
  });
});

describe('propose_booking', () => {
  const customer = { name: 'Ana', messageRecipient: '+15555550140', messageConsent: true };

  it('returns a mock approval for a free slot', async () => {
    const ts = createMockToolset({ businessId: BARBER });
    const r = await ts.tools.propose_booking({ serviceId: serviceHaircut.id, startUtc: '2026-11-17T19:30:00Z', customer }, barberCtx);
    expectValid('propose_booking', r);
    expect(r).toEqual({
      ok: true, proposalId: 'bkg_mock_0001', approvalId: 'apv_mock_0001', missingFields: [],
      slot: { serviceId: serviceHaircut.id, startUtc: '2026-11-17T19:30:00Z', endUtc: '2026-11-17T20:00:00Z', timezone: 'America/Los_Angeles' },
    });
  });

  it('returns SLOT_CONFLICT with up to 3 alternatives for a busy slot', async () => {
    const ts = createMockToolset({ businessId: BARBER });
    const r = await ts.tools.propose_booking({ serviceId: bookingSlotConflict.serviceId, startUtc: bookingSlotConflict.startUtc, customer }, barberCtx);
    expectValid('propose_booking', r);
    if (r.ok) throw new Error('expected conflict');
    expect(r.reason).toBe('SLOT_CONFLICT');
    // Same alternatives as the scripted slot-conflict timeline.
    expect(r.alternatives?.map(({ startUtc, endUtc }) => ({ startUtc, endUtc }))).toEqual(slotConflictAlternatives);
    expect(BARBER_CALENDAR_ID).toContain('calendar.google.com');
  });

  it('accepts declined consent without a recipient, and refuses an off-grid or out-of-hours start', async () => {
    const ts = createMockToolset({ businessId: BARBER });
    const r = await ts.tools.propose_booking({ serviceId: serviceBeardTrim.id, startUtc: '2026-11-17T19:30:00Z', customer: { name: customer.name, messageConsent: false } }, barberCtx);
    expectValid('propose_booking', r);
    expect(r).toMatchObject({ ok: true, missingFields: [], approvalId: 'apv_mock_0001' });
    const missing = await ts.tools.propose_booking({ serviceId: serviceBeardTrim.id, startUtc: '2026-11-17T19:30:00Z', customer: { name: ' ', messageConsent: false } }, barberCtx);
    expectValid('propose_booking', missing);
    expect(missing).toMatchObject({ ok: true, missingFields: ['customer.name'] });
    expect(missing.ok && missing.approvalId).toBeUndefined();
    expect(await ts.tools.propose_booking({ serviceId: serviceBeardTrim.id, startUtc: '2026-11-17T19:37:00Z', customer }, barberCtx)).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
    expect(await ts.tools.propose_booking({ serviceId: serviceBeardTrim.id, startUtc: '2026-11-17T03:00:00Z', customer }, barberCtx)).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
  });
});

describe('scripted conversations', () => {
  it('pizza: read catalog, quote, propose', async () => {
    const ts = createMockToolset({ businessId: PIZZA });
    const menu = await ts.handler.call('read_catalog', { query: 'large margherita' }, pizzaCtx);
    if (!menu.ok) throw new Error('catalog failed');
    const marg = menu.items[0];
    const large = marg?.variations.find((v) => v.name === 'Large');
    const mushrooms = marg?.modifierLists[0]?.modifiers.find((m) => m.name === 'Mushrooms');
    const pep = await ts.handler.call('read_catalog', { query: 'pepperoni' }, pizzaCtx);
    const pepLarge = pep.ok ? pep.items[0]?.variations.find((v) => v.name === 'Large') : undefined;
    if (marg === undefined || large === undefined || mushrooms === undefined || !pep.ok || pepLarge === undefined) throw new Error('menu incomplete');
    const cart: Cart = {
      lines: [
        { catalogItemId: marg.catalogItemId, variationId: large.id, quantity: 1, modifierIds: [mushrooms.id] },
        { catalogItemId: pep.items[0]?.catalogItemId ?? '', variationId: pepLarge.id, quantity: 1, modifierIds: [] },
      ],
    };
    const q = await ts.handler.call('quote_order', { cart }, pizzaCtx);
    if (!q.ok) throw new Error('quote failed');
    expect(q.quote.totalMinor).toBe(4731);
    const p = await ts.handler.call('propose_order', { cart, contact, fulfillment, quoteId: q.quote.quoteId }, pizzaCtx);
    expect(p).toMatchObject({ ok: true, approvalId: expect.stringMatching(/^apv_mock_/) });
    const trace = ts.trace();
    expect(trace.map((e) => e.tool)).toEqual(['read_catalog', 'read_catalog', 'quote_order', 'propose_order']);
    expect(trace.map((e) => e.effect)).toEqual(['read', 'read', 'read', 'propose']);
    expect(trace.every((e) => e.mocked && e.durationMs >= 0)).toBe(true);
    expect(trace[3]?.capabilityId).toBe('order.propose');
    expect(trace[2]?.input).toEqual({ cart });
    expect(trace[3]?.output).toEqual(p);
  });

  it('barbershop: availability, then propose booking', async () => {
    const ts = createMockToolset({ businessId: BARBER });
    const avail = await ts.handler.call('read_calendar_availability', { serviceId: serviceHaircut.id, date: '2026-11-17', maxSlots: 3 }, barberCtx);
    if (!avail.ok) throw new Error('availability failed');
    const slot = avail.slots[1];
    if (slot === undefined) throw new Error('no slot');
    const b = await ts.handler.call('propose_booking', { serviceId: serviceHaircut.id, startUtc: slot.startUtc, customer: { name: 'Ben', messageRecipient: '+15555550141', messageConsent: true } }, barberCtx);
    expect(b).toMatchObject({ ok: true, slot, approvalId: expect.stringMatching(/^apv_mock_/) });
    expect(ts.trace().map((e) => e.tool)).toEqual(['read_calendar_availability', 'propose_booking']);
  });
});

describe('state is per instance', () => {
  it('two toolsets share no quotes, proposals, IDs or trace', async () => {
    const a = createMockToolset({ businessId: PIZZA });
    const b = createMockToolset({ businessId: PIZZA });
    const qa = await quote(a, twoPizzas);
    const qb = await quote(b, twoPizzas);
    expect(qa.quoteId).toBe('qte_mock_0001');
    expect(qb.quoteId).toBe('qte_mock_0001');
    await quote(a, twoPizzas);
    expect(await b.tools.propose_order({ cart: twoPizzas, contact, fulfillment, quoteId: 'qte_mock_0002' }, pizzaCtx)).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    const pa = await a.tools.propose_order({ cart: twoPizzas, contact, fulfillment, quoteId: qa.quoteId }, pizzaCtx);
    expect(pa).toMatchObject({ ok: true, proposalId: 'ord_mock_0001' });
    expect(await b.tools.get_order_status({ orderId: 'ord_mock_0001' }, pizzaCtx)).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    expect(a.trace().length).toBe(3);
    expect(b.trace().length).toBe(3);
    a.clearTrace();
    expect(a.trace()).toEqual([]);
    expect(b.trace().length).toBe(3);
  });

  it('the trace is a copy the caller cannot change', async () => {
    const ts = createMockToolset({ businessId: PIZZA });
    await ts.tools.read_catalog({}, pizzaCtx);
    ts.trace().pop();
    expect(ts.trace().length).toBe(1);
  });
});
