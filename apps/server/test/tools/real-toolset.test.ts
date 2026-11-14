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
import { MAX_QUOTES, MAX_TRACE_ENTRIES, READBACK_FIELD, READBACK_MIN_MS, createRealToolset } from '../../src/tools/real/index';
import type { BookingProposalInput, FactsSnapshot, OrderProposalInput, RealToolsetDeps, RealToolsetPorts } from '../../src/tools/real/types';

const PIZZA = 'biz_pizza_01';
const BARBER = 'biz_barber_01';
const TZ = 'America/Los_Angeles';
const pizzaCtx: ToolContext = { businessId: PIZZA, agentVersionId: 'agv_pizza_01_v2', callId: 'call_test_01', correlationId: 'call_test_01' };
const barberCtx: ToolContext = { businessId: BARBER, agentVersionId: 'agv_barber_01_v1', callId: 'call_test_02', correlationId: 'call_test_02' };

const cart: Cart = { lines: [{ catalogItemId: SQ.itemMargherita, variationId: SQ.varMargheritaLarge, quantity: 1, modifierIds: [] }] };
const otherCart: Cart = { lines: [{ catalogItemId: SQ.itemPepperoni, variationId: SQ.varPepperoniLarge, quantity: 2, modifierIds: [] }] };
const consented = { name: 'Maya Example', messageRecipient: '+15555550123', messageConsent: true, consentAt: '1999-01-01T00:00:00Z' };
const declined = { name: 'Maya Example', messageConsent: false };
const pickup = { type: 'pickup' as const, pickupAt: '2026-11-14T21:00:00Z' };

function snapshotOf(facts: typeof pizzaVerifiedFacts): FactsSnapshot {
  return {
    facts: facts.flatMap((f) => (f.kind === 'menu_item' || f.status !== 'verified' ? [] : [{ kind: f.kind, key: f.key, value: f.value, version: f.version }])),
    timezone: TZ,
  };
}
const withHours = (s: FactsSnapshot, key: string, value: unknown): FactsSnapshot => ({ ...s, facts: s.facts.map((f) => (f.kind === 'hours' && f.key === key ? { ...f, value: value as never } : f)) });

function clock(start = FIXTURE_NOW) {
  let t = Date.parse(start);
  return { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
}

type SetupOpts = { businessId?: string; facts?: FactsSnapshot | null; capabilities?: RealToolsetDeps['capabilities']; unavailable?: boolean; toolTimeoutMs?: number };

function setup(opts: SetupOpts = {}) {
  const c = clock();
  let quoteSeq = 0;
  const live = { facts: opts.facts ?? snapshotOf(pizzaVerifiedFacts) };
  const orderProposals: OrderProposalInput[] = [];
  const bookingProposals: BookingProposalInput[] = [];
  const slot: AvailabilitySlot = { serviceId: serviceHaircut.id, startUtc: '2026-11-14T22:00:00Z', endUtc: '2026-11-14T22:30:00Z', timezone: TZ };
  const ports = {
    catalog: { search: vi.fn(async () => pizzaCatalog) },
    facts: { readVerified: vi.fn(async () => structuredClone(live.facts)) },
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
        return { ok: true as const, orderId: 'ord_test_01', approvalId: 'apv_test_01' } as Awaited<ReturnType<RealToolsetPorts['proposals']['createOrderProposal']>>;
      }),
      createBookingProposal: vi.fn(async (input: BookingProposalInput) => {
        bookingProposals.push(input);
        return { ok: true as const, bookingId: 'bkg_test_01', approvalId: 'apv_test_02', slot } as Awaited<ReturnType<RealToolsetPorts['proposals']['createBookingProposal']>>;
      }),
    },
    orderStatus: {
      read: vi.fn(async ({ orderId }: { orderId: string }) => (orderId === 'ord_test_01' ? { orderId, status: 'AWAITING_OWNER_APPROVAL' as const, paid: false, checkoutLinkSent: false } : null)),
    },
    availability: { freeSlots: vi.fn<RealToolsetPorts['availability']['freeSlots']>(async () => [slot]) },
  } satisfies RealToolsetPorts;
  const pinned = opts.facts === null ? undefined : structuredClone(live.facts);
  const ts = createRealToolset({ businessId: opts.businessId ?? PIZZA, messageChannel: 'surge', ports, now: c.now, capabilities: opts.capabilities, factsSnapshot: pinned, toolTimeoutMs: opts.toolTimeoutMs });
  return { ts, ports, live, clock: c, orderProposals, bookingProposals, slot };
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

