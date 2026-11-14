// Interruptions and background noise in the relay (NOTES.md), with the FakeSocket harness, fake time and
// the provider event sequences read from OpenAI's docs on 2026-11-14: speech_started, speech_stopped,
// then input_audio_buffer.committed after the silence; with create_response and interrupt_response off,
// nothing answers or cancels unless the relay asks.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pizzaSpecV2 } from '@abos/contracts/fixtures';
import type { ToolHandler } from '@abos/contracts';
import { parseEnv } from '../../src/env';
import { DEFAULT_VOICE_TUNING, voiceTuningFromEnv, type VoiceTuning } from '../../src/voice/constants';
import { StreamTokenStore } from '../../src/voice/logic';
import { runPhoneRelay } from '../../src/voice/relay';
import type { PinnedCall, VoiceToolset } from '../../src/voice/types';
import { FakeSocket, PIZZA_SNAPSHOT, fakeCalls, fakeEvents, fakeLogger, ulaw, type Json } from './helpers';

const SILENCE = DEFAULT_VOICE_TUNING.vadSilenceMs;

afterEach(() => {
  vi.useRealTimers();
});

async function setup(o: { tuning?: Partial<VoiceTuning>; tool?: () => Promise<unknown> } = {}) {
  vi.useFakeTimers();
  const tokens = new StreamTokenStore<PinnedCall>();
  const token = tokens.mint({ callId: 'call_int_01', providerCallId: 'CA9', businessId: pizzaSpecV2.businessId, businessName: 'Demo Pizza Co.', agentId: pizzaSpecV2.id, agentVersionId: 'agv_int', spec: pizzaSpecV2, facts: PIZZA_SNAPSHOT }) ?? '';
  const phone = new FakeSocket();
  const model = new FakeSocket();
  const { logger, lines } = fakeLogger();
  const call = vi.fn(o.tool ?? (async () => ({ ok: true, items: [] })));
  const toolset: VoiceToolset = { handler: { toolset: 'real', call } as unknown as ToolHandler, dispose: vi.fn() };
  const relay = runPhoneRelay({ phone, tokens, calls: fakeCalls(), events: fakeEvents(), toolsetFactory: () => toolset, openaiSocketFactory: () => model, messageChannel: 'qr_only', logger, tuning: o.tuning });
  phone.emit({ event: 'start', start: { callSid: 'CA9', streamSid: 'MZ9', customParameters: { streamToken: token } } });
  await vi.advanceTimersByTimeAsync(10);
  model.open();
  model.emit({ type: 'session.updated' });

  let resp = 0;
  /** The model generates one response: response.created, `ms` of audio in 100 ms chunks, then response.done unless `open`. */
  const agentSays = (ms: number, opts: { open?: boolean; output?: Json[] } = {}) => {
    const id = `resp_${++resp}`;
    model.emit({ type: 'response.created', response: { id } });
    for (let t = 0; t < ms; t += 100) model.emit({ type: 'response.output_audio.delta', response_id: id, item_id: `item_${id}`, delta: ulaw(100) });
    if (!opts.open) model.emit({ type: 'response.done', response: { id, status: 'completed', output: opts.output ?? [] } });
    return id;
  };
  /** Twilio played `ms` more of the agent's audio (one 100 ms mark each). */
  const play = async (ms: number) => {
    for (let t = 0; t < ms; t += 100) {
      const name = phone.pendingMarks.shift();
      if (name !== undefined) phone.emit({ event: 'mark', mark: { name } });
      await vi.advanceTimersByTimeAsync(100);
    }
  };
  /** Twilio played everything sent so far. */
  const playAll = () => phone.ackMarks();
  /**
   * Caller sound of `ms`, then the VAD silence, then the commit, as server VAD sends them. `playing`:
   * Twilio keeps playing the agent's audio meanwhile (in 100 ms steps, so 150 ms takes 200 ms).
   */
  const callerSound = async (itemId: string, ms: number, playing = false) => {
    const pass = (t: number) => (playing ? play(t) : vi.advanceTimersByTimeAsync(t));
    model.emit({ type: 'input_audio_buffer.speech_started', item_id: itemId, audio_start_ms: 0 });
    await pass(ms);
    model.emit({ type: 'input_audio_buffer.speech_stopped', item_id: itemId, audio_end_ms: ms });
    await pass(SILENCE);
    model.emit({ type: 'input_audio_buffer.committed', item_id: itemId, previous_item_id: null });
  };
  /** The greeting plays in full, so later speech is not under the greeting rule. */
  const finishGreeting = async () => { agentSays(500); playAll(); await vi.advanceTimersByTimeAsync(0); };
  const creates = () => model.ofType('response.create').length;
  const bargeInLines = () => lines.filter((l) => l.msg === 'voice: barge-in');
  const deletes = () => model.ofType('conversation.item.delete').map((m) => m.item_id);
  const systemLines = () => model.ofType('conversation.item.create').map((m) => m.item as Json).filter((i) => i.role === 'system').map((i) => String(((i.content as Json[])[0] as Json).text));
  const hangUp = async () => { phone.emit({ event: 'stop' }); await vi.advanceTimersByTimeAsync(10); await relay.done; };
  return { relay, phone, model, lines, call, agentSays, play, playAll, callerSound, finishGreeting, creates, bargeInLines, deletes, systemLines, hangUp };
}

