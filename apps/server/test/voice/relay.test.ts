import { describe, expect, it, vi } from 'vitest';
import { CAPABILITIES, TOOL_CAPABILITY, ToolNameSchema, isToolEffect, type AgentSpec } from '@abos/contracts';
import { barberSpecV1, pizzaSpecV2 } from '@abos/contracts/fixtures';
import { StreamTokenStore } from '../../src/voice/logic';
import { buildSessionUpdate, checkSessionCapabilities, nextStage, runPhoneRelay } from '../../src/voice/relay';
import type { PinnedCall } from '../../src/voice/types';
import { FakeSocket, fakeCalls, fakeHandler, fakeLogger, specWith, ulaw, type Json } from './helpers';

const SECRET = 'sk-test-SECRETKEY1234567890';

function pinnedFor(spec: AgentSpec): PinnedCall {
  return { callId: 'call_test_01', providerCallId: 'CA123', businessId: spec.businessId, businessName: 'Demo Pizza Co.', agentId: spec.id, agentVersionId: 'agv_pizza_01_v2', spec };
}

function setup(opts: { spec?: AgentSpec; result?: unknown; status?: 'IN_PROGRESS' | 'COMPLETED' } = {}) {
  const spec = opts.spec ?? pizzaSpecV2;
  const tokens = new StreamTokenStore<PinnedCall>();
  const token = tokens.mint(pinnedFor(spec));
  const phone = new FakeSocket();
  const sockets: FakeSocket[] = [];
  const openaiSocketFactory = vi.fn(() => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  });
  const calls = fakeCalls(opts.status ?? 'IN_PROGRESS');
  const { handler, call } = fakeHandler(opts.result);
  const toolsetFactory = vi.fn(() => handler);
  const { logger, lines } = fakeLogger();
  const relay = runPhoneRelay({ phone, tokens, calls, toolsetFactory, openaiSocketFactory, messageChannel: 'surge', logger, redactSecrets: [SECRET] });
  const start = (t: string = token, callSid = 'CA123') =>
    phone.emit({ event: 'start', start: { callSid, streamSid: 'MZ1', customParameters: { streamToken: t } } });
  const openai = () => {
    const s = sockets[0];
    if (s === undefined) throw new Error('no model socket');
    return s;
  };
  /** Starts the stream and brings the model session to ready. */
  const connect = async () => {
    start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    openai().open();
    openai().emit({ type: 'session.updated' });
  };
  return { relay, phone, calls, call, toolsetFactory, openaiSocketFactory, openai, start, connect, lines, token };
}

