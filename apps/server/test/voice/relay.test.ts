import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAPABILITIES, TOOL_CAPABILITY, ToolNameSchema, isToolEffect, type AgentSpec } from '@abos/contracts';
import { barberSpecV1, pizzaSpecV2 } from '@abos/contracts/fixtures';
import { StreamTokenStore } from '../../src/voice/logic';
import { adaptWs, buildSessionUpdate, checkSessionCapabilities, nextStage, runPhoneRelay } from '../../src/voice/relay';
import type { CallDecision, PinnedCall, RelayLimits } from '../../src/voice/types';
import { FakeSocket, PIZZA_SNAPSHOT, fakeCalls, fakeEvents, fakeLogger, fakeToolset, specWith, ulaw, type Json } from './helpers';

const SECRET = 'sk-test-SECRETKEY1234567890';

function pinnedFor(spec: AgentSpec): PinnedCall {
  return { callId: 'call_test_01', providerCallId: 'CA123', businessId: spec.businessId, businessName: 'Demo Pizza Co.', agentId: spec.id, agentVersionId: 'agv_pizza_01_v2', spec, facts: PIZZA_SNAPSHOT };
}

type SetupOpts = { spec?: AgentSpec; result?: unknown; status?: 'IN_PROGRESS' | 'COMPLETED'; limits?: Partial<RelayLimits>; withDecisions?: boolean; credential?: string };

function setup(opts: SetupOpts = {}) {
  const spec = opts.spec ?? pizzaSpecV2;
  const tokens = new StreamTokenStore<PinnedCall>();
  const token = tokens.mint(pinnedFor(spec), Date.now(), opts.credential) ?? '';
  const phone = new FakeSocket();
  const sockets: FakeSocket[] = [];
  const openaiSocketFactory = vi.fn(() => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  });
  const calls = fakeCalls(opts.status ?? 'IN_PROGRESS');
  const events = fakeEvents();
  const { toolset, call, dispose } = fakeToolset(opts.result);
  const toolsetFactory = vi.fn(() => toolset);
  const { logger, lines } = fakeLogger();
  let decide: ((d: CallDecision) => void) | undefined;
  const unsubscribe = vi.fn();
  const decisions = opts.withDecisions
    ? { subscribe: vi.fn((_callId: string, fn: (d: CallDecision) => void) => ((decide = fn), unsubscribe)) }
    : undefined;
  const relay = runPhoneRelay({ phone, tokens, calls, events, decisions, toolsetFactory, openaiSocketFactory, messageChannel: 'surge', logger, redactSecrets: [SECRET], limits: opts.limits });
  const start = (t: string = token, callSid: string | undefined = 'CA123', streamSid: string | undefined = 'MZ1') =>
    phone.emit({ event: 'start', start: { callSid, streamSid, customParameters: { streamToken: t } } });
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
  const fnCall = (name: string, args: string, callId: string) => ({ type: 'response.done', response: { status: 'completed', output: [{ type: 'function_call', name, arguments: args, call_id: callId }] } });
  const outputs = () => openai().ofType('conversation.item.create').map((m) => (m as { item: Json }).item).filter((i) => i.type === 'function_call_output');
  return { relay, phone, calls, events, call, dispose, toolsetFactory, openaiSocketFactory, openai, start, connect, fnCall, outputs, lines, token, tokens, decide: (d: CallDecision) => decide?.(d), unsubscribe };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('voice relay: session start', () => {
  it('opens the session with the proven shape and only the allowed tools, then speaks first', async () => {
    const s = setup();
    await s.connect();
    const update = s.openai().ofType('session.update')[0] as { session: Json & { tools: { name: string }[] } };
    expect(update.session).toMatchObject({
      type: 'realtime', output_modalities: ['audio'], tool_choice: 'auto',
      audio: { input: { format: { type: 'audio/pcmu' }, turn_detection: { type: 'server_vad' } }, output: { format: { type: 'audio/pcmu' }, voice: 'alloy' } },
    });
    expect(update.session.tools.map((t) => t.name).sort()).toEqual(['get_order_status', 'propose_order', 'quote_order', 'read_business_facts', 'read_catalog']);
    expect(String(update.session.instructions)).toContain('You are speaking with an AI assistant');
    expect(s.openai().ofType('response.create')).toHaveLength(1);
    expect(s.toolsetFactory).toHaveBeenCalledWith({ businessId: 'biz_pizza_01', agentVersionId: 'agv_pizza_01_v2', callId: 'call_test_01', capabilities: pizzaSpecV2.capabilities, facts: PIZZA_SNAPSHOT });
    s.phone.emit({ event: 'stop' });
    await s.relay.done;
  });

  it('a bad token starts no session and ends no call', async () => {
    const s = setup();
    s.start('not-a-token');
    expect((await s.relay.done).endReason).toBeNull();
    expect(s.openaiSocketFactory).not.toHaveBeenCalled();
    expect(s.calls.endCall).not.toHaveBeenCalled();
    expect(s.phone.isOpen).toBe(false);
  });

  it('S8: a start without a stream ID or CallSid starts no session', async () => {
    for (const start of [{ callSid: 'CA123' }, { streamSid: 'MZ1' }]) {
      const s = setup();
      s.phone.emit({ event: 'start', start: { ...start, customParameters: { streamToken: s.token } } });
      expect((await s.relay.done).why).toContain('malformed');
      expect(s.openaiSocketFactory).not.toHaveBeenCalled();
    }
  });

  it('B1: a consumed token cannot open a second session on another connection', async () => {
    const s = setup();
    await s.connect();
    const phone2 = new FakeSocket();
    const factory2 = vi.fn(() => new FakeSocket());
    const r2 = runPhoneRelay({ phone: phone2, tokens: s.tokens, calls: fakeCalls(), events: fakeEvents(), toolsetFactory: () => fakeToolset().toolset, openaiSocketFactory: factory2, messageChannel: 'surge', logger: fakeLogger().logger });
    phone2.emit({ event: 'start', start: { callSid: 'CA123', streamSid: 'MZ2', customParameters: { streamToken: s.token } } });
    expect((await r2.done).endReason).toBeNull();
    expect(factory2).not.toHaveBeenCalled();
    s.phone.emit({ event: 'stop' });
    await s.relay.done;
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
    expect((await s.relay.done).endReason).toBe('failed');
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
    s.phone.emit({ event: 'stop' });
    await s.relay.done;
  });
});

