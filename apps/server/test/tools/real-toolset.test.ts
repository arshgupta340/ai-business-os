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
import { MAX_QUOTES, MAX_TRACE_ENTRIES, createRealToolset } from '../../src/tools/real/index';
import type { BookingProposalInput, ConsentEvidence, FactsSnapshot, OrderProposalInput, RealToolsetDeps, RealToolsetPorts } from '../../src/tools/real/types';

const READBACK_MIN_MS = 3000; // Elapsed time is deliberately not consent evidence.
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

type SetupOpts = { businessId?: string; facts?: FactsSnapshot | null; capabilities?: RealToolsetDeps['capabilities']; unavailable?: boolean; toolTimeoutMs?: number; consent?: RealToolsetDeps['consent']; channel?: RealToolsetDeps['messageChannel'] };

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
      atomicOperations: true,
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
      read: vi.fn(async ({ orderId }: { orderId: string }) => (orderId === 'ord_test_01' ? { orderId, businessId: PIZZA, callId: 'call_test_01', status: 'AWAITING_OWNER_APPROVAL' as const, paid: false, checkoutLinkSent: false } : null)),
    },
    availability: { freeSlots: vi.fn<RealToolsetPorts['availability']['freeSlots']>(async () => [slot]) },
  } satisfies RealToolsetPorts;
  const pinned = opts.facts === null ? undefined : structuredClone(live.facts);
  const ts = createRealToolset({ businessId: opts.businessId ?? PIZZA, messageChannel: opts.channel ?? 'surge', ports, now: c.now, capabilities: opts.capabilities, factsSnapshot: pinned, toolTimeoutMs: opts.toolTimeoutMs, consent: opts.consent });
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

