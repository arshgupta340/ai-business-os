// The relay wired to the real toolset (fake ports only): what the model sends is validated for real.
import { describe, expect, it, vi } from 'vitest';
import { FIXTURE_NOW, SQ, pizzaCatalog, pizzaSpecV2 } from '@abos/contracts/fixtures';
import { cartHash, type Cart, type Quote } from '@abos/contracts';
import { createRealToolset } from '../../src/tools/real/index';
import type { RealToolsetPorts } from '../../src/tools/real/types';
import { StreamTokenStore } from '../../src/voice/logic';
import { runPhoneRelay } from '../../src/voice/relay';
import type { PinnedCall } from '../../src/voice/types';
import { FakeSocket, PIZZA_SNAPSHOT, fakeCalls, fakeEvents, fakeLogger, type Json } from './helpers';

describe('voice relay with the real toolset', () => {
  it('rejects an empty proposal and model-supplied server context, and never creates a proposal', async () => {
    const createOrderProposal = vi.fn();
    const ports = {
      catalog: { search: async () => pizzaCatalog },
      quotes: { quote: vi.fn() },
      proposals: { createOrderProposal, createBookingProposal: vi.fn() },
      orderStatus: { read: async () => null },
      availability: { freeSlots: async () => [] },
    } as unknown as RealToolsetPorts;
    const tokens = new StreamTokenStore<PinnedCall>();
    const token = tokens.mint({ callId: 'call_test_01', providerCallId: 'CA123', businessId: 'biz_pizza_01', businessName: 'Demo Pizza Co.', agentId: pizzaSpecV2.id, agentVersionId: 'agv_pizza_01_v2', spec: pizzaSpecV2, facts: PIZZA_SNAPSHOT }) ?? '';
    const phone = new FakeSocket();
    const model = new FakeSocket();
    const openaiSocketFactory = vi.fn(() => model);
    const relay = runPhoneRelay({
      phone, tokens, calls: fakeCalls(), events: fakeEvents(), messageChannel: 'surge', logger: fakeLogger().logger,
      openaiSocketFactory,
      toolsetFactory: (ctx) => {
        const ts = createRealToolset({ businessId: ctx.businessId, messageChannel: 'surge', ports, capabilities: ctx.capabilities, factsSnapshot: ctx.facts });
        return { handler: ts.handler, dispose: ts.dispose };
      },
    });
    phone.emit({ event: 'start', start: { callSid: 'CA123', streamSid: 'MZ1', customParameters: { streamToken: token } } });
    await vi.waitFor(() => expect(openaiSocketFactory).toHaveBeenCalled());
    model.open();
    model.emit({ type: 'session.updated' });
    model.emit({ type: 'response.done', response: { output: [
      { type: 'function_call', name: 'propose_order', arguments: '{}', call_id: 'fc_1' },
      { type: 'function_call', name: 'read_catalog', arguments: '{"query":"x","businessId":"biz_barber_01"}', call_id: 'fc_2' },
    ] } });
    await vi.waitFor(() => expect(model.ofType('conversation.item.create')).toHaveLength(2));
    const reasons = model.ofType('conversation.item.create').map((m) => JSON.parse(String((m as { item: Json }).item.output)).reason);
    expect(reasons).toEqual(['VALIDATION_FAILED', 'VALIDATION_FAILED']);
    expect(createOrderProposal).not.toHaveBeenCalled();
    phone.emit({ event: 'stop' });
    await relay.done;
  });
});