describe('voice relay: tool calls', () => {
  it('routes a function call to the toolset and returns the result with the same call id', async () => {
    const s = setup({ result: { ok: true, items: [] } });
    await s.connect();
    s.openai().emit(s.fnCall('read_catalog', '{"query":"pepperoni"}', 'fc_abc'));
    await vi.waitFor(() => expect(s.outputs()).toHaveLength(1));
    expect(s.outputs()[0]).toMatchObject({ type: 'function_call_output', call_id: 'fc_abc' });
    expect(JSON.parse(String(s.outputs()[0]?.output))).toEqual({ ok: true, items: [] });
    expect(s.call).toHaveBeenCalledWith('read_catalog', { query: 'pepperoni' }, { businessId: 'biz_pizza_01', agentVersionId: 'agv_pizza_01_v2', callId: 'call_test_01', correlationId: 'call_test_01' }, { signal: expect.any(AbortSignal), timeoutMs: CAPABILITIES['catalog.read'].timeoutMs });
    await vi.waitFor(() => expect(s.openai().ofType('response.create')).toHaveLength(2));
    await vi.waitFor(() => expect(s.calls.updateStage).toHaveBeenCalledWith('call_test_01', 'COLLECTING'));
    s.phone.emit({ event: 'stop' });
    await s.relay.done;
  });

  it('issue #95 item 7: a function call on a response that did not complete is not run', async () => {
    const s = setup({ result: { ok: true, items: [] } });
    await s.connect();
    for (const status of ['cancelled', 'incomplete', 'failed']) {
      s.openai().emit({ type: 'response.done', response: { status, output: [{ type: 'function_call', name: 'read_catalog', arguments: '{}', call_id: `fc_${status}` }] } });
    }
    s.openai().emit(s.fnCall('read_catalog', '{"query":"pepperoni"}', 'fc_ok'));
    await vi.waitFor(() => expect(s.outputs()).toHaveLength(1));
    expect(s.outputs()[0]).toMatchObject({ call_id: 'fc_ok' });
    expect(s.call).toHaveBeenCalledTimes(1);
    s.phone.emit({ event: 'stop' });
    await s.relay.done;
  });

  it('an unknown or disallowed tool returns a failure and the call goes on', async () => {
    const s = setup({ spec: barberSpecV1 });
    await s.connect();
    s.openai().emit({ type: 'response.done', response: { output: [
      { type: 'function_call', name: 'update_price', arguments: '{}', call_id: 'fc_1' },
      { type: 'function_call', name: 'quote_order', arguments: '{}', call_id: 'fc_2' },
      { type: 'function_call', name: 'read_business_facts', arguments: '{not json', call_id: 'fc_3' },
    ] } });
    await vi.waitFor(() => expect(s.outputs()).toHaveLength(3));
    expect(s.outputs().map((i) => [i.call_id, JSON.parse(String(i.output)).reason])).toEqual([['fc_1', 'CAPABILITY_NOT_ALLOWED'], ['fc_2', 'CAPABILITY_NOT_ALLOWED'], ['fc_3', 'VALIDATION_FAILED']]);
    expect(s.call).not.toHaveBeenCalled();
    expect(s.phone.isOpen).toBe(true);
    s.phone.emit({ event: 'stop' });
    await s.relay.done;
  });

  it('S13: a refused tool writes guardrail.refused with fixed codes only', async () => {
    const s = setup({ spec: barberSpecV1 });
    await s.connect();
    s.openai().emit(s.fnCall('+15555550123', '{"note":"PRIVATE"}', 'fc_1'));
    s.openai().emit(s.fnCall('quote_order', '{}', 'fc_2'));
    await vi.waitFor(() => expect(s.events.guardrailRefused).toHaveBeenCalledTimes(2));
    expect(s.events.guardrailRefused.mock.calls.map((c) => c[0])).toEqual([
      { businessId: 'biz_barber_01', payload: { callId: 'call_test_01', rule: 'unsupported_request', reasonCode: 'unknown_tool' } },
      { businessId: 'biz_barber_01', payload: { callId: 'call_test_01', rule: 'unsupported_request', reasonCode: 'tool_not_allowed', toolName: 'quote_order' } },
    ]);
    expect(JSON.stringify(s.events.guardrailRefused.mock.calls)).not.toContain('PRIVATE');
    s.phone.emit({ event: 'stop' });
    await s.relay.done;
  });

  it('B3: an unknown tool name is logged only as unknown_tool and its length', async () => {
    const s = setup();
    await s.connect();
    s.openai().emit(s.fnCall('+15555550123', '{}', 'fc_1'));
    await vi.waitFor(() => expect(s.outputs()).toHaveLength(1));
    const logged = JSON.stringify(s.lines);
    expect(logged).not.toContain('5555550123');
    expect(logged).toContain('"tool":"unknown_tool"');
    expect(logged).toContain('"nameLength":12');
    s.phone.emit({ event: 'stop' });
    await s.relay.done;
  });

  it('B3: port exceptions, socket errors and provider errors are logged without their text', async () => {
    const s = setup();
    s.call.mockRejectedValueOnce(new Error('could not message +15555550123: PRIVATE TEXT'));
    await s.connect();
    s.openai().emit(s.fnCall('read_catalog', '{}', 'fc_9'));
    await vi.waitFor(() => expect(s.outputs()).toHaveLength(1));
    expect(JSON.parse(String(s.outputs()[0]?.output))).toMatchObject({ ok: false, reason: 'INTEGRATION_UNAVAILABLE' });
    s.openai().emit({ type: 'error', error: { type: 'invalid_request_error', code: 'bad_value', message: `echo: caller said PRIVATE TEXT; key ${SECRET}; token ${s.token}` } });
    s.phone.fail(new Error(`socket broke for streamToken=${s.token} +15555550123`));
    await s.relay.done;
    const logged = JSON.stringify(s.lines);
    for (const leak of ['PRIVATE TEXT', SECRET, s.token, '5555550123']) expect(logged).not.toContain(leak);
    expect(logged).toContain('invalid_request_error');
  });

  it('S5: a hung tool times out as INTEGRATION_UNAVAILABLE and later calls still run', async () => {
    const s = setup({ limits: { toolTimeoutMs: 50 } });
    s.call.mockImplementationOnce(() => new Promise(() => undefined));
    await s.connect();
    s.openai().emit(s.fnCall('read_catalog', '{}', 'fc_hung'));
    s.openai().emit(s.fnCall('read_catalog', '{}', 'fc_next'));
    await vi.waitFor(() => expect(s.outputs()).toHaveLength(2));
    expect(s.outputs().map((i) => [i.call_id, JSON.parse(String(i.output)).ok])).toEqual([['fc_hung', false], ['fc_next', true]]);
    expect(JSON.parse(String(s.outputs()[0]?.output)).reason).toBe('INTEGRATION_UNAVAILABLE');
    s.phone.emit({ event: 'stop' });
    await s.relay.done;
  });

  it('S5: a fake handler result after hangup writes no stage or function output', async () => {
    let finish: (v: unknown) => void = () => undefined;
    const s = setup({ result: { ok: true, items: [] } });
    s.call.mockImplementationOnce(() => new Promise((r) => (finish = r)));
    await s.connect();
    s.openai().emit(s.fnCall('read_catalog', '{}', 'fc_late'));
    await vi.waitFor(() => expect(s.call).toHaveBeenCalled());
    s.phone.emit({ event: 'stop' });
    await s.relay.done;
    finish({ ok: true, items: [] });
    await new Promise((r) => setTimeout(r, 20));
    expect(s.calls.updateStage).not.toHaveBeenCalled();
    expect(s.outputs()).toHaveLength(0);
    expect(s.dispose).toHaveBeenCalledTimes(1);
  });

  it('S6: responses beyond the queue bound are answered unavailable at once', async () => {
    const s = setup({ limits: { maxPendingResponses: 1, toolTimeoutMs: 10_000 } });
    s.call.mockImplementationOnce(() => new Promise(() => undefined));
    await s.connect();
    s.openai().emit(s.fnCall('read_catalog', '{}', 'fc_1'));
    s.openai().emit(s.fnCall('read_catalog', '{}', 'fc_2'));
    await vi.waitFor(() => expect(s.outputs()).toHaveLength(1));
    expect(s.outputs()[0]).toMatchObject({ call_id: 'fc_2' });
    expect(JSON.parse(String(s.outputs()[0]?.output)).reason).toBe('INTEGRATION_UNAVAILABLE');
    s.phone.emit({ event: 'stop' });
    await s.relay.done;
  });

  it('a successful proposal moves the call to CUSTOMER_CONFIRMED', async () => {
    const s = setup({ result: { ok: true, proposalId: 'ord_1', approvalId: 'apv_1', missingFields: [] } });
    await s.connect();
    s.openai().emit(s.fnCall('propose_order', '{}', 'fc_p'));
    await vi.waitFor(() => expect(s.calls.updateStage).toHaveBeenCalledWith('call_test_01', 'CUSTOMER_CONFIRMED'));
    s.phone.emit({ event: 'stop' });
    await s.relay.done;
  });
});