describe('voice relay: noise does not stop the agent', () => {
  it('a 150 ms noise during agent speech does not stop playback and leaves no orphan turn or response', async () => {
    const s = await setup();
    await s.finishGreeting();
    const before = s.creates();
    s.agentSays(4000);
    await s.callerSound('item_noise', 150, true);
    expect(s.phone.ofType('clear')).toHaveLength(0);
    expect(s.model.ofType('conversation.item.truncate')).toHaveLength(0);
    expect(s.model.ofType('response.cancel')).toHaveLength(0);
    // Held while the agent talks, then left out of the conversation once the agent has finished.
    await s.play(4000);
    expect(s.deletes()).toEqual(['item_noise']);
    expect(s.creates()).toBe(before);
    expect(s.bargeInLines()).toHaveLength(0);
    await s.hangUp();
  });

  it('back-to-back noises: none stops the agent, each is left out, and nothing is answered', async () => {
    const s = await setup();
    await s.finishGreeting();
    const before = s.creates();
    s.agentSays(5000);
    await s.callerSound('item_n1', 150, true);
    await s.callerSound('item_n2', 200, true);
    await s.callerSound('item_n3', 100, true);
    expect(s.phone.ofType('clear')).toHaveLength(0);
    await s.play(5000);
    expect(s.deletes().sort()).toEqual(['item_n1', 'item_n2', 'item_n3']);
    expect(s.creates()).toBe(before);
    await s.hangUp();
  });

  it('a refused delete is logged and never ends the call', async () => {
    const s = await setup();
    await s.finishGreeting();
    s.agentSays(3000);
    await s.callerSound('item_noise', 150, true);
    await s.play(3000);
    const del = s.model.ofType('conversation.item.delete')[0]!;
    for (let i = 0; i < 4; i++) s.model.emit({ type: 'error', error: { type: 'invalid_request_error', code: 'item_not_found', event_id: del.event_id } });
    expect(s.model.isOpen).toBe(true);
    expect(s.lines.some((l) => l.msg === 'voice: interruption step refused')).toBe(true);
    await s.hangUp();
  });
});

