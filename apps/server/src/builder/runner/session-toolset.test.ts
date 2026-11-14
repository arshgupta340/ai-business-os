import { cartHash, type ToolContext } from '@abos/contracts';
import { SQ, serviceHaircut } from '@abos/contracts/fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionMockToolset } from './session-toolset';

// The builder's adapter in front of the shared mock toolset. These were the
// tests of the builder's temporary toolset; they now run against the shared
// one through the adapter, with the shared fixture IDs and values.

const now = () => new Date('2026-11-13T18:00:00Z'); // Friday 10:00 in Los Angeles
const pizza: ToolContext = { businessId: 'biz_pizza_01', agentVersionId: 'agv_draft_x', testSessionId: 'tst_a', correlationId: 'c1' };
const barber: ToolContext = { ...pizza, businessId: 'biz_barber_01', testSessionId: 'tst_b' };

const cart = {
  lines: [
    { catalogItemId: SQ.itemMargherita, variationId: SQ.varMargheritaLarge, quantity: 1, modifierIds: [SQ.modMushrooms] },
    { catalogItemId: SQ.itemPepperoni, variationId: SQ.varPepperoniLarge, quantity: 1, modifierIds: [] },
  ],
};
const contact = { name: 'Sam', messageRecipient: '+15555550123', messageConsent: true, consentAt: '2026-11-13T18:00:00Z' };
const pickup = { type: 'pickup' as const, pickupAt: '2026-11-14T03:00:00Z' }; // Friday 19:00 local

afterEach(() => vi.unstubAllGlobals());