describe('voice relay: session start', () => {
  it('opens the session with the proven shape and only the allowed tools, then speaks first', async () => {
    const s = setup();
    await s.connect();
    const update = s.openai().ofType('session.update')[0] as { session: Json & { tools: { name: string }[]; audio: Json } };
    expect(update.session).toMatchObject({
      type: 'realtime', output_modalities: ['audio'], tool_choice: 'auto',
      audio: { input: { format: { type: 'audio/pcmu' }, turn_detection: { type: 'server_vad' } }, output: { format: { type: 'audio/pcmu' }, voice: 'alloy' } },
    });
    expect(update.session.tools.map((t) => t.name).sort()).toEqual(['get_order_status', 'propose_order', 'quote_order', 'read_business_facts', 'read_catalog']);
    expect(String(update.session.instructions)).toContain('You are speaking with an AI assistant');
    expect(s.openai().ofType('response.create')).toHaveLength(1);
    expect(s.toolsetFactory).toHaveBeenCalledWith({ businessId: 'biz_pizza_01', agentVersionId: 'agv_pizza_01_v2', callId: 'call_test_01', capabilities: pizzaSpecV2.capabilities });
  });

  it('a bad token starts no session and ends no call', async () => {
    const s = setup();
    s.start('not-a-token');
    const out = await s.relay.done;
    expect(out.endReason).toBeNull();
    expect(s.openaiSocketFactory).not.toHaveBeenCalled();
    expect(s.calls.endCall).not.toHaveBeenCalled();
    expect(s.phone.isOpen).toBe(false);
  });

  it('a token for another CallSid is refused', async () => {
    const s = setup();
    s.start(s.token, 'CA999');
    expect((await s.relay.done).why).toContain('call_mismatch');
    expect(s.openaiSocketFactory).not.toHaveBeenCalled();
  });

  it('a call that is not in progress starts no session', async () => {
    const s = setup({ status: 'COMPLETED' });
    s.start();
    await s.relay.done;
    expect(s.openaiSocketFactory).not.toHaveBeenCalled();
    expect(s.calls.endCall).not.toHaveBeenCalled();
  });

  it('a spec with a write capability outside its bundle is refused and the call fails', async () => {
    const s = setup({ spec: specWith(pizzaSpecV2, { capabilities: [...pizzaSpecV2.capabilities, 'catalog.price.update'] }) });
    s.start();
    const out = await s.relay.done;
    expect(out.endReason).toBe('failed');
    expect(s.openaiSocketFactory).not.toHaveBeenCalled();
    expect(s.calls.endCall).toHaveBeenCalledWith('call_test_01', 'failed');
  });

  it('drops caller audio until the session is ready, then relays it', async () => {
    const s = setup();
    s.start();
    await vi.waitFor(() => expect(s.openaiSocketFactory).toHaveBeenCalled());
    s.openai().open();
    s.phone.emit({ event: 'media', media: { payload: ulaw(20) } });
    expect(s.openai().ofType('input_audio_buffer.append')).toHaveLength(0);
    s.openai().emit({ type: 'session.updated' });
    s.phone.emit({ event: 'media', media: { payload: ulaw(20) } });
    expect(s.openai().ofType('input_audio_buffer.append')).toEqual([{ type: 'input_audio_buffer.append', audio: ulaw(20) }]);
  });
});

describe('voice relay: tool calls', () => {
  it('routes a function call to the toolset and returns the result with the same call id', async () => {
    const s = setup({ result: { ok: true, items: [] } });
    await s.connect();
    s.openai().emit({ type: 'response.done', response: { status: 'completed', output: [{ type: 'function_call', name: 'read_catalog', arguments: '{"query":"pepperoni"}', call_id: 'fc_abc' }] } });
    await vi.waitFor(() => expect(s.openai().ofType('conversation.item.create')).toHaveLength(1));
    const item = (s.openai().ofType('conversation.item.create')[0] as { item: Json }).item;
    expect(item).toMatchObject({ type: 'function_call_output', call_id: 'fc_abc' });
    expect(JSON.parse(String(item.output))).toEqual({ ok: true, items: [] });
    expect(s.call).toHaveBeenCalledWith('read_catalog', { query: 'pepperoni' }, { businessId: 'biz_pizza_01', agentVersionId: 'agv_pizza_01_v2', callId: 'call_test_01', correlationId: 'call_test_01' });
    await vi.waitFor(() => expect(s.openai().ofType('response.create')).toHaveLength(2));
    expect(s.calls.updateStage).toHaveBeenCalledWith('call_test_01', 'COLLECTING');
  });

  it('an unknown or disallowed tool returns a failure and the call goes on', async () => {
    const s = setup({ spec: barberSpecV1 });
    await s.connect();
    s.openai().emit({ type: 'response.done', response: { output: [
      { type: 'function_call', name: 'update_price', arguments: '{}', call_id: 'fc_1' },
      { type: 'function_call', name: 'quote_order', arguments: '{}', call_id: 'fc_2' },
      { type: 'function_call', name: 'read_business_facts', arguments: '{not json', call_id: 'fc_3' },
    ] } });
    await vi.waitFor(() => expect(s.openai().ofType('conversation.item.create')).toHaveLength(3));
    const outputs = s.openai().ofType('conversation.item.create').map((m) => {
      const item = (m as { item: Json }).item;
      return [item.call_id, JSON.parse(String(item.output)).reason];
    });
    expect(outputs).toEqual([['fc_1', 'CAPABILITY_NOT_ALLOWED'], ['fc_2', 'CAPABILITY_NOT_ALLOWED'], ['fc_3', 'VALIDATION_FAILED']]);
    expect(s.call).not.toHaveBeenCalled();
    expect(s.phone.isOpen).toBe(true);
  });

  it('a toolset that throws becomes INTEGRATION_UNAVAILABLE', async () => {
    const s = setup();
    s.call.mockRejectedValueOnce(new Error('boom'));
    await s.connect();
    s.openai().emit({ type: 'response.done', response: { output: [{ type: 'function_call', name: 'read_catalog', arguments: '{}', call_id: 'fc_9' }] } });
    await vi.waitFor(() => expect(s.openai().ofType('conversation.item.create')).toHaveLength(1));
    const item = (s.openai().ofType('conversation.item.create')[0] as { item: Json }).item;
    expect(JSON.parse(String(item.output))).toMatchObject({ ok: false, reason: 'INTEGRATION_UNAVAILABLE' });
  });

  it('a successful proposal moves the call to CUSTOMER_CONFIRMED', async () => {
    const s = setup({ result: { ok: true, proposalId: 'ord_1', approvalId: 'apv_1', missingFields: [] } });
    await s.connect();
    s.openai().emit({ type: 'response.done', response: { output: [{ type: 'function_call', name: 'propose_order', arguments: '{}', call_id: 'fc_p' }] } });
    await vi.waitFor(() => expect(s.calls.updateStage).toHaveBeenCalledWith('call_test_01', 'CUSTOMER_CONFIRMED'));
  });
});

