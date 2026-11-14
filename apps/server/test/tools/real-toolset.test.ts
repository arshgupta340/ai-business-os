import { describe, expect, it, vi } from 'vitest';
import {
  CAPABILITIES,
  QUOTE_EXPIRY_MS,
  TOOL_CAPABILITY,
  ToolNameSchema,
  cartHash,
  isToolEffect,
  toolResultSchema,
  validateToolCapabilities,
  type AvailabilitySlot,
  type Cart,
  type Quote,
  type ToolContext,
  type ToolName,
} from '@abos/contracts';
import { FIXTURE_NOW, SQ, barberFacts, pizzaCatalog, pizzaVerifiedFacts, serviceHaircut } from '@abos/contracts/fixtures';
import { createRealToolset } from '../../src/tools/real/index';
import type { BookingProposalInput, FactsSnapshot, OrderProposalInput, RealToolsetPorts } from '../../src/tools/real/types';

const PIZZA = 'biz_pizza_01';
const BARBER = 'biz_barber_01';
const TZ = 'America/Los_Angeles';
const pizzaCtx: ToolContext = { businessId: PIZZA, agentVersionId: 'agv_pizza_01_v2', callId: 'call_test_01', correlationId: 'call_test_01' };
const barberCtx: ToolContext = { businessId: BARBER, agentVersionId: 'agv_barber_01_v1', callId: 'call_test_02', correlationId: 'call_test_02' };

const cart: Cart = { lines: [{ catalogItemId: SQ.itemMargherita, variationId: SQ.varMargheritaLarge, quantity: 1, modifierIds: [] }] };
const otherCart: Cart = { lines: [{ catalogItemId: SQ.itemPepperoni, variationId: SQ.varPepperoniLarge, quantity: 2, modifierIds: [] }] };
const consented = { name: 'Maya', messageRecipient: '+15555550123', messageConsent: true, consentAt: FIXTURE_NOW };
const declined = { name: 'Maya', messageConsent: false };
const pickup = { type: 'pickup' as const, pickupAt: '2026-11-14T21:00:00Z' };

function snapshotOf(facts: typeof pizzaVerifiedFacts): FactsSnapshot {
  return {
    facts: facts.flatMap((f) => (f.kind === 'menu_item' || f.status !== 'verified' ? [] : [{ kind: f.kind, key: f.key, value: f.value, version: f.version }])),
    timezone: TZ,
  };
}