/** A model consent claim has no trusted evidence and therefore uses the counter instead. */
async function proposeConsented(s: ReturnType<typeof setup>, q: Quote, contact = consented) {
  const result = await s.ts.tools.propose_order({ cart, contact, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx);
  expect(s.orderProposals[0]?.contact).toEqual({ name: contact.name, messageConsent: false });
  return result;
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
    expect(trace.map((e) => e.tool)).toEqual(['quote_order', 'propose_order']);
    expect(trace[1]).toMatchObject({ input: { valid: true, fields: ['cart', 'contact', 'fulfillment', 'quoteId'] }, output: { ok: true, proposalId: 'ord_test_01', approvalId: 'apv_test_01' } });
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
    const s = setup({ toolTimeoutMs: 250 });
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
    expect(s.ports.orderStatus.read).toHaveBeenCalledWith({ businessId: PIZZA, orderId: 'ord_test_01', callId: 'call_test_01', signal: expect.any(AbortSignal) });
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
    expect(s.ports.availability.freeSlots).toHaveBeenCalledWith({ businessId: BARBER, service: serviceHaircut, date: '2026-11-14', hours: { open: '09:00', close: '16:00' }, timezone: TZ, maxSlots: 5, signal: expect.any(AbortSignal) });
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

  it('S11, R3: a forged consent timestamp and recipient are omitted from the QR proposal', async () => {
    const s = setup(); const q = await quoted(s);
    const r = await proposeConsented(s, q);
    expectValid('propose_order', r);
    expect(r).toMatchObject({ ok: true, proposalId: 'ord_test_01', approvalId: 'apv_test_01', missingFields: [] });
    expect(s.orderProposals).toHaveLength(1);
    expect(s.orderProposals[0]).toMatchObject({ messageChannel: 'qr_only', contact: { name: consented.name, messageConsent: false }, callId: 'call_test_01', quote: q });
    expect(s.orderProposals[0]?.contact.messageRecipient).toBeUndefined();
    expect(s.orderProposals[0]?.contact.consentAt).toBeUndefined();
  });

  it('S11, R3: repeated model claims cannot enable messages', async () => {
    const s = setup(); const q = await quoted(s);
    await proposeConsented(s, q);
    for (let i = 0; i < 3; i++) {
      s.clock.advance(READBACK_MIN_MS);
      await s.ts.tools.propose_order({ cart, contact: consented, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx);
    }
    expect(s.orderProposals).toHaveLength(1);
    expect(s.orderProposals.every((p) => !p.contact.messageConsent && p.messageChannel === 'qr_only')).toBe(true);
  });

  it('S11, R3: changing a claimed recipient never establishes consent', async () => {
    const s = setup();
    for (const recipient of [consented.messageRecipient, '+15555550999']) {
      const q = await quoted(s);
      await proposeConsented(s, q, { ...consented, messageRecipient: recipient });
      s.clock.advance(READBACK_MIN_MS);
    }
    expect(s.orderProposals).toHaveLength(2);
    for (const proposal of s.orderProposals) expect(proposal.contact).toEqual({ name: consented.name, messageConsent: false });
  });

  it('S11, R3: neither of two distinct calls can certify model consent', async () => {
    const a = setup(); const b = setup();
    await proposeConsented(a, await quoted(a));
    b.clock.advance(READBACK_MIN_MS);
    const qb = await quoted(b);
    await b.ts.tools.propose_order({ cart, contact: consented, fulfillment: pickup, quoteId: qb.quoteId }, { ...pizzaCtx, callId: 'call_distinct_02' });
    expect(a.orderProposals[0]?.callId).toBe('call_test_01');
    expect(b.orderProposals[0]?.callId).toBe('call_distinct_02');
    for (const proposal of [...a.orderProposals, ...b.orderProposals]) expect(proposal.contact).toEqual({ name: consented.name, messageConsent: false });
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

  it('a successful sequential proposal consumes its quote', async () => {
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

  it('S11, R3: a booking model consent claim falls back to QR-only without a recipient', async () => {
    const s = barber();
    const r = await s.ts.tools.propose_booking({ serviceId: serviceHaircut.id, startUtc: at, customer }, barberCtx);
    expectValid('propose_booking', r);
    expect(r).toMatchObject({ ok: true, proposalId: 'bkg_test_01', approvalId: 'apv_test_02', missingFields: [] });
    expect(s.bookingProposals).toHaveLength(1);
    expect(s.bookingProposals[0]).toMatchObject({ messageChannel: 'qr_only', customer: { name: 'Sam', messageConsent: false } });
    expect(s.bookingProposals[0]?.customer.messageRecipient).toBeUndefined();
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
    const missing = setup({ businessId: BARBER, facts: { ...snapshotOf(barberFacts), facts: snapshotOf(barberFacts).facts.filter((f) => f.key !== 'sat') } });
    expect(await missing.ts.tools.propose_booking({ serviceId: serviceHaircut.id, startUtc: at, customer: c }, barberCtx)).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
    expect(missing.bookingProposals).toHaveLength(0);
  });
});


describe('rereview real tool regressions', () => {
  it('R2: a timed-out proposal reserves its quote while the outcome is uncertain', async () => {
    const s = setup({ toolTimeoutMs: 250 });
    const q = await quoted(s);
    let release: () => void = () => undefined;
    s.ports.proposals.createOrderProposal.mockImplementationOnce(() => new Promise((r) => { release = () => r({ ok: true, orderId: 'ord_test_01', approvalId: 'apv_test_01' }); }));
    const args = { cart, contact: declined, fulfillment: pickup, quoteId: q.quoteId };
    expect(await s.ts.tools.propose_order(args, pizzaCtx)).toMatchObject({ reason: 'INTEGRATION_UNAVAILABLE' });
    await s.ts.tools.propose_order(args, pizzaCtx);
    expect(s.ports.proposals.createOrderProposal).toHaveBeenCalledTimes(1);
    release(); s.ts.dispose();
  });

  it('R2: a late quote result cannot become proposable after timeout', async () => {
    const s = setup({ toolTimeoutMs: 250 });
    const q = await quoted(s);
    let release: () => void = () => undefined;
    s.ports.quotes.quote.mockImplementationOnce(() => new Promise((r) => { release = () => r({ ok: true, quote: { ...q, quoteId: 'qte_late' } }); }));
    expect(await s.ts.tools.quote_order({ cart }, pizzaCtx)).toMatchObject({ reason: 'INTEGRATION_UNAVAILABLE' });
    release(); await new Promise((r) => setTimeout(r, 0));
    expect(await s.ts.tools.propose_order({ cart, contact: declined, fulfillment: pickup, quoteId: 'qte_late' }, pizzaCtx)).toMatchObject({ reason: 'NOT_FOUND' });
    expect(s.orderProposals).toHaveLength(0);
  });

  it('R3: time and repeated model calls cannot certify message consent', async () => {
    const s = setup(); const q = await quoted(s);
    const args = { cart, contact: consented, fulfillment: pickup, quoteId: q.quoteId };
    await s.ts.tools.propose_order(args, pizzaCtx);
    s.clock.advance(3000);
    await s.ts.tools.propose_order(args, pizzaCtx);
    expect(s.orderProposals).toHaveLength(1);
    expect(s.orderProposals[0]?.contact).toEqual({ name: consented.name, messageConsent: false });
    expect(s.orderProposals[0]?.messageChannel).toBe('qr_only');
  });
});


it('status reads reject wrong-call, wrong-business and unscoped rows from the adapter', async () => {
  const s = setup();
  const rows = [
    { orderId: 'ord_test_01', businessId: PIZZA, callId: 'call_other_02', status: 'AWAITING_OWNER_APPROVAL', paid: false, checkoutLinkSent: false },
    { orderId: 'ord_test_01', businessId: BARBER, callId: pizzaCtx.callId, status: 'AWAITING_OWNER_APPROVAL', paid: false, checkoutLinkSent: false },
    { orderId: 'ord_test_01', status: 'AWAITING_OWNER_APPROVAL', paid: false, checkoutLinkSent: false },
  ];
  for (const row of rows) {
    s.ports.orderStatus.read.mockResolvedValueOnce(row as never);
    expect(await s.ts.tools.get_order_status({ orderId: 'ord_test_01' }, pizzaCtx)).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
  }
});

it('proposal adapters without atomic routine support fail closed', async () => {
  const s = setup();
  const ports = { ...s.ports, proposals: { createOrderProposal: s.ports.proposals.createOrderProposal, createBookingProposal: s.ports.proposals.createBookingProposal } };
  const ts = createRealToolset({ businessId: PIZZA, ports, messageChannel: 'surge', factsSnapshot: s.live.facts, now: s.clock.now });
  const fresh = await ts.tools.quote_order({ cart }, pizzaCtx);
  if (!fresh.ok) throw new Error(fresh.reason);
  expect(await ts.tools.propose_order({ cart, contact: declined, fulfillment: pickup, quoteId: fresh.quote.quoteId }, pizzaCtx)).toMatchObject({ reason: 'INTEGRATION_UNAVAILABLE' });
  expect(s.ports.proposals.createOrderProposal).not.toHaveBeenCalled();
});


it('untrusted port failure messages cannot expose keys, bill links or full phone numbers', async () => {
  const s = setup(); const q = await quoted(s);
  const privateText = 'Bearer short-secret https://bill.example/pay +15555550123 streamSecret';
  s.ports.proposals.createOrderProposal.mockResolvedValueOnce({ ok: false, reason: 'ITEM_UNAVAILABLE', message: privateText });
  const result = await s.ts.tools.propose_order({ cart, contact: declined, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx);
  expect(result).toMatchObject({ ok: false, reason: 'ITEM_UNAVAILABLE' });
  for (const value of ['short-secret', 'bill.example', '15555550123', 'streamSecret']) expect(JSON.stringify(result)).not.toContain(value);
});


// PROPOSED text step (SPEC 2.9 "Consent evidence on a phone call"): only server-held evidence for this
// exact call and version turns a proposal into a message proposal. The model's contact flags never do.
describe('real toolset: consent evidence from the phone relay', () => {
  const RECIPIENT = '+15555553716';
  const evidenceFor = (ctx: ToolContext, patch: Partial<ConsentEvidence> = {}): ConsentEvidence => ({
    callId: ctx.callId!, agentVersionId: ctx.agentVersionId, recipient: RECIPIENT, offerSpokenAt: '2026-11-14T19:00:00.000Z', method: 'spoken', consentAt: '2026-11-14T19:00:04.000Z', ...patch,
  });
  const sourceFor = (ctx: ToolContext, read: () => ConsentEvidence | undefined) => ({ callId: ctx.callId!, agentVersionId: ctx.agentVersionId, read });

  it('with evidence the order proposal carries the recipient, consent, consentAt and the server channel', async () => {
    const s = setup({ consent: sourceFor(pizzaCtx, () => evidenceFor(pizzaCtx)) });
    const q = await quoted(s);
    const r = await s.ts.tools.propose_order({ cart, contact: { name: 'Maya Example', messageConsent: false }, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx);
    expect(r).toMatchObject({ ok: true });
    expect(s.orderProposals[0]).toMatchObject({ messageChannel: 'surge', contact: { name: 'Maya Example', messageRecipient: RECIPIENT, messageConsent: true, consentAt: '2026-11-14T19:00:04.000Z' } });
    expect(JSON.stringify(r)).not.toContain(RECIPIENT);
  });

  it('keypad evidence works the same way', async () => {
    const s = setup({ consent: sourceFor(pizzaCtx, () => evidenceFor(pizzaCtx, { method: 'keypad' })) });
    const q = await quoted(s);
    await s.ts.tools.propose_order({ cart, contact: declined, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx);
    expect(s.orderProposals[0]).toMatchObject({ messageChannel: 'surge', contact: { messageRecipient: RECIPIENT, messageConsent: true } });
  });

  it('a forged model messageConsent, phone and consentAt without evidence stays qr_only with no recipient', async () => {
    const s = setup({ consent: sourceFor(pizzaCtx, () => undefined) });
    const q = await quoted(s);
    await s.ts.tools.propose_order({ cart, contact: consented, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx);
    expect(s.orderProposals[0]).toMatchObject({ messageChannel: 'qr_only', contact: { name: 'Maya Example', messageConsent: false } });
    expect(s.orderProposals[0]?.contact.messageRecipient).toBeUndefined();
    expect(s.orderProposals[0]?.contact.consentAt).toBeUndefined();
  });

  it('with evidence, the phone number and consentAt the model sends are ignored', async () => {
    const s = setup({ consent: sourceFor(pizzaCtx, () => evidenceFor(pizzaCtx)) });
    const q = await quoted(s);
    await s.ts.tools.propose_order({ cart, contact: { ...consented, messageRecipient: '+15555559999' }, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx);
    expect(s.orderProposals[0]?.contact).toEqual({ name: 'Maya Example', messageRecipient: RECIPIENT, messageConsent: true, consentAt: '2026-11-14T19:00:04.000Z' });
  });

  it.each([
    ['another call', { callId: 'call_other_99' }],
    ['another version', { agentVersionId: 'agv_pizza_01_v1' }],
    ['a malformed recipient', { recipient: '5555553716' }],
    ['an unknown method', { method: 'model' as never }],
    ['consent before the offer was spoken', { consentAt: '2026-11-14T18:59:59.000Z' }],
    ['an unreadable time', { consentAt: 'soon' }],
  ])('evidence for %s is refused and the proposal stays qr_only', async (_label, patch) => {
    const s = setup({ consent: sourceFor(pizzaCtx, () => evidenceFor(pizzaCtx, patch)) });
    const q = await quoted(s);
    await s.ts.tools.propose_order({ cart, contact: declined, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx);
    expect(s.orderProposals[0]).toMatchObject({ messageChannel: 'qr_only', contact: { messageConsent: false } });
    expect(s.orderProposals[0]?.contact.messageRecipient).toBeUndefined();
  });

  it('a toolset bound to one call refuses evidence when it is called for another call', async () => {
    const s = setup({ consent: sourceFor(pizzaCtx, () => evidenceFor(pizzaCtx)) });
    const other: ToolContext = { ...pizzaCtx, callId: 'call_other_99', correlationId: 'call_other_99' };
    const r = await s.ts.tools.quote_order({ cart }, other);
    if (!r.ok) throw new Error(r.reason);
    await s.ts.tools.propose_order({ cart, contact: declined, fulfillment: pickup, quoteId: r.quote.quoteId }, other);
    expect(s.orderProposals[0]).toMatchObject({ messageChannel: 'qr_only' });
    expect(s.orderProposals[0]?.contact.messageRecipient).toBeUndefined();
  });

  it('under qr_only, even valid evidence never reaches a proposal', async () => {
    const read = vi.fn(() => evidenceFor(pizzaCtx));
    const s = setup({ channel: 'qr_only', consent: sourceFor(pizzaCtx, read) });
    const q = await quoted(s);
    await s.ts.tools.propose_order({ cart, contact: consented, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx);
    expect(s.orderProposals[0]).toMatchObject({ messageChannel: 'qr_only', contact: { messageConsent: false } });
    expect(read).not.toHaveBeenCalled();
  });

  it('a reader that throws is no evidence', async () => {
    const s = setup({ consent: sourceFor(pizzaCtx, () => { throw new Error('boom'); }) });
    const q = await quoted(s);
    expect(await s.ts.tools.propose_order({ cart, contact: declined, fulfillment: pickup, quoteId: q.quoteId }, pizzaCtx)).toMatchObject({ ok: true });
    expect(s.orderProposals[0]).toMatchObject({ messageChannel: 'qr_only' });
  });

  it('with evidence the booking proposal carries the recipient, consent and the server channel', async () => {
    const s = setup({ businessId: BARBER, facts: snapshotOf(barberFacts), channel: 'whatsapp_sandbox', consent: sourceFor(barberCtx, () => evidenceFor(barberCtx)) });
    await s.ts.tools.propose_booking({ serviceId: serviceHaircut.id, startUtc: '2026-11-14T22:00:00Z', customer: { name: 'Sam', messageConsent: false } }, barberCtx);
    expect(s.bookingProposals[0]).toMatchObject({ messageChannel: 'whatsapp_sandbox', customer: { name: 'Sam', messageRecipient: RECIPIENT, messageConsent: true } });
  });

  it('a booking with a forged model consent and no evidence stays qr_only', async () => {
    const s = setup({ businessId: BARBER, facts: snapshotOf(barberFacts), consent: sourceFor(barberCtx, () => undefined) });
    await s.ts.tools.propose_booking({ serviceId: serviceHaircut.id, startUtc: '2026-11-14T22:00:00Z', customer: { name: 'Sam', messageRecipient: '+15555550144', messageConsent: true } }, barberCtx);
    expect(s.bookingProposals[0]).toMatchObject({ messageChannel: 'qr_only', customer: { messageConsent: false } });
    expect(s.bookingProposals[0]?.customer.messageRecipient).toBeUndefined();
  });
});
