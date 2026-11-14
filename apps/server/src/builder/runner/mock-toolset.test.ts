import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../pending-contracts';
import { hashCart, MockToolset } from './mock-toolset';

const now = () => new Date('2026-11-13T18:00:00Z'); // Friday 10:00 in Los Angeles
const pizza: ToolContext = { businessId: 'biz_pizza_01', agentVersionId: 'draft:agt_x', testSessionId: 'tst_a', correlationId: 'c1' };
const barber: ToolContext = { ...pizza, businessId: 'biz_barber_01' };

const cart = {
  lines: [
    { catalogItemId: 'SQ_ITEM_MARG', variationId: 'SQ_VAR_MARG_LG', quantity: 1, modifierIds: ['SQ_MOD_MUSHROOM'] },
    { catalogItemId: 'SQ_ITEM_PEP', variationId: 'SQ_VAR_PEP_LG', quantity: 1, modifierIds: [] },
  ],
};
const contact = { name: 'Sam', messageRecipient: '+15555550123', messageConsent: true, consentAt: '2026-11-13T18:00:00Z' };

afterEach(() => vi.unstubAllGlobals());

describe('mock toolset', () => {
  it('reports itself as mock', () => {
    expect(new MockToolset(now).toolset).toBe('mock');
  });

  it('quotes the CONTRACTS.md worked example: 4350 subtotal, 381 tax, 4731 total', async () => {
    const r = await new MockToolset(now).call('quote_order', { cart }, pizza);
    expect(r).toMatchObject({ ok: true, quote: { subtotalMinor: 4350, taxMinor: 381, totalMinor: 4731, currency: 'USD', expiresAt: '2026-11-13T18:05:00Z' } });
  });

  it('hashes a cart independent of line and modifier order', () => {
    const reordered = { lines: [cart.lines[1]!, { ...cart.lines[0]!, modifierIds: [...cart.lines[0]!.modifierIds] }] };
    expect(hashCart(reordered)).toBe(hashCart(cart));
    expect(hashCart(cart)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('proposes an order with an apv_mock_ approval and no network', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network is not allowed in the mock toolset');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const tools = new MockToolset(now);
    const q = await tools.call('quote_order', { cart }, pizza);
    if (!q.ok) throw new Error('quote failed');
    const p = await tools.call('propose_order', { cart, contact, fulfillment: { type: 'pickup', pickupAt: '2026-11-14T03:00:00Z' }, quoteId: q.quote.quoteId }, pizza);
    expect(p).toMatchObject({ ok: true, missingFields: [] });
    if (!p.ok) throw new Error('propose failed');
    expect(p.approvalId).toMatch(/^apv_mock_/);
    expect(p.proposalId).toMatch(/^ord_mock_/);
    expect(await tools.call('get_order_status', { orderId: p.proposalId! }, pizza)).toMatchObject({ ok: true, status: 'AWAITING_OWNER_APPROVAL', paid: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a stale or unknown quote with a fresh one, and a pickup outside hours', async () => {
    const tools = new MockToolset(now);
    const stale = await tools.call('propose_order', { cart, contact, fulfillment: { type: 'pickup', pickupAt: '2026-11-14T03:00:00Z' }, quoteId: 'qte_nope' }, pizza);
    expect(stale).toMatchObject({ ok: false, reason: 'QUOTE_EXPIRED', quote: { totalMinor: 4731 } });
    const q = await tools.call('quote_order', { cart }, pizza);
    if (!q.ok) throw new Error('quote failed');
    const late = await tools.call('propose_order', { cart, contact, fulfillment: { type: 'pickup', pickupAt: '2026-11-14T08:00:00Z' }, quoteId: q.quote.quoteId }, pizza);
    expect(late).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
  });

  it('stores nothing without consent and reports the missing field', async () => {
    const tools = new MockToolset(now);
    const q = await tools.call('quote_order', { cart }, pizza);
    if (!q.ok) throw new Error('quote failed');
    const r = await tools.call(
      'propose_order',
      { cart, contact: { ...contact, messageConsent: false }, fulfillment: { type: 'pickup', pickupAt: '2026-11-14T03:00:00Z' }, quoteId: q.quote.quoteId },
      pizza,
    );
    expect(r).toEqual({ ok: true, missingFields: ['contact.messageConsent'] });
  });

  it('lists free slots on a 15 minute grid in the business timezone, skipping the busy block', async () => {
    const r = await new MockToolset(now).call('read_calendar_availability', { serviceId: 'svc_cut', date: '2026-11-14' }, barber);
    if (!r.ok) throw new Error('availability failed');
    expect(r.timezone).toBe('America/Los_Angeles');
    expect(r.slots[0]).toEqual({ serviceId: 'svc_cut', startUtc: '2026-11-14T17:00:00Z', endUtc: '2026-11-14T17:30:00Z', timezone: 'America/Los_Angeles' });
    expect(r.slots).toHaveLength(5);
    const monday = await new MockToolset(now).call('read_calendar_availability', { serviceId: 'svc_cut', date: '2026-11-16' }, barber);
    expect(monday).toMatchObject({ ok: true, slots: [] });
  });

  it('proposes a free slot and gives alternatives for a taken one', async () => {
    const tools = new MockToolset(now);
    const customer = { name: 'Ana', messageRecipient: '+15555550124', messageConsent: true };
    const ok = await tools.call('propose_booking', { serviceId: 'svc_cut', startUtc: '2026-11-14T17:00:00Z', customer }, barber);
    expect(ok).toMatchObject({ ok: true, approvalId: expect.stringMatching(/^apv_mock_/), proposalId: expect.stringMatching(/^bkg_mock_/) });
    // 12:00 local is inside the mock busy block.
    const busy = await tools.call('propose_booking', { serviceId: 'svc_cut', startUtc: '2026-11-14T20:00:00Z', customer }, barber);
    expect(busy).toMatchObject({ ok: false, reason: 'SLOT_CONFLICT' });
    if (busy.ok) throw new Error('expected conflict');
    expect(busy.alternatives).toHaveLength(3);
  });

  it('keeps businesses apart: the barbershop has no menu', async () => {
    expect(await new MockToolset(now).call('read_catalog', {}, barber)).toEqual({ ok: true, items: [] });
  });
});