describe('voice relay: audio and barge-in', () => {
  it('relays model audio with a mark after each chunk', async () => {
    const s = setup();
    await s.connect();
    s.openai().emit({ type: 'response.output_audio.delta', item_id: 'item_1', delta: ulaw(20) });
    expect(s.phone.sent).toEqual([
      { event: 'media', streamSid: 'MZ1', media: { payload: ulaw(20) } },
      { event: 'mark', streamSid: 'MZ1', mark: { name: 'p1' } },
    ]);
  });

  it('on caller speech clears Twilio and truncates at the played offset', async () => {
    const s = setup();
    await s.connect();
    for (let i = 0; i < 3; i++) s.openai().emit({ type: 'response.output_audio.delta', item_id: 'item_1', delta: ulaw(20) });
    s.phone.emit({ event: 'mark', mark: { name: 'p2' } });
    s.openai().emit({ type: 'input_audio_buffer.speech_started' });
    expect(s.phone.ofType('clear')).toEqual([{ event: 'clear', streamSid: 'MZ1' }]);
    expect(s.openai().ofType('conversation.item.truncate')).toEqual([{ type: 'conversation.item.truncate', item_id: 'item_1', content_index: 0, audio_end_ms: 40 }]);
  });

  it('caller speech with nothing pending sends no clear', async () => {
    const s = setup();
    await s.connect();
    s.openai().emit({ type: 'input_audio_buffer.speech_started' });
    expect(s.phone.ofType('clear')).toHaveLength(0);
    expect(s.openai().ofType('conversation.item.truncate')).toHaveLength(0);
  });
});