describe('voice relay: wait and finish (FLOWS 3.1)', () => {
  it('S12: still pending after the wait, the agent says goodbye and the call ends completed', async () => {
    const s = setup({ result: { ok: true, proposalId: 'ord_1', approvalId: 'apv_1', missingFields: [] }, limits: { pendingWaitMs: 100 } });
    await s.connect();
    s.openai().emit(s.fnCall('propose_order', '{}', 'fc_p'));
    await vi.waitFor(() => expect(s.openai().sent.some((m) => JSON.stringify(m).includes('still pending'))).toBe(true));
    const request = s.openai().ofType('response.create').find((m) => m.response !== undefined) as { response: Json };
    s.openai().emit({ type: 'response.created', response: { id: 'resp_goodbye', metadata: request.response.metadata } });
    // Simulated audio and its Twilio acknowledgment, bound to this response.
    s.openai().emit({ type: 'response.output_audio.delta', item_id: 'item_bye', delta: ulaw(20) });
    s.openai().emit({ type: 'response.done', response: { id: 'resp_goodbye', status: 'completed', output: [] } });
    s.phone.emit({ event: 'mark', mark: { name: 'p1' } });
    expect(await s.relay.done).toMatchObject({ endReason: 'completed', why: 'goodbye played' });
    expect(s.calls.endCall).toHaveBeenCalledWith('call_test_01', 'completed');
    expect(s.phone.isOpen).toBe(false);
  });

  it('S12: an owner decision instruction is queued and cancels the pending goodbye', async () => {
    const s = setup({ result: { ok: true, proposalId: 'ord_1', approvalId: 'apv_1', missingFields: [] }, limits: { pendingWaitMs: 150 }, withDecisions: true });
    await s.connect();
    s.openai().emit(s.fnCall('propose_order', '{}', 'fc_p'));
    await vi.waitFor(() => expect(s.calls.updateStage).toHaveBeenCalledWith('call_test_01', 'CUSTOMER_CONFIRMED'));
    s.decide({ kind: 'rejected', proposalId: 'ord_1', approvalId: 'apv_1' });
    expect(JSON.stringify(s.openai().sent)).toContain('not able to take this order');
    await new Promise((r) => setTimeout(r, 250));
    expect(JSON.stringify(s.openai().sent)).not.toContain('still pending');
    s.phone.emit({ event: 'stop' });
    await s.relay.done;
    expect(s.unsubscribe).toHaveBeenCalled();
  });

  it('S12: a failed proposal starts no wait', async () => {
    const s = setup({ result: { ok: true, missingFields: ['contact.messageRecipient.readBack'] }, limits: { pendingWaitMs: 50 } });
    await s.connect();
    s.openai().emit(s.fnCall('propose_order', '{}', 'fc_p'));
    await vi.waitFor(() => expect(s.outputs()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 120));
    expect(JSON.stringify(s.openai().sent)).not.toContain('still pending');
    s.phone.emit({ event: 'stop' });
    await s.relay.done;
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
    s.phone.emit({ event: 'stop' });
    await s.relay.done;
  });

  it('on caller speech clears Twilio and truncates at the played offset', async () => {
    const s = setup();
    await s.connect();
    for (let i = 0; i < 3; i++) s.openai().emit({ type: 'response.output_audio.delta', item_id: 'item_1', delta: ulaw(20) });
    s.phone.emit({ event: 'mark', mark: { name: 'p2' } });
    s.openai().emit({ type: 'input_audio_buffer.speech_started' });
    expect(s.phone.ofType('clear')).toEqual([{ event: 'clear', streamSid: 'MZ1' }]);
    expect(s.openai().ofType('conversation.item.truncate')).toEqual([{ type: 'conversation.item.truncate', item_id: 'item_1', content_index: 0, audio_end_ms: 40 }]);
    s.phone.emit({ event: 'stop' });
    await s.relay.done;
  });

  it('S7: truncates the item being heard and the unheard item behind it, and drops late audio for them', async () => {
    const s = setup();
    await s.connect();
    s.openai().emit({ type: 'response.output_audio.delta', item_id: 'item_A', delta: ulaw(20) });
    s.openai().emit({ type: 'response.output_audio.delta', item_id: 'item_A', delta: ulaw(20) });
    s.openai().emit({ type: 'response.output_audio.delta', item_id: 'item_B', delta: ulaw(20) });
    s.phone.emit({ event: 'mark', mark: { name: 'p1' } });
    s.openai().emit({ type: 'input_audio_buffer.speech_started' });
    expect(s.openai().ofType('conversation.item.truncate')).toEqual([
      { type: 'conversation.item.truncate', item_id: 'item_A', content_index: 0, audio_end_ms: 20 },
      { type: 'conversation.item.truncate', item_id: 'item_B', content_index: 0, audio_end_ms: 0 },
    ]);
    const before = s.phone.sent.length;
    s.openai().emit({ type: 'response.output_audio.delta', item_id: 'item_B', delta: ulaw(20) });
    expect(s.phone.sent.length).toBe(before);
    s.phone.emit({ event: 'stop' });
    await s.relay.done;
  });

  it('caller speech with nothing pending sends no clear', async () => {
    const s = setup();
    await s.connect();
    s.openai().emit({ type: 'input_audio_buffer.speech_started' });
    expect(s.phone.ofType('clear')).toHaveLength(0);
    s.phone.emit({ event: 'stop' });
    await s.relay.done;
  });

  it('S6: phone back-pressure fails the call instead of buffering', async () => {
    const s = setup({ limits: { maxPendingMarks: 3 } });
    await s.connect();
    for (let i = 0; i < 5; i++) s.openai().emit({ type: 'response.output_audio.delta', item_id: 'item_1', delta: ulaw(20) });
    expect(await s.relay.done).toMatchObject({ endReason: 'failed', why: 'phone back-pressure' });
    expect(s.phone.ofType('media')).toHaveLength(3);
    const s2 = setup();
    await s2.connect();
    s2.phone.bufferedAmount = 10 * 1024 * 1024;
    s2.openai().emit({ type: 'response.output_audio.delta', item_id: 'item_1', delta: ulaw(20) });
    expect(await s2.relay.done).toMatchObject({ endReason: 'failed' });
  });
});