describe('voice relay: a real interruption', () => {
  it('a 500 ms utterance during agent speech stops it once: one clear, one truncate, one cancel, one barge-in line, then one reply', async () => {
    const s = await setup();
    await s.finishGreeting();
    const before = s.creates();
    const id = s.agentSays(3000, { open: true });
    await s.play(300);
    s.model.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item_real' });
    await vi.advanceTimersByTimeAsync(349);
    expect(s.phone.ofType('clear')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.phone.ofType('clear')).toEqual([{ event: 'clear', streamSid: 'MZ9' }]);
    expect(s.model.ofType('conversation.item.truncate')).toEqual([{ type: 'conversation.item.truncate', item_id: `item_${id}`, content_index: 0, audio_end_ms: 300 }]);
    expect(s.model.ofType('response.cancel')).toHaveLength(1);
    s.model.emit({ type: 'response.done', response: { id, status: 'cancelled', output: [] } });
    await vi.advanceTimersByTimeAsync(150);
    s.model.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_real' });
    await vi.advanceTimersByTimeAsync(SILENCE);
    s.model.emit({ type: 'input_audio_buffer.committed', item_id: 'item_real' });
    expect(s.phone.ofType('clear')).toHaveLength(1);
    expect(s.model.ofType('conversation.item.truncate')).toHaveLength(1);
    expect(s.bargeInLines()).toHaveLength(1);
    expect(s.creates()).toBe(before + 1);
    expect(s.deletes()).toEqual([]);
    await s.hangUp();
  });

  it('a turn committed before the cancelled response ends is answered after it ends, never on top of it', async () => {
    const s = await setup();
    await s.finishGreeting();
    const before = s.creates();
    const id = s.agentSays(3000, { open: true });
    await s.callerSound('item_real', 500);
    expect(s.creates()).toBe(before);
    s.model.emit({ type: 'response.done', response: { id, status: 'cancelled', output: [] } });
    expect(s.creates()).toBe(before + 1);
    await s.hangUp();
  });

  it('with a tail set, the clear waits that long after the gate confirms', async () => {
    const s = await setup({ tuning: { bargeInTailMs: 100 } });
    await s.finishGreeting();
    s.agentSays(3000);
    s.model.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item_real' });
    await vi.advanceTimersByTimeAsync(350);
    expect(s.phone.ofType('clear')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(s.phone.ofType('clear')).toHaveLength(1);
    await s.hangUp();
  });

  it('a barge-in during a tool call stops the audio, waits for the tool, and asks for one reply after its result', async () => {
    let finish: (v: unknown) => void = () => undefined;
    const s = await setup({ tool: () => new Promise((r) => { finish = r; }) });
    await s.finishGreeting();
    const before = s.creates();
    // "Got it." and a function call; the tool is still running while "Got it." plays.
    s.agentSays(800, { output: [{ type: 'function_call', name: 'read_catalog', arguments: '{"query":"pizza"}', call_id: 'fc_1' }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.call).toHaveBeenCalledTimes(1);
    await s.callerSound('item_real', 500);
    expect(s.phone.ofType('clear')).toHaveLength(1);
    // Nothing was being generated, so nothing is cancelled; the turn waits for the tool.
    expect(s.model.ofType('response.cancel')).toHaveLength(0);
    expect(s.creates()).toBe(before);
    finish({ ok: true, items: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.model.ofType('conversation.item.create').some((m) => (m.item as Json).type === 'function_call_output')).toBe(true);
    expect(s.creates()).toBe(before + 1);
    await s.hangUp();
  });
});

describe('voice relay: a short real answer', () => {
  it('a quick yes just after the agent finished is answered', async () => {
    const s = await setup();
    await s.finishGreeting();
    const before = s.creates();
    s.agentSays(2000);
    s.playAll(); await vi.advanceTimersByTimeAsync(0);
    await s.callerSound('item_yes', 250);
    expect(s.creates()).toBe(before + 1);
    expect(s.deletes()).toEqual([]);
    await s.hangUp();
  });

  it('a quick yes over the last moment of the question is answered once the question has played', async () => {
    const s = await setup();
    await s.finishGreeting();
    const before = s.creates();
    s.agentSays(2000);
    await s.play(1700);
    // 300 ms of the question left when the caller says "yes" (250 ms, 300 ms in 100 ms steps).
    await s.callerSound('item_yes', 250, true);
    expect(s.phone.ofType('clear')).toHaveLength(0);
    expect(s.creates()).toBe(before + 1);
    expect(s.deletes()).toEqual([]);
    await s.hangUp();
  });

  it('a quick yes that commits while the question still plays is held, then answered when it ends within the grace', async () => {
    const s = await setup();
    await s.finishGreeting();
    const before = s.creates();
    s.agentSays(3000);
    await s.play(1900);
    // The yes ends at 2200 ms and commits at 2800 ms, with 200 ms of the question still to play.
    await s.callerSound('item_yes', 250, true);
    expect(s.creates()).toBe(before);
    await s.play(200);
    expect(s.creates()).toBe(before + 1);
    expect(s.deletes()).toEqual([]);
    await s.hangUp();
  });
});

describe('voice relay: the opening disclosure', () => {
  it('a short sound during the greeting does not cut the disclosure, and a 500 ms hello is not an interruption there', async () => {
    const s = await setup();
    const before = s.creates();
    s.agentSays(5000);
    await s.play(800);
    await s.callerSound('item_hello', 500, true);
    expect(s.phone.ofType('clear')).toHaveLength(0);
    expect(s.model.ofType('conversation.item.truncate')).toHaveLength(0);
    await s.play(5000);
    expect(s.deletes()).toEqual(['item_hello']);
    expect(s.creates()).toBe(before);
    await s.hangUp();
  });

  it('a sustained interruption during the greeting stops it only after 700 ms, and the model is told to give the disclosure first if it was cut', async () => {
    const s = await setup();
    s.agentSays(5000);
    await s.play(800);
    s.model.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item_talk' });
    await s.play(600);
    expect(s.phone.ofType('clear')).toHaveLength(0);
    await s.play(100);
    expect(s.phone.ofType('clear')).toHaveLength(1);
    expect(s.systemLines().at(-1)).toContain('start your next reply with "You are speaking with an AI assistant."');
    await s.hangUp();
  });

  it('after the greeting played, the ordinary 350 ms minimum applies and no disclosure line is added', async () => {
    const s = await setup();
    await s.finishGreeting();
    s.agentSays(3000);
    s.model.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item_talk' });
    await vi.advanceTimersByTimeAsync(350);
    expect(s.phone.ofType('clear')).toHaveLength(1);
    expect(s.systemLines()).toEqual([]);
    await s.hangUp();
  });
});

describe('voice relay: settings come from env overrides', () => {
  const ENV = { VOICE_VAD_THRESHOLD: '0.72', VOICE_VAD_PREFIX_PADDING_MS: '250', VOICE_VAD_SILENCE_MS: '800', VOICE_NOISE_REDUCTION: 'far_field', VOICE_BARGE_IN_MIN_MS: '120', VOICE_GREETING_BARGE_IN_MIN_MS: '900', VOICE_SHORT_REPLY_GRACE_MS: '1500', VOICE_BARGE_IN_TAIL_MS: '80' };

  it('env.ts validates the VOICE_* overrides and the relay sends them', async () => {
    const tuning = voiceTuningFromEnv(parseEnv(ENV));
    expect(tuning).toEqual({ vadThreshold: 0.72, vadPrefixPaddingMs: 250, vadSilenceMs: 800, noiseReduction: 'far_field', bargeInMinMs: 120, greetingBargeInMinMs: 900, shortReplyGraceMs: 1500, bargeInTailMs: 80 });
    const s = await setup({ tuning });
    expect((s.model.ofType('session.update')[0]!.session as Json).audio).toMatchObject({ input: {
      turn_detection: { type: 'server_vad', threshold: 0.72, prefix_padding_ms: 250, silence_duration_ms: 800, create_response: false, interrupt_response: false },
      noise_reduction: { type: 'far_field' },
    } });
    // The gate uses the overridden minimum (120 ms) and tail (80 ms).
    await s.finishGreeting();
    s.agentSays(3000);
    s.model.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item_x' });
    await vi.advanceTimersByTimeAsync(199);
    expect(s.phone.ofType('clear')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.phone.ofType('clear')).toHaveLength(1);
    await s.hangUp();
  });

  it('VOICE_NOISE_REDUCTION=off sends null; unset overrides keep the defaults', async () => {
    expect(voiceTuningFromEnv(parseEnv({}))).toEqual({});
    const s = await setup({ tuning: voiceTuningFromEnv(parseEnv({ VOICE_NOISE_REDUCTION: 'off' })) });
    expect((s.model.ofType('session.update')[0]!.session as Json).audio).toMatchObject({ input: { noise_reduction: null, turn_detection: { threshold: 0.6, prefix_padding_ms: 300, silence_duration_ms: 600 } } });
    await s.hangUp();
  });

  it.each([
    ['VOICE_VAD_THRESHOLD', '1.5'], ['VOICE_VAD_SILENCE_MS', '50'], ['VOICE_NOISE_REDUCTION', 'loud'], ['VOICE_BARGE_IN_TAIL_MS', '200'], ['VOICE_BARGE_IN_MIN_MS', 'soon'],
  ])('refuses %s=%s at startup', (name, value) => {
    expect(() => parseEnv({ [name]: value })).toThrow(name);
  });
});