describe('session mock toolset (shared toolset behind the adapter)', () => {
  it('reports itself as mock', () => {
    expect(new SessionMockToolset(now).toolset).toBe('mock');
  });

  it('quotes the CONTRACTS.md worked example: 4350 subtotal, 381 tax, 4731 total, on the runner clock', async () => {
    const r = await new SessionMockToolset(now).call('quote_order', { cart }, pizza);
    expect(r).toMatchObject({ ok: true, quote: { subtotalMinor: 4350, taxMinor: 381, totalMinor: 4731, currency: 'USD', expiresAt: '2026-11-13T18:05:00Z' } });
  });

  it('hashes a cart independent of line and modifier order (the package cartHash)', async () => {
    const reordered = { lines: [cart.lines[1]!, { ...cart.lines[0]!, modifierIds: [...cart.lines[0]!.modifierIds] }] };
    expect(await cartHash(reordered)).toBe(await cartHash(cart));
    expect(await cartHash(cart)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('proposes an order with an apv_mock_ approval and no network', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network is not allowed in the mock toolset');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const tools = new SessionMockToolset(now);
    const q = await tools.call('quote_order', { cart }, pizza);
    if (!q.ok) throw new Error('quote failed');
    const p = await tools.call('propose_order', { cart, contact, fulfillment: pickup, quoteId: q.quote.quoteId }, pizza);
    expect(p).toMatchObject({ ok: true, missingFields: [] });
    if (!p.ok) throw new Error('propose failed');
    expect(p.approvalId).toMatch(/^apv_mock_/);
    expect(p.proposalId).toMatch(/^ord_mock_/);
    expect(await tools.call('get_order_status', { orderId: p.proposalId! }, pizza)).toMatchObject({ ok: true, status: 'AWAITING_OWNER_APPROVAL', paid: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses an unknown quote, a changed cart with a fresh quote, and a pickup outside hours', async () => {
    const tools = new SessionMockToolset(now);
    // The shared toolset answers an unknown quote ID with NOT_FOUND (the builder's answered QUOTE_EXPIRED).
    const unknown = await tools.call('propose_order', { cart, contact, fulfillment: pickup, quoteId: 'qte_nope' }, pizza);
    expect(unknown).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    const q = await tools.call('quote_order', { cart }, pizza);
    if (!q.ok) throw new Error('quote failed');
    const changed = { lines: [cart.lines[1]!] };
    const stale = await tools.call('propose_order', { cart: changed, contact, fulfillment: pickup, quoteId: q.quote.quoteId }, pizza);
    expect(stale).toMatchObject({ ok: false, reason: 'QUOTE_EXPIRED', quote: { subtotalMinor: 2200 } });
    const late = await tools.call('propose_order', { cart, contact, fulfillment: { type: 'pickup', pickupAt: '2026-11-14T08:00:00Z' }, quoteId: q.quote.quoteId }, pizza);
    expect(late).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
  });

  it('accepts a caller who declines messages (qr_only) and refuses a recipient without consent', async () => {
    const tools = new SessionMockToolset(now);
    const q = await tools.call('quote_order', { cart }, pizza);
    if (!q.ok) throw new Error('quote failed');
    // The shared toolset follows ContactSchema: no consent means no recipient, and the proposal still goes to the owner.
    const declined = await tools.call('propose_order', { cart, contact: { name: 'Sam', messageConsent: false }, fulfillment: pickup, quoteId: q.quote.quoteId }, pizza);
    expect(declined).toMatchObject({ ok: true, missingFields: [], approvalId: expect.stringMatching(/^apv_mock_/) });
    const mixed = await tools.call('propose_order', { cart, contact: { ...contact, messageConsent: false }, fulfillment: pickup, quoteId: q.quote.quoteId }, pizza);
    expect(mixed).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
  });

  it('answers ITEM_UNAVAILABLE for an item or topping that is not on the menu', async () => {
    const tools = new SessionMockToolset(now);
    expect(await tools.call('quote_order', { cart: { lines: [{ catalogItemId: 'SQ_ITEM_NOPE', variationId: 'SQ_VAR_NOPE', quantity: 1, modifierIds: [] }] } }, pizza)).toMatchObject({
      ok: false,
      reason: 'ITEM_UNAVAILABLE',
    });
    expect(await tools.call('quote_order', { cart: { lines: [{ ...cart.lines[0]!, modifierIds: ['SQ_MOD_MUSHROOM'] }] } }, pizza)).toMatchObject({ ok: false, reason: 'ITEM_UNAVAILABLE' });
  });

  it('lists free slots on a 15 minute grid in the business timezone; closed on Monday', async () => {
    const r = await new SessionMockToolset(now).call('read_calendar_availability', { serviceId: serviceHaircut.id, date: '2026-11-14' }, barber);
    if (!r.ok) throw new Error('availability failed');
    expect(r.timezone).toBe('America/Los_Angeles');
    expect(r.slots[0]).toEqual({ serviceId: 'svc_haircut', startUtc: '2026-11-14T17:00:00Z', endUtc: '2026-11-14T17:30:00Z', timezone: 'America/Los_Angeles' });
    expect(r.slots).toHaveLength(5);
    const monday = await new SessionMockToolset(now).call('read_calendar_availability', { serviceId: serviceHaircut.id, date: '2026-11-16' }, barber);
    expect(monday).toMatchObject({ ok: true, slots: [] });
  });

  it('proposes a free slot and gives alternatives for a taken one (busy blocks on 2026-11-17)', async () => {
    const tools = new SessionMockToolset(now);
    const customer = { name: 'Ana', messageRecipient: '+15555550124', messageConsent: true };
    const ok = await tools.call('propose_booking', { serviceId: serviceHaircut.id, startUtc: '2026-11-14T17:00:00Z', customer }, barber);
    expect(ok).toMatchObject({ ok: true, approvalId: expect.stringMatching(/^apv_mock_/), proposalId: expect.stringMatching(/^bkg_mock_/) });
    // 09:00 local on Tuesday 2026-11-17 is inside a fixture busy block.
    const busy = await tools.call('propose_booking', { serviceId: serviceHaircut.id, startUtc: '2026-11-17T17:00:00Z', customer }, barber);
    expect(busy).toMatchObject({ ok: false, reason: 'SLOT_CONFLICT' });
    if (busy.ok) throw new Error('expected conflict');
    expect(busy.alternatives).toHaveLength(3);
  });

  it('keeps businesses apart: the barbershop has no menu', async () => {
    expect(await new SessionMockToolset(now).call('read_catalog', {}, barber)).toEqual({ ok: true, items: [] });
  });

  it('keeps one state per test session, and reset clears only that session', async () => {
    const tools = new SessionMockToolset(now);
    const other: ToolContext = { ...pizza, testSessionId: 'tst_other' };
    const q = await tools.call('quote_order', { cart }, pizza);
    if (!q.ok) throw new Error('quote failed');
    expect(await tools.call('propose_order', { cart, contact, fulfillment: pickup, quoteId: q.quote.quoteId }, other)).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    const q2 = await tools.call('quote_order', { cart }, other);
    if (!q2.ok) throw new Error('quote failed');
    tools.reset('tst_a');
    expect(await tools.call('propose_order', { cart, contact, fulfillment: pickup, quoteId: q.quote.quoteId }, pizza)).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    expect(await tools.call('propose_order', { cart, contact, fulfillment: pickup, quoteId: q2.quote.quoteId }, other)).toMatchObject({ ok: true });
  });

  it('refuses a context without a test session or with a context the contract does not allow', async () => {
    const tools = new SessionMockToolset(now);
    const { testSessionId: _t, ...noSession } = pizza;
    await expect(tools.call('read_catalog', {}, noSession)).rejects.toThrow(/needs a testSessionId/);
    await expect(tools.call('read_catalog', {}, { ...pizza, agentVersionId: 'draft:agt_x' })).rejects.toThrow(/does not match the contract/);
    // A session belongs to one business.
    await tools.call('read_catalog', {}, pizza);
    await expect(tools.call('read_catalog', {}, { ...pizza, businessId: 'biz_barber_01' })).rejects.toThrow(/belongs to biz_pizza_01/);
  });
});