describe('voice relay: deadlines and ending (fake time)', () => {
  it('S4: a socket that never sends start is closed', async () => {
    vi.useFakeTimers();
    const s = setup({ limits: { startTimeoutMs: 1000 } });
    await vi.advanceTimersByTimeAsync(1001);
    expect(await s.relay.done).toMatchObject({ endReason: null, why: 'no start message' });
    expect(s.phone.isOpen).toBe(false);
  });

  it('S4: a model session that never becomes ready fails the call', async () => {
    vi.useFakeTimers();
    const s = setup({ limits: { setupTimeoutMs: 1000 } });
    s.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(s.openaiSocketFactory).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await s.relay.done).toMatchObject({ endReason: 'failed' });
    expect(s.calls.endCall).toHaveBeenCalledWith('call_test_01', 'failed');
    expect(s.phone.isOpen).toBe(false);
  });

  it('S4: a model error before ready, with no close, fails the call and closes the phone', async () => {
    const s = setup();
    s.start();
    await vi.waitFor(() => expect(s.openaiSocketFactory).toHaveBeenCalled());
    s.openai().open();
    s.openai().emit({ type: 'error', error: { type: 'invalid_request_error', code: 'invalid_api_key' } });
    expect(await s.relay.done).toMatchObject({ endReason: 'failed' });
    expect(s.phone.isOpen).toBe(false);
  });

  it('S4: no message from Twilio for the idle time ends the call as dropped', async () => {
    vi.useFakeTimers();
    const s = setup({ limits: { idleTimeoutMs: 500 } });
    s.start();
    await vi.advanceTimersByTimeAsync(10);
    s.openai().open();
    s.openai().emit({ type: 'session.updated' });
    await vi.advanceTimersByTimeAsync(501);
    expect(await s.relay.done).toMatchObject({ endReason: 'dropped' });
  });

  it('S4: a call ended elsewhere stops the relay without touching the call row', async () => {
    vi.useFakeTimers();
    const s = setup({ limits: { statusPollMs: 1000 } });
    s.start();
    await vi.advanceTimersByTimeAsync(10);
    s.openai().open();
    s.openai().emit({ type: 'session.updated' });
    s.calls.getStatus.mockResolvedValue('COMPLETED');
    s.phone.emit({ event: 'media', media: { payload: ulaw(20) } });
    await vi.advanceTimersByTimeAsync(1001);
    expect(await s.relay.done).toMatchObject({ endReason: null, why: 'call ended elsewhere' });
    expect(s.calls.endCall).not.toHaveBeenCalled();
  });

  it('S4: a hung endCall still settles the relay', async () => {
    vi.useFakeTimers();
    const s = setup({ limits: { cleanupTimeoutMs: 500 } });
    s.calls.endCall.mockImplementation(() => new Promise(() => undefined));
    s.start();
    await vi.advanceTimersByTimeAsync(10);
    s.phone.emit({ event: 'stop' });
    await vi.advanceTimersByTimeAsync(501);
    expect(await s.relay.done).toMatchObject({ endReason: 'completed' });
  });

  it('S4: a socket that ignores close is terminated after the grace period', async () => {
    vi.useFakeTimers();
    const s = setup({ limits: { closeGraceMs: 200 } });
    s.start();
    await vi.advanceTimersByTimeAsync(10);
    s.openai().close = () => undefined; // a peer that never closes
    s.phone.emit({ event: 'stop' });
    await vi.advanceTimersByTimeAsync(201);
    expect(s.openai().terminated).toBe(true);
  });
});