function clock(start = FIXTURE_NOW) {
  let t = Date.parse(start);
  return { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
}

function setup(opts: { businessId?: string; facts?: FactsSnapshot; capabilities?: Parameters<typeof createRealToolset>[0]['capabilities']; unavailable?: boolean } = {}) {
  const c = clock();
  let quoteSeq = 0;
  const facts = { current: opts.facts ?? snapshotOf(pizzaVerifiedFacts) };
  const orderProposals: OrderProposalInput[] = [];
  const bookingProposals: BookingProposalInput[] = [];
  const slot: AvailabilitySlot = { serviceId: serviceHaircut.id, startUtc: '2026-11-14T22:00:00Z', endUtc: '2026-11-14T22:30:00Z', timezone: TZ };
  const ports = {
    catalog: { search: vi.fn(async () => pizzaCatalog) },
    facts: { readVerified: vi.fn(async () => structuredClone(facts.current)) },
    quotes: {
      quote: vi.fn(async ({ cart: q }: { cart: Cart }) => {
        if (opts.unavailable) return { ok: false as const, reason: 'ITEM_UNAVAILABLE' as const, message: 'line 1: Margherita is sold out' };
        const quotedAt = c.now().getTime();
        const quote: Quote = {
          quoteId: `qte_test_${++quoteSeq}`, cartHash: await cartHash(q), subtotalMinor: 2000, taxMinor: 145, totalMinor: 2145, currency: 'USD',
          lines: [{ variationId: SQ.varMargheritaLarge, name: 'Large Margherita', quantity: 1, unitPriceMinor: 2000, modifiers: [], lineTotalMinor: 2000 }],
          quotedAt: new Date(quotedAt).toISOString(), expiresAt: new Date(quotedAt + QUOTE_EXPIRY_MS).toISOString(),
        };
        return { ok: true as const, quote };
      }),
    },
    proposals: {
      createOrderProposal: vi.fn(async (input: OrderProposalInput) => {
        orderProposals.push(input);
        return { ok: true as const, orderId: 'ord_test_01', approvalId: 'apv_test_01' };
      }),
      createBookingProposal: vi.fn(async (input: BookingProposalInput) => {
        bookingProposals.push(input);
        return { ok: true as const, bookingId: 'bkg_test_01', approvalId: 'apv_test_02', slot };
      }),
    },
    orderStatus: {
      read: vi.fn(async ({ orderId }: { orderId: string }) => (orderId === 'ord_test_01' ? { orderId, status: 'AWAITING_OWNER_APPROVAL' as const, paid: false, checkoutLinkSent: false } : null)),
    },
    availability: {
      freeSlots: vi.fn(async ({ serviceId }: { serviceId: string }) => (serviceId === serviceHaircut.id ? { slots: [slot], timezone: TZ } : null)),
    },
  } satisfies RealToolsetPorts;
  const ts = createRealToolset({ businessId: opts.businessId ?? PIZZA, messageChannel: 'surge', ports, now: c.now, capabilities: opts.capabilities });
  return { ts, ports, facts, clock: c, orderProposals, bookingProposals, slot };
}

function expectValid<N extends ToolName>(name: N, result: unknown) {
  const r = toolResultSchema(name).safeParse(result);
  if (!r.success) throw new Error(JSON.stringify(r.error.issues));
}

async function quoted(s: ReturnType<typeof setup>, c: Cart = cart): Promise<Quote> {
  const r = await s.ts.tools.quote_order({ cart: c }, pizzaCtx);
  if (!r.ok) throw new Error(r.reason);
  return r.quote;
}

describe('real toolset: the tool table', () => {
  it('has exactly seven tools, every one read or propose', () => {
    expect(ToolNameSchema.options).toHaveLength(7);
    const caps = ToolNameSchema.options.map((t) => TOOL_CAPABILITY[t]);
    expect(validateToolCapabilities(caps).ok).toBe(true);
    for (const c of caps) expect(isToolEffect(CAPABILITIES[c].effect)).toBe(true);
    const { ts } = setup();
    expect(Object.keys(ts.tools).sort()).toEqual([...ToolNameSchema.options].sort());
    expect(ts.handler.toolset).toBe('real');
  });

  it('refuses a tool the agent version does not have', async () => {
    const { ts } = setup({ capabilities: ['catalog.read', 'order.checkout.prepare'] });
    expect((await ts.tools.read_catalog({}, pizzaCtx)).ok).toBe(true);
    const r = await ts.tools.quote_order({ cart }, pizzaCtx);
    expect(r).toMatchObject({ ok: false, reason: 'CAPABILITY_NOT_ALLOWED' });
  });

  it('refuses another business and bad arguments without calling a port', async () => {
    const s = setup();
    expect(await s.ts.tools.read_catalog({}, barberCtx)).toMatchObject({ ok: false, reason: 'CAPABILITY_NOT_ALLOWED' });
    const bad = await s.ts.handler.call('quote_order', { cart: { lines: [] } }, pizzaCtx);
    expect(bad).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
    expect(s.ports.quotes.quote).not.toHaveBeenCalled();
  });

  it('never throws: a port that throws is INTEGRATION_UNAVAILABLE', async () => {
    const s = setup();
    s.ports.catalog.search.mockRejectedValueOnce(new Error('db down'));
    await expect(s.ts.tools.read_catalog({ query: 'pepperoni' }, pizzaCtx)).resolves.toMatchObject({ ok: false, reason: 'INTEGRATION_UNAVAILABLE' });
  });

  it('traces every call, unmocked, with the recipient masked', async () => {
    const s = setup();
    const q = await quoted(s);
    await s.ts.tools.propose_order({ cart, contact: consented, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx);
    const trace = s.ts.trace();
    expect(trace.map((e) => e.tool)).toEqual(['quote_order', 'propose_order']);
    expect(trace.every((e) => e.mocked === false && (e.effect === 'read' || e.effect === 'propose'))).toBe(true);
    expect(JSON.stringify(trace)).not.toContain('+15555550123');
    expect(JSON.stringify(trace)).toContain('***0123');
    s.ts.clearTrace();
    expect(s.ts.trace()).toEqual([]);
  });
});

describe('real toolset: read tools', () => {
  it('read_catalog maps cached items to the tool shape', async () => {
    const { ts } = setup();
    const r = await ts.tools.read_catalog({ query: 'pizza' }, pizzaCtx);
    expectValid('read_catalog', r);
    if (!r.ok) throw new Error(r.reason);
    expect(r.items.map((i) => i.catalogItemId)).toEqual([SQ.itemMargherita, SQ.itemPepperoni]);
  });

  it('read_business_facts filters by kind', async () => {
    const { ts } = setup();
    const r = await ts.tools.read_business_facts({ kinds: ['hours'] }, pizzaCtx);
    expectValid('read_business_facts', r);
    if (!r.ok) throw new Error(r.reason);
    expect(r.facts).toHaveLength(7);
    expect(r.timezone).toBe(TZ);
  });

  it('AC-16: the fact snapshot does not change mid-call', async () => {
    const s = setup();
    const first = await s.ts.tools.read_business_facts({ kinds: ['hours'] }, pizzaCtx);
    // The owner changes Friday hours while the call is in progress.
    s.facts.current = { ...s.facts.current, facts: s.facts.current.facts.map((f) => (f.kind === 'hours' && f.key === 'fri' ? { ...f, value: { open: '11:00', close: '23:00' }, version: 2 } : f)) };
    const second = await s.ts.tools.read_business_facts({ kinds: ['hours'] }, pizzaCtx);
    expect(second).toEqual(first);
    expect(s.ports.facts.readVerified).toHaveBeenCalledTimes(1);
    // A new call (a new toolset) sees the new value.
    const next = createRealToolset({ businessId: PIZZA, messageChannel: 'surge', ports: s.ports });
    const fresh = await next.tools.read_business_facts({ kinds: ['hours'] }, pizzaCtx);
    if (!fresh.ok) throw new Error(fresh.reason);
    expect(fresh.facts.find((f) => f.key === 'fri')?.value).toEqual({ open: '11:00', close: '23:00' });
  });

  it('a failed fact read is retried on the next call', async () => {
    const s = setup();
    await Promise.resolve();
    s.ports.facts.readVerified.mockRejectedValueOnce(new Error('down'));
    const ts = createRealToolset({ businessId: PIZZA, messageChannel: 'surge', ports: s.ports });
    expect(await ts.tools.read_business_facts({}, pizzaCtx)).toMatchObject({ ok: false, reason: 'INTEGRATION_UNAVAILABLE' });
    expect((await ts.tools.read_business_facts({}, pizzaCtx)).ok).toBe(true);
  });

  it('get_order_status reads through the port with the call ID, or NOT_FOUND', async () => {
    const s = setup();
    const r = await s.ts.tools.get_order_status({ orderId: 'ord_test_01' }, pizzaCtx);
    expectValid('get_order_status', r);
    expect(r).toMatchObject({ ok: true, status: 'AWAITING_OWNER_APPROVAL', paid: false });
    expect(s.ports.orderStatus.read).toHaveBeenCalledWith({ businessId: PIZZA, orderId: 'ord_test_01', callId: 'call_test_01' });
    expect(await s.ts.tools.get_order_status({ orderId: 'ord_other_99' }, pizzaCtx)).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
  });

  it('read_calendar_availability returns slots, or NOT_FOUND', async () => {
    const s = setup({ businessId: BARBER, facts: snapshotOf(barberFacts) });
    const r = await s.ts.tools.read_calendar_availability({ serviceId: serviceHaircut.id, date: '2026-11-14' }, barberCtx);
    expectValid('read_calendar_availability', r);
    expect(r).toMatchObject({ ok: true, slots: [s.slot] });
    expect(await s.ts.tools.read_calendar_availability({ serviceId: 'svc_nope', date: '2026-11-14' }, barberCtx)).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
  });
});

describe('real toolset: quote_order and propose_order', () => {
  it('quote_order returns the quote, or ITEM_UNAVAILABLE', async () => {
    const r = await setup().ts.tools.quote_order({ cart }, pizzaCtx);
    expectValid('quote_order', r);
    expect(r.ok).toBe(true);
    const u = await setup({ unavailable: true }).ts.tools.quote_order({ cart }, pizzaCtx);
    expect(u).toMatchObject({ ok: false, reason: 'ITEM_UNAVAILABLE' });
  });

  it('proposes with consent on the configured channel and the recipient', async () => {
    const s = setup();
    const q = await quoted(s);
    const r = await s.ts.tools.propose_order({ cart, contact: consented, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx);
    expectValid('propose_order', r);
    expect(r).toMatchObject({ ok: true, proposalId: 'ord_test_01', approvalId: 'apv_test_01', missingFields: [] });
    expect(s.orderProposals[0]).toMatchObject({ messageChannel: 'surge', contact: { messageRecipient: '+15555550123', messageConsent: true }, callId: 'call_test_01', quote: q });
  });

  it('no consent proposes on qr_only with no recipient', async () => {
    const s = setup();
    const q = await quoted(s);
    const r = await s.ts.tools.propose_order({ cart, contact: declined, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx);
    expect(r).toMatchObject({ ok: true, proposalId: 'ord_test_01' });
    expect(s.orderProposals[0]?.messageChannel).toBe('qr_only');
    expect(s.orderProposals[0]?.contact).toEqual({ name: 'Maya', messageConsent: false });
  });

  it('a recipient without consent fails validation', async () => {
    const s = setup();
    const q = await quoted(s);
    const r = await s.ts.handler.call('propose_order', { cart, contact: { name: 'Maya', messageConsent: false, messageRecipient: '+15555550123' }, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx);
    expect(r).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
    expect(s.orderProposals).toHaveLength(0);
  });

  it('refuses an unknown quote', async () => {
    const s = setup();
    const r = await s.ts.tools.propose_order({ cart, contact: consented, fulfillment: pickup, quoteId: 'qte_never_made' }, pizzaCtx);
    expect(r).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    expect(s.orderProposals).toHaveLength(0);
  });

  it('refuses an expired quote and returns a fresh one', async () => {
    const s = setup();
    const q = await quoted(s);
    s.clock.advance(QUOTE_EXPIRY_MS + 1000);
    const r = await s.ts.tools.propose_order({ cart, contact: consented, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx);
    expectValid('propose_order', r);
    if (r.ok) throw new Error('expected a failure');
    expect(r.reason).toBe('QUOTE_EXPIRED');
    expect(r.quote?.quoteId).not.toBe(q.quoteId);
    expect(s.orderProposals).toHaveLength(0);
  });

  it('refuses a quote for a different cart', async () => {
    const s = setup();
    const q = await quoted(s);
    const r = await s.ts.tools.propose_order({ cart: otherCart, contact: consented, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx);
    expect(r).toMatchObject({ ok: false, reason: 'QUOTE_EXPIRED' });
  });

  it('a quote is used once', async () => {
    const s = setup();
    const q = await quoted(s);
    await s.ts.tools.propose_order({ cart, contact: consented, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx);
    const again = await s.ts.tools.propose_order({ cart, contact: consented, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx);
    expect(again).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
  });

  it('a blank name is a missing field and nothing is stored', async () => {
    const s = setup();
    const q = await quoted(s);
    const r = await s.ts.tools.propose_order({ cart, contact: { ...declined, name: '  ' }, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx);
    expectValid('propose_order', r);
    expect(r).toMatchObject({ ok: true, missingFields: ['contact.name'] });
    expect(s.orderProposals).toHaveLength(0);
  });

  it('a pickup in the past or outside hours is VALIDATION_FAILED', async () => {
    const s = setup();
    const q = await quoted(s);
    const past = await s.ts.tools.propose_order({ cart, contact: consented, fulfillment: { type: 'pickup', pickupAt: '2026-11-14T19:00:00Z' }, quoteId: q.quoteId }, pizzaCtx);
    expect(past).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
    // Saturday 23:00 local, after the 22:00 close.
    const late = await s.ts.tools.propose_order({ cart, contact: consented, fulfillment: { type: 'pickup', pickupAt: '2026-11-15T07:00:00Z' }, quoteId: q.quoteId }, pizzaCtx);
    expect(late).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
    expect(s.orderProposals).toHaveLength(0);
  });

  it('passes a proposal port refusal through', async () => {
    const s = setup();
    s.ports.proposals.createOrderProposal.mockResolvedValueOnce({ ok: false, reason: 'ITEM_UNAVAILABLE', message: 'sold out' } as never);
    const q = await quoted(s);
    const r = await s.ts.tools.propose_order({ cart, contact: consented, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx);
    expect(r).toEqual({ ok: false, reason: 'ITEM_UNAVAILABLE', message: 'sold out' });
  });
});

describe('real toolset: propose_booking', () => {
  const barber = () => setup({ businessId: BARBER, facts: snapshotOf(barberFacts) });
  const customer = { name: 'Sam', messageRecipient: '+15555550144', messageConsent: true };

  it('proposes a booking with consent', async () => {
    const s = barber();
    const r = await s.ts.tools.propose_booking({ serviceId: serviceHaircut.id, startUtc: '2026-11-14T22:00:00Z', customer }, barberCtx);
    expectValid('propose_booking', r);
    expect(r).toMatchObject({ ok: true, proposalId: 'bkg_test_01', approvalId: 'apv_test_02', missingFields: [] });
    expect(s.bookingProposals[0]).toMatchObject({ messageChannel: 'surge', customer });
  });

  it('no consent proposes on qr_only with no recipient', async () => {
    const s = barber();
    await s.ts.tools.propose_booking({ serviceId: serviceHaircut.id, startUtc: '2026-11-14T22:00:00Z', customer: { name: 'Sam', messageConsent: false } }, barberCtx);
    expect(s.bookingProposals[0]).toMatchObject({ messageChannel: 'qr_only', customer: { name: 'Sam', messageConsent: false } });
    expect(s.bookingProposals[0]?.customer.messageRecipient).toBeUndefined();
  });

  it('SLOT_CONFLICT carries at most three alternatives', async () => {
    const s = barber();
    const alt = (h: number): AvailabilitySlot => ({ serviceId: serviceHaircut.id, startUtc: `2026-11-14T${h}:00:00Z`, endUtc: `2026-11-14T${h}:30:00Z`, timezone: TZ });
    s.ports.proposals.createBookingProposal.mockResolvedValueOnce({ ok: false, reason: 'SLOT_CONFLICT', alternatives: [alt(19), alt(20), alt(21), alt(22)] } as never);
    const r = await s.ts.tools.propose_booking({ serviceId: serviceHaircut.id, startUtc: '2026-11-14T22:00:00Z', customer }, barberCtx);
    expectValid('propose_booking', r);
    if (r.ok) throw new Error('expected a failure');
    expect(r.reason).toBe('SLOT_CONFLICT');
    expect(r.alternatives).toHaveLength(3);
  });

  it('an unknown service is NOT_FOUND and a closed day is VALIDATION_FAILED', async () => {
    const s = barber();
    expect(await s.ts.tools.propose_booking({ serviceId: 'svc_nope', startUtc: '2026-11-14T22:00:00Z', customer }, barberCtx)).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    // Sunday is closed.
    expect(await s.ts.tools.propose_booking({ serviceId: serviceHaircut.id, startUtc: '2026-11-15T19:00:00Z', customer }, barberCtx)).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
    expect(s.bookingProposals).toHaveLength(0);
  });
});