/** Presents the recipient, waits the read-back time, then confirms it. */
async function proposeConsented(s: ReturnType<typeof setup>, q: Quote, contact = consented) {
  const first = await s.ts.tools.propose_order({ cart, contact, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx);
  expect(first).toMatchObject({ ok: true, missingFields: [READBACK_FIELD.order] });
  s.clock.advance(READBACK_MIN_MS);
  return s.ts.tools.propose_order({ cart, contact, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx);
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
    expect(await ts.tools.quote_order({ cart }, pizzaCtx)).toMatchObject({ ok: false, reason: 'CAPABILITY_NOT_ALLOWED' });
  });

  it('refuses another business and bad arguments without calling a port', async () => {
    const s = setup();
    expect(await s.ts.tools.read_catalog({}, barberCtx)).toMatchObject({ ok: false, reason: 'CAPABILITY_NOT_ALLOWED' });
    expect(await s.ts.handler.call('quote_order', { cart: { lines: [] } }, pizzaCtx)).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
    expect(s.ports.quotes.quote).not.toHaveBeenCalled();
  });

  it('never throws: a port that throws is INTEGRATION_UNAVAILABLE', async () => {
    const s = setup();
    s.ports.catalog.search.mockRejectedValueOnce(new Error('db down'));
    await expect(s.ts.tools.read_catalog({ query: 'pepperoni' }, pizzaCtx)).resolves.toMatchObject({ ok: false, reason: 'INTEGRATION_UNAVAILABLE' });
  });
});