async function realRelay(options: { proposalHangs?: boolean; quoteHangs?: boolean; consent?: boolean } = {}) {
  const cart: Cart = { lines: [{ catalogItemId: SQ.itemMargherita, variationId: SQ.varMargheritaLarge, quantity: 1, modifierIds: [] }] };
  const quote: Quote = { quoteId: 'qte_relay_01', cartHash: await cartHash(cart), subtotalMinor: 100, taxMinor: 0, totalMinor: 100, currency: 'USD', lines: [{ variationId: SQ.varMargheritaLarge, name: 'Pizza', quantity: 1, unitPriceMinor: 100, modifiers: [], lineTotalMinor: 100 }], quotedAt: FIXTURE_NOW, expiresAt: new Date(Date.parse(FIXTURE_NOW) + 300000).toISOString() };
  let releaseQuote: () => void = () => undefined; let releaseProposal: () => void = () => undefined;
  const createOrderProposal = vi.fn<RealToolsetPorts['proposals']['createOrderProposal']>(async () => {
    if (options.proposalHangs) return new Promise((resolve) => { releaseProposal = () => resolve({ ok: true, orderId: 'ord_relay_01', approvalId: 'apv_relay_01' }); });
    return { ok: true, orderId: 'ord_relay_01', approvalId: 'apv_relay_01' };
  });
  const quotePort = vi.fn<RealToolsetPorts['quotes']['quote']>(async () => {
    if (options.quoteHangs) return new Promise((resolve) => { releaseQuote = () => resolve({ ok: true, quote }); });
    return { ok: true, quote };
  });
  const ports: RealToolsetPorts = {
    catalog: { search: async () => pizzaCatalog }, quotes: { quote: quotePort },
    proposals: { atomicOperations: true, createOrderProposal, createBookingProposal: vi.fn() },
    orderStatus: { read: async () => null }, availability: { freeSlots: async () => [] },
  };
  const tokens = new StreamTokenStore<PinnedCall>();
  const token = tokens.mint({ callId: 'call_relay_01', providerCallId: 'CA123', businessId: pizzaSpecV2.businessId, businessName: '**Pizza** _Shop_', agentId: pizzaSpecV2.id, agentVersionId: 'agv_pizza_01_v2', spec: pizzaSpecV2, facts: PIZZA_SNAPSHOT }) ?? '';
  const phone = new FakeSocket(); const model = new FakeSocket(); const calls = fakeCalls();
  const relay = runPhoneRelay({ phone, tokens, calls, events: fakeEvents(), messageChannel: 'surge', logger: fakeLogger().logger,
    limits: { toolTimeoutMs: 10, pendingWaitMs: 30 }, openaiSocketFactory: () => model,
    toolsetFactory: (ctx) => createRealToolset({ businessId: ctx.businessId, messageChannel: 'surge', ports, capabilities: ctx.capabilities, factsSnapshot: ctx.facts, now: () => new Date(FIXTURE_NOW), toolTimeoutMs: 100 }),
  });
  phone.emit({ event: 'start', start: { callSid: 'CA123', streamSid: 'MZ1', customParameters: { streamToken: token } } });
  await vi.waitFor(() => expect(model.sent.length).toBe(0));
  // Wait for setup to attach the listeners without opening any network connection.
  await new Promise((resolve) => setTimeout(resolve, 0));
  model.open(); model.emit({ type: 'session.updated' });
  let seq = 0;
  const invoke = async (name: string, args: unknown) => {
    const id = `fc_${++seq}`;
    model.emit({ type: 'response.done', response: { status: 'completed', output: [{ type: 'function_call', name, arguments: JSON.stringify(args), call_id: id }] } });
    await vi.waitFor(() => expect(model.ofType('conversation.item.create').some((m) => (m.item as Json).call_id === id)).toBe(true));
    const item = model.ofType('conversation.item.create').find((m) => (m.item as Json).call_id === id)?.item as Json;
    return JSON.parse(String(item.output)) as Json;
  };
  const args = { cart, quoteId: quote.quoteId, contact: { name: 'Customer', messageConsent: options.consent ?? false, ...(options.consent ? { messageRecipient: '+15555550123', consentAt: '1999-01-01T00:00:00Z' } : {}) }, fulfillment: { type: 'pickup', pickupAt: '2026-11-14T21:00:00Z' } };
  return { relay, phone, model, calls, invoke, args, cart, createOrderProposal, quotePort, releaseQuote: () => releaseQuote(), releaseProposal: () => releaseProposal() };
}

it('R2: relay timeout cannot create overlapping proposals for one quote and hangup aborts the port', async () => {
  const s = await realRelay({ proposalHangs: true });
  expect((await s.invoke('quote_order', { cart: s.cart })).ok).toBe(true);
  expect((await s.invoke('propose_order', s.args)).reason).toBe('INTEGRATION_UNAVAILABLE');
  expect((await s.invoke('propose_order', s.args)).reason).toBe('INTEGRATION_UNAVAILABLE');
  expect(s.createOrderProposal).toHaveBeenCalledOnce();
  const input = s.createOrderProposal.mock.calls[0]?.[0];
  expect(input?.operationId).toBeTruthy(); expect(input?.signal.aborted).toBe(true);
  s.phone.emit({ event: 'stop' }); await s.relay.done;
  const outputCount = s.model.sent.length; const stages = s.calls.updateStage.mock.calls.length;
  s.releaseProposal(); await new Promise((r) => setTimeout(r, 0));
  expect(s.model.sent).toHaveLength(outputCount); expect(s.calls.updateStage).toHaveBeenCalledTimes(stages);
});

it('R2: a quote completing after the shorter relay deadline never enters the real quote store', async () => {
  const s = await realRelay({ quoteHangs: true });
  expect((await s.invoke('quote_order', { cart: s.cart })).reason).toBe('INTEGRATION_UNAVAILABLE');
  expect(s.quotePort.mock.calls[0]?.[0].signal.aborted).toBe(true);
  s.releaseQuote(); await new Promise((r) => setTimeout(r, 0));
  expect((await s.invoke('propose_order', s.args)).reason).toBe('NOT_FOUND');
  expect(s.createOrderProposal).not.toHaveBeenCalled();
  s.phone.emit({ event: 'stop' }); await s.relay.done;
});

it.each([false, true])('R3, R7: real proposal consent claim %s stays QR-only through the pending goodbye', async (consent) => {
  const s = await realRelay({ consent });
  await s.invoke('quote_order', { cart: s.cart });
  expect((await s.invoke('propose_order', s.args)).ok).toBe(true);
  expect(s.createOrderProposal.mock.calls[0]?.[0]).toMatchObject({ contact: { name: 'Customer', messageConsent: false }, messageChannel: 'qr_only' });
  expect(s.createOrderProposal.mock.calls[0]?.[0].contact.messageRecipient).toBeUndefined();
  await vi.waitFor(() => expect(JSON.stringify(s.model.sent)).toContain('still pending'));
  const status = s.model.ofType('conversation.item.create').filter((m) => (m.item as Json).role === 'system');
  expect(JSON.stringify(status)).toContain('counter');
  expect(JSON.stringify(status)).not.toMatch(/number ending|will come by|text message|\*|_Shop_/);
  s.phone.emit({ event: 'stop' }); await s.relay.done;
});
