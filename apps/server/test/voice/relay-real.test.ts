// The relay wired to the real toolset (fake ports only): what the model sends is validated for real.
import { describe, expect, it, vi } from 'vitest';
import { pizzaCatalog, pizzaSpecV2 } from '@abos/contracts/fixtures';
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