describe('voice relay: ending', () => {
  it('Twilio stop ends the call as completed and closes the model socket', async () => {
    const s = setup();
    await s.connect();
    s.phone.emit({ event: 'stop' });
    expect(await s.relay.done).toMatchObject({ endReason: 'completed' });
    expect(s.calls.endCall).toHaveBeenCalledWith('call_test_01', 'completed');
    expect(s.calls.endCall).toHaveBeenCalledTimes(1);
    expect(s.openai().isOpen).toBe(false);
  });

  it('the Twilio socket closing ends the call as dropped', async () => {
    const s = setup();
    await s.connect();
    s.phone.remoteClose();
    expect(await s.relay.done).toMatchObject({ endReason: 'dropped' });
  });

  it('the model socket closing ends the call as failed', async () => {
    const s = setup();
    await s.connect();
    s.openai().remoteClose(1011);
    expect(await s.relay.done).toMatchObject({ endReason: 'failed' });
    expect(s.phone.isOpen).toBe(false);
  });

  it('redacts the API key from a logged provider error and logs no audio or number', async () => {
    const s = setup();
    await s.connect();
    s.openai().emit({ type: 'error', error: { message: `Incorrect API key provided: ${SECRET}.` } });
    s.openai().emit({ type: 'response.output_audio.delta', item_id: 'item_1', delta: ulaw(20) });
    s.phone.emit({ event: 'stop' });
    await s.relay.done;
    const logged = JSON.stringify(s.lines);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(ulaw(20));
    expect(logged).toContain('connectToFirstAudioMs');
  });
});

describe('voice relay: capability rules', () => {
  it('both fixture specs pass, with their tools', () => {
    expect(checkSessionCapabilities(pizzaSpecV2)).toEqual({ ok: true, tools: ['read_catalog', 'read_business_facts', 'quote_order', 'propose_order', 'get_order_status'] });
    expect(checkSessionCapabilities(barberSpecV1)).toEqual({ ok: true, tools: ['read_business_facts', 'read_calendar_availability', 'propose_booking'] });
  });

  it('refuses a write outside the bundle, a bundle write without its propose, and an unknown id', () => {
    expect(checkSessionCapabilities({ capabilities: ['catalog.read', 'catalog.price.update'] })).toMatchObject({ ok: false, notAllowed: ['catalog.price.update'] });
    expect(checkSessionCapabilities({ capabilities: ['catalog.read', 'message.checkout.send'] })).toMatchObject({ ok: false, notAllowed: ['message.checkout.send'] });
    expect(checkSessionCapabilities({ capabilities: ['catalog.read', 'tool.create'] as never })).toMatchObject({ ok: false, unknown: ['tool.create'] });
  });

  it('the session config never holds a tool outside the allowed set', () => {
    const everything = ToolNameSchema.options;
    for (const tools of [[], ['read_catalog'] as const, everything]) {
      const ev = buildSessionUpdate({ model: 'm', voice: 'alloy', instructions: 'x', tools });
      const names = ev.session.tools.map((t) => t.name);
      expect(names.every((n) => (tools as readonly string[]).includes(n))).toBe(true);
      for (const n of names) expect(isToolEffect(CAPABILITIES[TOOL_CAPABILITY[n]].effect)).toBe(true);
    }
  });

  it('stage rules follow the flows', () => {
    expect(nextStage('restaurant_order_taker', 'CALL_STARTED', 'read_catalog', { ok: true })).toBe('COLLECTING');
    expect(nextStage('restaurant_order_taker', 'COLLECTING', 'quote_order', { ok: false, reason: 'ITEM_UNAVAILABLE' })).toBe('UNAVAILABLE');
    expect(nextStage('restaurant_order_taker', 'UNAVAILABLE', 'quote_order', { ok: true })).toBe('VALIDATING');
    expect(nextStage('appointment_booker', 'INQUIRY', 'read_business_facts', { ok: true })).toBe('INQUIRY');
    expect(nextStage('appointment_booker', 'INQUIRY', 'read_calendar_availability', { ok: true })).toBe('SLOT_SEARCH');
    expect(nextStage('appointment_booker', 'SLOT_SEARCH', 'propose_booking', { ok: false, reason: 'SLOT_CONFLICT' })).toBe('PROPOSAL');
    expect(nextStage('appointment_booker', 'PROPOSAL', 'propose_booking', { ok: true, proposalId: 'bkg_1' })).toBe('CUSTOMER_CONFIRMED');
    expect(nextStage('restaurant_order_taker', 'CUSTOMER_CONFIRMED', 'quote_order', { ok: true })).toBe('CUSTOMER_CONFIRMED');
  });
});