describe('real toolset: trace privacy and bounds (B2)', () => {
  it('B2: rejected arguments leave no values in the trace', async () => {
    const s = setup();
    const bad = { query: 'pizza', transcript: 'PRIVATE CALLER SPEECH', phone: '+15555550123', audio: 'PRIVATE AUDIO' };
    expect(await s.ts.handler.call('read_catalog', bad as never, pizzaCtx)).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
    const trace = s.ts.trace();
    expect(trace[0]).toMatchObject({ tool: 'read_catalog', input: { valid: false }, output: { ok: false, reason: 'VALIDATION_FAILED' }, mocked: false });
    const text = JSON.stringify(trace);
    for (const leak of ['PRIVATE', '5555550123', 'transcript', 'pizza']) expect(text).not.toContain(leak);
  });

  it('B2: a valid proposal traces field names and outcome codes only, no names or numbers', async () => {
    const s = setup();
    const q = await quoted(s);
    await proposeConsented(s, q);
    const trace = s.ts.trace();
    expect(trace.map((e) => e.tool)).toEqual(['quote_order', 'propose_order', 'propose_order']);
    expect(trace[2]).toMatchObject({ input: { valid: true, fields: ['cart', 'contact', 'fulfillment', 'quoteId'] }, output: { ok: true, proposalId: 'ord_test_01', approvalId: 'apv_test_01' } });
    const text = JSON.stringify(trace);
    for (const leak of ['Maya', '0123', 'SQ_ITEM']) expect(text).not.toContain(leak);
  });

  it('B2, S6: the trace and the quote store are bounded', async () => {
    const s = setup();
    for (let i = 0; i < MAX_TRACE_ENTRIES + 10; i++) await s.ts.tools.read_catalog({}, pizzaCtx);
    expect(s.ts.trace()).toHaveLength(MAX_TRACE_ENTRIES);
    const first = await quoted(s);
    for (let i = 0; i < MAX_QUOTES; i++) await quoted(s);
    // The oldest quote was evicted.
    expect(await s.ts.tools.propose_order({ cart, contact: declined, fulfillment: pickup, quoteId: first.quoteId }, pizzaCtx)).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
  });

  it('B2: dispose clears quotes and the trace, and later calls fail closed', async () => {
    const s = setup();
    const q = await quoted(s);
    s.ts.dispose();
    expect(s.ts.trace()).toEqual([]);
    expect(await s.ts.tools.propose_order({ cart, contact: declined, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx)).toMatchObject({ ok: false, reason: 'INTEGRATION_UNAVAILABLE' });
    expect(s.orderProposals).toHaveLength(0);
    expect(s.ts.trace()).toEqual([]);
  });
});

describe('real toolset: deadlines (S5)', () => {
  it('S5: a hung port times out as INTEGRATION_UNAVAILABLE', async () => {
    const s = setup({ toolTimeoutMs: 30 });
    s.ports.catalog.search.mockImplementationOnce(() => new Promise(() => undefined));
    expect(await s.ts.tools.read_catalog({}, pizzaCtx)).toMatchObject({ ok: false, reason: 'INTEGRATION_UNAVAILABLE' });
    expect((await s.ts.tools.read_catalog({}, pizzaCtx)).ok).toBe(true);
  });

  it('S5: a proposal whose earlier step outlived the deadline never reaches the proposal port', async () => {
    const s = setup({ facts: null });
    // The fact read hangs past the deadline, then finishes.
    let release: () => void = () => undefined;
    s.ports.facts.readVerified.mockImplementationOnce(() => new Promise((r) => (release = () => r(structuredClone(s.live.facts)))));
    const ts = createRealToolset({ businessId: PIZZA, messageChannel: 'surge', ports: s.ports, now: s.clock.now, toolTimeoutMs: 30 });
    const q = await ts.tools.quote_order({ cart }, pizzaCtx);
    if (!q.ok) throw new Error(q.reason);
    expect(await ts.tools.propose_order({ cart, contact: declined, fulfillment: pickup, quoteId: q.quote.quoteId }, pizzaCtx)).toMatchObject({ reason: 'INTEGRATION_UNAVAILABLE' });
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(s.orderProposals).toHaveLength(0);
  });
});

describe('real toolset: read tools', () => {
  it('read_catalog maps cached items to the tool shape', async () => {
    const r = await setup().ts.tools.read_catalog({ query: 'pizza' }, pizzaCtx);
    expectValid('read_catalog', r);
    if (!r.ok) throw new Error(r.reason);
    expect(r.items.map((i) => i.catalogItemId)).toEqual([SQ.itemMargherita, SQ.itemPepperoni]);
  });

  it('read_business_facts filters by kind', async () => {
    const r = await setup().ts.tools.read_business_facts({ kinds: ['hours'] }, pizzaCtx);
    expectValid('read_business_facts', r);
    if (!r.ok) throw new Error(r.reason);
    expect(r.facts).toHaveLength(7);
    expect(r.timezone).toBe(TZ);
  });

  it('S9: a pinned snapshot is used as is and the facts port is never read', async () => {
    const s = setup();
    const first = await s.ts.tools.read_business_facts({ kinds: ['hours'] }, pizzaCtx);
    s.live.facts = withHours(s.live.facts, 'fri', { open: '11:00', close: '23:00' });
    expect(await s.ts.tools.read_business_facts({ kinds: ['hours'] }, pizzaCtx)).toEqual(first);
    expect(s.ports.facts.readVerified).not.toHaveBeenCalled();
  });

  it('AC-16, S9: without a pinned snapshot facts are read once, and a failed read is not retried against newer facts', async () => {
    const s = setup({ facts: null });
    await new Promise((r) => setTimeout(r, 0));
    const ok = createRealToolset({ businessId: PIZZA, messageChannel: 'surge', ports: s.ports });
    const a = await ok.tools.read_business_facts({ kinds: ['hours'] }, pizzaCtx);
    s.live.facts = withHours(s.live.facts, 'fri', { open: '11:00', close: '23:00' });
    expect(await ok.tools.read_business_facts({ kinds: ['hours'] }, pizzaCtx)).toEqual(a);
    s.ports.facts.readVerified.mockRejectedValueOnce(new Error('down'));
    const failed = createRealToolset({ businessId: PIZZA, messageChannel: 'surge', ports: s.ports });
    expect(await failed.tools.read_business_facts({}, pizzaCtx)).toMatchObject({ ok: false, reason: 'INTEGRATION_UNAVAILABLE' });
    expect(await failed.tools.read_business_facts({}, pizzaCtx)).toMatchObject({ ok: false, reason: 'INTEGRATION_UNAVAILABLE' });
  });

  it('get_order_status reads through the port with the call ID, or NOT_FOUND', async () => {
    const s = setup();
    const r = await s.ts.tools.get_order_status({ orderId: 'ord_test_01' }, pizzaCtx);
    expectValid('get_order_status', r);
    expect(r).toMatchObject({ ok: true, status: 'AWAITING_OWNER_APPROVAL', paid: false });
    expect(s.ports.orderStatus.read).toHaveBeenCalledWith({ businessId: PIZZA, orderId: 'ord_test_01', callId: 'call_test_01' });
    expect(await s.ts.tools.get_order_status({ orderId: 'ord_other_99' }, pizzaCtx)).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
  });

  it('S9: availability uses the pinned service and hours, and drops slots that do not fit them', async () => {
    const s = setup({ businessId: BARBER, facts: snapshotOf(barberFacts) });
    const outside: AvailabilitySlot = { serviceId: serviceHaircut.id, startUtc: '2026-11-15T01:00:00Z', endUtc: '2026-11-15T01:30:00Z', timezone: TZ };
    const wrongLength: AvailabilitySlot = { serviceId: serviceHaircut.id, startUtc: '2026-11-14T23:00:00Z', endUtc: '2026-11-14T23:45:00Z', timezone: TZ };
    s.ports.availability.freeSlots.mockResolvedValueOnce([s.slot, outside, wrongLength]);
    const r = await s.ts.tools.read_calendar_availability({ serviceId: serviceHaircut.id, date: '2026-11-14' }, barberCtx);
    expectValid('read_calendar_availability', r);
    expect(r).toMatchObject({ ok: true, slots: [s.slot] });
    expect(s.ports.availability.freeSlots).toHaveBeenCalledWith({ businessId: BARBER, service: serviceHaircut, date: '2026-11-14', hours: { open: '09:00', close: '16:00' }, timezone: TZ, maxSlots: 5 });
    expect(await s.ts.tools.read_calendar_availability({ serviceId: 'svc_nope', date: '2026-11-14' }, barberCtx)).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    // Sunday is closed: no slots and no calendar read.
    expect(await s.ts.tools.read_calendar_availability({ serviceId: serviceHaircut.id, date: '2026-11-15' }, barberCtx)).toMatchObject({ ok: true, slots: [] });
    expect(s.ports.availability.freeSlots).toHaveBeenCalledTimes(1);
  });
});

describe('real toolset: quote_order and propose_order', () => {
  it('quote_order returns the quote, or ITEM_UNAVAILABLE', async () => {
    const r = await setup().ts.tools.quote_order({ cart }, pizzaCtx);
    expectValid('quote_order', r);
    expect(r.ok).toBe(true);
    expect(await setup({ unavailable: true }).ts.tools.quote_order({ cart }, pizzaCtx)).toMatchObject({ ok: false, reason: 'ITEM_UNAVAILABLE' });
  });

  it('S11: a consented recipient must be read back first; then it proposes with a server consent time', async () => {
    const s = setup();
    const q = await quoted(s);
    const r = await proposeConsented(s, q);
    expectValid('propose_order', r);
    expect(r).toMatchObject({ ok: true, proposalId: 'ord_test_01', approvalId: 'apv_test_01', missingFields: [] });
    expect(s.orderProposals).toHaveLength(1);
    const sent = s.orderProposals[0];
    expect(sent).toMatchObject({ messageChannel: 'surge', contact: { messageRecipient: '+15555550123', messageConsent: true }, callId: 'call_test_01', quote: q });
    // The model's 1999 timestamp is ignored; the server records when the read-back was confirmed.
    expect(sent?.contact.consentAt).toBe(new Date(Date.parse(FIXTURE_NOW) + READBACK_MIN_MS).toISOString());
  });

  it('S11: an immediate repeat is not a read-back', async () => {
    const s = setup();
    const q = await quoted(s);
    for (let i = 0; i < 3; i++) {
      expect(await s.ts.tools.propose_order({ cart, contact: consented, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx)).toMatchObject({ ok: true, missingFields: [READBACK_FIELD.order] });
    }
    expect(s.orderProposals).toHaveLength(0);
  });

  it('S11: changing the recipient restarts the read-back', async () => {
    const s = setup();
    const q = await quoted(s);
    await s.ts.tools.propose_order({ cart, contact: consented, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx);
    s.clock.advance(READBACK_MIN_MS);
    const swapped = { ...consented, messageRecipient: '+15555550999' };
    expect(await s.ts.tools.propose_order({ cart, contact: swapped, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx)).toMatchObject({ missingFields: [READBACK_FIELD.order] });
    expect(s.orderProposals).toHaveLength(0);
  });

  it('S11: a read-back on one call does not carry to another call', async () => {
    const a = setup();
    const qa = await quoted(a);
    await a.ts.tools.propose_order({ cart, contact: consented, fulfillment: pickup, quoteId: qa.quoteId }, pizzaCtx);
    const b = setup();
    b.clock.advance(READBACK_MIN_MS);
    const qb = await quoted(b);
    expect(await b.ts.tools.propose_order({ cart, contact: consented, fulfillment: pickup, quoteId: qb.quoteId }, pizzaCtx)).toMatchObject({ missingFields: [READBACK_FIELD.order] });
  });

  it('no consent proposes on qr_only with no recipient, in one step', async () => {
    const s = setup();
    const q = await quoted(s);
    expect(await s.ts.tools.propose_order({ cart, contact: declined, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx)).toMatchObject({ ok: true, proposalId: 'ord_test_01' });
    expect(s.orderProposals[0]?.messageChannel).toBe('qr_only');
    expect(s.orderProposals[0]?.contact).toEqual({ name: 'Maya Example', messageConsent: false });
  });

  it('a recipient without consent fails validation', async () => {
    const s = setup();
    const q = await quoted(s);
    const r = await s.ts.handler.call('propose_order', { cart, contact: { name: 'Maya', messageConsent: false, messageRecipient: '+15555550123' }, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx);
    expect(r).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
    expect(s.orderProposals).toHaveLength(0);
  });

  it('refuses an unknown quote, an expired quote (with a fresh one) and a changed cart', async () => {
    const s = setup();
    expect(await s.ts.tools.propose_order({ cart, contact: declined, fulfillment: pickup, quoteId: 'qte_never_made' }, pizzaCtx)).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    const q = await quoted(s);
    expect(await s.ts.tools.propose_order({ cart: otherCart, contact: declined, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx)).toMatchObject({ ok: false, reason: 'QUOTE_EXPIRED' });
    const q2 = await quoted(s);
    s.clock.advance(QUOTE_EXPIRY_MS + 1000);
    const r = await s.ts.tools.propose_order({ cart, contact: declined, fulfillment: { type: 'pickup', pickupAt: '2026-11-14T22:00:00Z' }, quoteId: q2.quoteId }, pizzaCtx);
    expectValid('propose_order', r);
    if (r.ok) throw new Error('expected a failure');
    expect(r.reason).toBe('QUOTE_EXPIRED');
    expect(r.quote?.quoteId).not.toBe(q2.quoteId);
    expect(s.orderProposals).toHaveLength(0);
  });

  it('a quote is used once', async () => {
    const s = setup();
    const q = await quoted(s);
    await s.ts.tools.propose_order({ cart, contact: declined, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx);
    expect(await s.ts.tools.propose_order({ cart, contact: declined, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx)).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
  });

  it('a blank name is a missing field and nothing is stored', async () => {
    const s = setup();
    const q = await quoted(s);
    const r = await s.ts.tools.propose_order({ cart, contact: { ...declined, name: '  ' }, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx);
    expectValid('propose_order', r);
    expect(r).toMatchObject({ ok: true, missingFields: ['contact.name'] });
    expect(s.orderProposals).toHaveLength(0);
  });

  it('S10: a pickup in the past, outside hours, on a day with missing or malformed hours, or with no facts is refused', async () => {
    const cases: [FactsSnapshot | null, string, string][] = [
      [snapshotOf(pizzaVerifiedFacts), '2026-11-14T19:00:00Z', 'VALIDATION_FAILED'], // past
      [snapshotOf(pizzaVerifiedFacts), '2026-11-15T07:00:00Z', 'VALIDATION_FAILED'], // Saturday 23:00, after close
      [withHours(snapshotOf(pizzaVerifiedFacts), 'sat', { open: 'noon' }), pickup.pickupAt, 'VALIDATION_FAILED'], // malformed
      [{ ...snapshotOf(pizzaVerifiedFacts), facts: snapshotOf(pizzaVerifiedFacts).facts.filter((f) => f.key !== 'sat') }, pickup.pickupAt, 'VALIDATION_FAILED'], // missing
      [withHours(snapshotOf(pizzaVerifiedFacts), 'sat', { closed: true }), pickup.pickupAt, 'VALIDATION_FAILED'], // closed
    ];
    for (const [facts, at, reason] of cases) {
      const s = setup({ facts });
      const q = await quoted(s);
      expect(await s.ts.tools.propose_order({ cart, contact: declined, fulfillment: { type: 'pickup', pickupAt: at }, quoteId: q.quoteId }, pizzaCtx)).toMatchObject({ ok: false, reason });
      expect(s.orderProposals).toHaveLength(0);
    }
    // No snapshot and the facts store is down: unavailable, nothing proposed.
    const down = setup({ facts: null });
    down.ports.facts.readVerified.mockRejectedValue(new Error('down'));
    const ts = createRealToolset({ businessId: PIZZA, messageChannel: 'surge', ports: down.ports, now: down.clock.now });
    const q = await ts.tools.quote_order({ cart }, pizzaCtx);
    if (!q.ok) throw new Error(q.reason);
    expect(await ts.tools.propose_order({ cart, contact: declined, fulfillment: { type: 'pickup', pickupAt: '2026-11-15T07:00:00Z' }, quoteId: q.quote.quoteId }, pizzaCtx)).toMatchObject({ ok: false, reason: 'INTEGRATION_UNAVAILABLE' });
    expect(down.orderProposals).toHaveLength(0);
  });

  it('passes a proposal port refusal through, with a bounded message', async () => {
    const s = setup();
    s.ports.proposals.createOrderProposal.mockResolvedValueOnce({ ok: false, reason: 'ITEM_UNAVAILABLE', message: `sold out ${'x'.repeat(500)}` });
    const q = await quoted(s);
    const r = await s.ts.tools.propose_order({ cart, contact: declined, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx);
    expect(r).toMatchObject({ ok: false, reason: 'ITEM_UNAVAILABLE' });
    expect(r.ok === false && (r.message?.length ?? 0) < 220).toBe(true);
  });
});

describe('real toolset: propose_booking', () => {
  const barber = () => setup({ businessId: BARBER, facts: snapshotOf(barberFacts) });
  const customer = { name: 'Sam', messageRecipient: '+15555550144', messageConsent: true };
  const at = '2026-11-14T22:00:00Z';

  it('S11: proposes a booking with consent after the read-back', async () => {
    const s = barber();
    expect(await s.ts.tools.propose_booking({ serviceId: serviceHaircut.id, startUtc: at, customer }, barberCtx)).toMatchObject({ ok: true, missingFields: [READBACK_FIELD.booking] });
    expect(s.bookingProposals).toHaveLength(0);
    s.clock.advance(READBACK_MIN_MS);
    const r = await s.ts.tools.propose_booking({ serviceId: serviceHaircut.id, startUtc: at, customer }, barberCtx);
    expectValid('propose_booking', r);
    expect(r).toMatchObject({ ok: true, proposalId: 'bkg_test_01', approvalId: 'apv_test_02', missingFields: [] });
    expect(s.bookingProposals[0]).toMatchObject({ messageChannel: 'surge', customer });
  });

  it('no consent proposes on qr_only with no recipient', async () => {
    const s = barber();
    await s.ts.tools.propose_booking({ serviceId: serviceHaircut.id, startUtc: at, customer: { name: 'Sam', messageConsent: false } }, barberCtx);
    expect(s.bookingProposals[0]).toMatchObject({ messageChannel: 'qr_only', customer: { name: 'Sam', messageConsent: false } });
    expect(s.bookingProposals[0]?.customer.messageRecipient).toBeUndefined();
  });

  it('SLOT_CONFLICT carries at most three alternatives', async () => {
    const s = barber();
    const alt = (h: number): AvailabilitySlot => ({ serviceId: serviceHaircut.id, startUtc: `2026-11-14T${h}:00:00Z`, endUtc: `2026-11-14T${h}:30:00Z`, timezone: TZ });
    s.ports.proposals.createBookingProposal.mockResolvedValueOnce({ ok: false, reason: 'SLOT_CONFLICT', alternatives: [alt(19), alt(20), alt(21), alt(22)] });
    const r = await s.ts.tools.propose_booking({ serviceId: serviceHaircut.id, startUtc: at, customer: { name: 'Sam', messageConsent: false } }, barberCtx);
    expectValid('propose_booking', r);
    if (r.ok) throw new Error('expected a failure');
    expect(r.reason).toBe('SLOT_CONFLICT');
    expect(r.alternatives).toHaveLength(3);
  });

  it('S10: an unknown service is NOT_FOUND; a closed, missing or malformed day is VALIDATION_FAILED', async () => {
    const s = barber();
    const c = { name: 'Sam', messageConsent: false };
    expect(await s.ts.tools.propose_booking({ serviceId: 'svc_nope', startUtc: at, customer: c }, barberCtx)).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    expect(await s.ts.tools.propose_booking({ serviceId: serviceHaircut.id, startUtc: '2026-11-15T19:00:00Z', customer: c }, barberCtx)).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
    const broken = setup({ businessId: BARBER, facts: withHours(snapshotOf(barberFacts), 'sat', 'whenever') });
    expect(await broken.ts.tools.propose_booking({ serviceId: serviceHaircut.id, startUtc: at, customer: c }, barberCtx)).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
    expect(await broken.ts.tools.read_calendar_availability({ serviceId: serviceHaircut.id, date: '2026-11-14' }, barberCtx)).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
    expect(s.bookingProposals).toHaveLength(0);
    expect(broken.bookingProposals).toHaveLength(0);
  });
});