describe('voice relay: ending', () => {
  it('Twilio stop ends the call as completed and closes the model socket', async () => {
    const s = setup();
    await s.connect();
    s.phone.emit({ event: 'stop' });
    expect(await s.relay.done).toMatchObject({ endReason: 'completed' });
    expect(s.calls.endCall).toHaveBeenCalledTimes(1);
    expect(s.openai().isOpen).toBe(false);
    expect(s.dispose).toHaveBeenCalled();
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

  it('logs no audio and records timing', async () => {
    const s = setup();
    await s.connect();
    s.openai().emit({ type: 'response.output_audio.delta', item_id: 'item_1', delta: ulaw(20) });
    s.phone.emit({ event: 'stop' });
    await s.relay.done;
    const logged = JSON.stringify(s.lines);
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
    for (const tools of [[], ['read_catalog'] as const, ToolNameSchema.options]) {
      const names = buildSessionUpdate({ model: 'm', voice: 'alloy', instructions: 'x', tools }).session.tools.map((t) => t.name);
      expect(names.every((n) => (tools as readonly string[]).includes(n))).toBe(true);
      for (const n of names) expect(isToolEffect(CAPABILITIES[TOOL_CAPABILITY[n]].effect)).toBe(true);
    }
  });

  it('stage rules follow the flows', () => {
    expect(nextStage('restaurant_order_taker', 'CALL_STARTED', 'read_catalog', { ok: true })).toBe('COLLECTING');
    expect(nextStage('restaurant_order_taker', 'COLLECTING', 'quote_order', { ok: false, reason: 'ITEM_UNAVAILABLE' })).toBe('UNAVAILABLE');
    expect(nextStage('restaurant_order_taker', 'UNAVAILABLE', 'quote_order', { ok: true })).toBe('VALIDATING');
    expect(nextStage('restaurant_order_taker', 'VALIDATING', 'propose_order', { ok: true, missingFields: ['x'] })).toBe('VALIDATING');
    expect(nextStage('appointment_booker', 'INQUIRY', 'read_business_facts', { ok: true })).toBe('INQUIRY');
    expect(nextStage('appointment_booker', 'INQUIRY', 'read_calendar_availability', { ok: true })).toBe('SLOT_SEARCH');
    expect(nextStage('appointment_booker', 'SLOT_SEARCH', 'propose_booking', { ok: false, reason: 'SLOT_CONFLICT' })).toBe('PROPOSAL');
    expect(nextStage('appointment_booker', 'PROPOSAL', 'propose_booking', { ok: true, proposalId: 'bkg_1', approvalId: 'apv_1' })).toBe('CUSTOMER_CONFIRMED');
    expect(nextStage('restaurant_order_taker', 'CUSTOMER_CONFIRMED', 'quote_order', { ok: true })).toBe('CUSTOMER_CONFIRMED');
  });
});


describe('rereview regressions', () => {
  it('R1: provider code and socket name fields cannot log credentials or private words', async () => {
    for (const value of ['PRIVATE_CALLER_SPEECH', 'OpaqueStreamCredentialAbcdef12345']) {
      const s = setup();
      await s.connect();
      s.openai().emit({ type: 'error', error: { type: value, code: value } });
      s.phone.fail(Object.assign(new Error(value), { name: value, code: value }));
      await s.relay.done;
      expect(JSON.stringify(s.lines)).not.toContain(value);
    }
  });

  it('R4: the production adapter terminates CLOSING peers at the grace deadline', async () => {
    vi.useFakeTimers();
    class ClosingSocket extends EventEmitter {
      readyState = 1;
      bufferedAmount = 0;
      send(_data: string, cb: (err?: Error) => void) { cb(); }
      close() { this.readyState = 2; }
      terminate = vi.fn(() => { this.readyState = 3; this.emit('close', 1000); });
    }
    const raw = new ClosingSocket();
    const phone = adaptWs(raw as unknown as WebSocket);
    const relay = runPhoneRelay({ phone, tokens: new StreamTokenStore<PinnedCall>(), calls: fakeCalls(), events: fakeEvents(), toolsetFactory: () => fakeToolset().toolset, openaiSocketFactory: () => new FakeSocket(), messageChannel: 'qr_only', logger: fakeLogger().logger, limits: { startTimeoutMs: 10, closeGraceMs: 20 } });
    await vi.advanceTimersByTimeAsync(11);
    await relay.done;
    expect(raw.readyState).toBe(2);
    await vi.advanceTimersByTimeAsync(21);
    expect(raw.terminate).toHaveBeenCalledOnce();
  });

  it('R5: the next encoded caller frame is included in model back-pressure', async () => {
    const s = setup({ limits: { maxBufferedBytes: 512 } });
    await s.connect();
    s.openai().bufferedAmount = 400;
    s.phone.emit({ event: 'media', media: { payload: ulaw(20) } });
    expect(s.openai().ofType('input_audio_buffer.append')).toHaveLength(0);
    expect(s.phone.isOpen).toBe(false);
    expect((await s.relay.done).endReason).toBe('failed');
  });

  it('R7: pending QR proposals never promise messaging or a recipient', async () => {
    vi.useFakeTimers();
    const s = setup({ result: { ok: true, proposalId: 'ord_test_01', approvalId: 'apv_test_01' }, limits: { pendingWaitMs: 50 } });
    s.start(); await vi.advanceTimersByTimeAsync(1);
    s.openai().open(); s.openai().emit({ type: 'session.updated' });
    s.openai().emit(s.fnCall('propose_order', '{"contact":{"messageConsent":false}}', 'fc_qr'));
    await vi.advanceTimersByTimeAsync(60);
    const text = JSON.stringify(s.openai().ofType('conversation.item.create'));
    expect(text).toContain('counter');
    expect(text).not.toMatch(/will come by|number ending|by text message/);
    s.phone.emit({ event: 'stop' }); await s.relay.done;
  });

  it('R8: a decision after the pending deadline cancels all old goodbye work', async () => {
    vi.useFakeTimers();
    const s = setup({ withDecisions: true, result: { ok: true, proposalId: 'ord_test_01', approvalId: 'apv_test_01' }, limits: { pendingWaitMs: 50, goodbyeMaxMs: 100 } });
    s.start(); await vi.advanceTimersByTimeAsync(1);
    s.openai().open(); s.openai().emit({ type: 'session.updated' });
    s.openai().emit(s.fnCall('propose_order', '{}', 'fc_pending'));
    await vi.advanceTimersByTimeAsync(60);
    s.decide({ kind: 'approved', messageSent: true, proposalId: 'ord_test_01', approvalId: 'apv_test_01' });
    s.openai().emit({ type: 'response.done', response: { id: 'unrelated', status: 'completed', output: [] } });
    await vi.advanceTimersByTimeAsync(150);
    expect(s.phone.isOpen).toBe(true);
    s.phone.emit({ event: 'stop' }); await s.relay.done;
  });

  it('R10: one fatal error after readiness closes both sockets despite caller media', async () => {
    const s = setup(); await s.connect();
    s.openai().emit({ type: 'error', error: { type: 'invalid_request_error', code: 'invalid_api_key' } });
    s.phone.emit({ event: 'media', media: { payload: ulaw(20) } });
    expect(s.phone.isOpen).toBe(false);
    expect(s.openai().isOpen).toBe(false);
    expect((await s.relay.done).endReason).toBe('failed');
  });
});


it('R9: a trusted scoped finish waits for exactly its response and playback, then disposes', async () => {
  const phone = new FakeSocket(); const model = new FakeSocket();
  const tokens = new StreamTokenStore<PinnedCall>(); const token = tokens.mint(pinnedFor(pizzaSpecV2)) ?? '';
  const calls = fakeCalls(); const tools = fakeToolset(); const unsubscribe = vi.fn();
  let finish: ((event: { callId: string; agentVersionId: string; responseId: string }) => void) | undefined;
  const finishes = { subscribe: vi.fn((_callId: string, listener: NonNullable<typeof finish>) => { finish = listener; return unsubscribe; }) };
  const relay = runPhoneRelay({ phone, tokens, calls, events: fakeEvents(), toolsetFactory: () => tools.toolset, openaiSocketFactory: () => model, logger: fakeLogger().logger, messageChannel: 'qr_only', finishes });
  phone.emit({ event: 'start', start: { callSid: 'CA123', streamSid: 'MZ1', customParameters: { streamToken: token } } });
  await vi.waitFor(() => expect(finishes.subscribe).toHaveBeenCalled());
  model.open(); model.emit({ type: 'session.updated' });
  finish?.({ callId: 'other_call', agentVersionId: 'agv_pizza_01_v2', responseId: 'bye' });
  model.emit({ type: 'response.done', response: { id: 'bye', status: 'completed', output: [] } });
  expect(phone.isOpen).toBe(true);
  finish?.({ callId: 'call_test_01', agentVersionId: 'agv_pizza_01_v2', responseId: 'bye2' });
  model.emit({ type: 'response.output_audio.delta', item_id: 'bye_item', delta: ulaw(20) });
  model.emit({ type: 'response.done', response: { id: 'unrelated', status: 'completed', output: [] } });
  expect(phone.isOpen).toBe(true);
  model.emit({ type: 'response.done', response: { id: 'bye2', status: 'completed', output: [] } });
  expect(phone.isOpen).toBe(true);
  phone.emit({ event: 'mark', mark: { name: 'p1' } });
  expect((await relay.done).why).toBe('goodbye played');
  expect(phone.isOpen).toBe(false); expect(model.isOpen).toBe(false);
  expect(unsubscribe).toHaveBeenCalledOnce(); expect(tools.dispose).toHaveBeenCalledOnce();
});


it('R1: even an allowlisted code is redacted when it is the accepted stream credential', async () => {
  const s = setup({ credential: 'invalid_api_key' }); await s.connect();
  s.openai().emit({ type: 'error', error: { type: 'invalid_request_error', code: s.token } });
  await s.relay.done;
  expect(JSON.stringify(s.lines)).not.toContain(s.token);
});

it.each([40, 60])('R8: a correlated decision at %s ms invalidates goodbye while unrelated decisions do not', async (at) => {
  vi.useFakeTimers();
  const s = setup({ withDecisions: true, result: { ok: true, proposalId: 'ord_1', approvalId: 'apv_1' }, limits: { pendingWaitMs: 50, goodbyeMaxMs: 100 } });
  s.start(); await vi.advanceTimersByTimeAsync(1);
  s.openai().open(); s.openai().emit({ type: 'session.updated' });
  s.openai().emit(s.fnCall('propose_order', '{}', 'fc_p'));
  await vi.advanceTimersByTimeAsync(at);
  const goodbye = s.openai().ofType('response.create').find((m) => m.response !== undefined) as { response?: Json } | undefined;
  if (goodbye?.response) s.openai().emit({ type: 'response.created', response: { id: 'pending_bye', metadata: goodbye.response.metadata } });
  s.decide({ kind: 'rejected', proposalId: 'wrong', approvalId: 'apv_other' });
  expect(JSON.stringify(s.openai().sent)).not.toContain('not able to take this order');
  s.decide({ kind: 'rejected', proposalId: 'ord_1', approvalId: 'apv_1' });
  s.openai().emit({ type: 'response.done', response: { id: 'pending_bye', status: 'cancelled', output: [] } });
  s.openai().emit({ type: 'response.done', response: { id: 'pending_bye', status: 'completed', output: [] } });
  await vi.advanceTimersByTimeAsync(150);
  expect(s.phone.isOpen).toBe(true);
  s.phone.emit({ event: 'stop' }); await s.relay.done;
  expect(vi.getTimerCount()).toBe(0);
});


it('R6: acknowledged audio with completed generations stays bounded through a long call', async () => {
  const s = setup(); await s.connect();
  for (let i = 0; i < 2000; i++) {
    s.openai().emit({ type: 'response.output_audio.delta', item_id: `item_${i}`, delta: ulaw(1) });
    s.openai().emit({ type: 'response.output_item.done', item: { id: `item_${i}` } });
    s.phone.emit({ event: 'mark', mark: { name: `p${i + 1}` } });
  }
  expect(s.phone.isOpen).toBe(true);
  expect(s.phone.ofType('media')).toHaveLength(2000);
  s.phone.emit({ event: 'stop' }); await s.relay.done;
});

it('R6: missing generation-end events cannot grow item metadata beyond the relay bound', async () => {
  const s = setup(); await s.connect();
  for (let i = 0; i < 130; i++) {
    s.openai().emit({ type: 'response.output_audio.delta', item_id: `item_${i}`, delta: ulaw(1) });
    s.phone.emit({ event: 'mark', mark: { name: `p${i + 1}` } });
  }
  expect(s.phone.ofType('media')).toHaveLength(128);
  expect((await s.relay.done).endReason).toBe('failed');
});

it('R10: only enumerated recoverable errors are tolerated, with a finite retry budget', async () => {
  const s = setup(); await s.connect();
  s.openai().emit({ type: 'error', error: { type: 'invalid_request_error', code: 'response_cancel_not_active' } });
  expect(s.phone.isOpen).toBe(true);
  s.openai().emit({ type: 'error', error: { type: 'invalid_request_error', code: 'response_cancel_not_active' } });
  expect(s.phone.isOpen).toBe(true);
  s.openai().emit({ type: 'error', error: { type: 'invalid_request_error', code: 'response_cancel_not_active' } });
  expect((await s.relay.done).why).toBe('repeated model errors');
});


it('R4: an adapted model socket in CLOSING is also terminated at the configured grace', async () => {
  vi.useFakeTimers();
  class ClosingModel extends EventEmitter {
    readyState = 1; bufferedAmount = 0;
    send(_data: string, cb: (error?: Error) => void) { cb(); }
    close() { this.readyState = 2; }
    terminate = vi.fn(() => { this.readyState = 3; this.emit('close', 1000); });
  }
  const raw = new ClosingModel(); const phone = new FakeSocket();
  const tokens = new StreamTokenStore<PinnedCall>(); const token = tokens.mint(pinnedFor(pizzaSpecV2)) ?? '';
  const relay = runPhoneRelay({ phone, tokens, calls: fakeCalls(), events: fakeEvents(), toolsetFactory: () => fakeToolset().toolset, openaiSocketFactory: () => adaptWs(raw as unknown as WebSocket), logger: fakeLogger().logger, messageChannel: 'qr_only', limits: { closeGraceMs: 20 } });
  phone.emit({ event: 'start', start: { callSid: 'CA123', streamSid: 'MZ1', customParameters: { streamToken: token } } });
  await vi.advanceTimersByTimeAsync(1);
  phone.emit({ event: 'stop' }); await relay.done;
  expect(raw.readyState).toBe(2);
  await vi.advanceTimersByTimeAsync(21);
  expect(raw.terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('R9: a trusted ordinary finish with no audio or proposal closes both peers immediately', async () => {
  vi.useFakeTimers();
  const phone = new FakeSocket(); const model = new FakeSocket(); const tools = fakeToolset();
  const tokens = new StreamTokenStore<PinnedCall>(); const token = tokens.mint(pinnedFor(pizzaSpecV2)) ?? '';
  let finish: ((event: { callId: string; agentVersionId: string; responseId: string }) => void) | undefined;
  const unsubscribe = vi.fn();
  const relay = runPhoneRelay({ phone, tokens, calls: fakeCalls(), events: fakeEvents(), toolsetFactory: () => tools.toolset, openaiSocketFactory: () => model, logger: fakeLogger().logger, messageChannel: 'qr_only', finishes: { subscribe: (_id, listener) => { finish = listener; return unsubscribe; } } });
  phone.emit({ event: 'start', start: { callSid: 'CA123', streamSid: 'MZ1', customParameters: { streamToken: token } } });
  await vi.advanceTimersByTimeAsync(1);
  model.open(); model.emit({ type: 'session.updated' });
  finish?.({ callId: 'call_test_01', agentVersionId: 'wrong_version', responseId: 'bye' });
  model.emit({ type: 'response.done', response: { id: 'bye', status: 'completed', output: [] } });
  expect(phone.isOpen).toBe(true);
  finish?.({ callId: 'call_test_01', agentVersionId: 'agv_pizza_01_v2', responseId: 'bye' });
  model.emit({ type: 'response.done', response: { id: 'bye', status: 'completed', output: [] } });
  expect((await relay.done).why).toBe('goodbye played');
  expect(phone.isOpen).toBe(false); expect(model.isOpen).toBe(false);
  expect(unsubscribe).toHaveBeenCalledOnce(); expect(tools.dispose).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
