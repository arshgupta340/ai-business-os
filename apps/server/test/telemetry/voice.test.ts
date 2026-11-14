// first_audio from the phone path (B-30, issue #37): the tap in telemetry/voice.ts, alone and
// against the real relay, so a change to the relay's dispose-then-log order fails here.
import { describe, expect, it, vi } from 'vitest';
import { pizzaSpecV2 } from '@abos/contracts/fixtures';
import { StreamTokenStore } from '../../src/voice/logic';
import { runPhoneRelay } from '../../src/voice/relay';
import type { PinnedCall } from '../../src/voice/types';
import { createTelemetry } from '../../src/telemetry/index';
import { CALL_ENDED_LOG_MESSAGE, createFirstAudioTap } from '../../src/telemetry/voice';
import { FakeSocket, PIZZA_SNAPSHOT, fakeCalls, fakeEvents, fakeLogger, fakeToolset, ulaw } from '../voice/helpers';

const BIZ = pizzaSpecV2.businessId;
const quiet = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const firstAudio = (t: ReturnType<typeof createTelemetry>, businessId = BIZ) => t.summary({ businessId }).metrics.find((m) => m.name === 'first_audio');

describe('first audio tap', () => {
  it('records the call-end value for the call whose toolset was just disposed, and passes every line on', () => {
    const t = createTelemetry({ now: () => 1_000 });
    const tap = createFirstAudioTap(t);
    const base = quiet();
    const log = tap.logger(base);
    log.info({ connectToFirstAudioMs: 999 }, 'voice: timing');
    tap.callEnding({ callId: 'call_a', businessId: BIZ });
    log.info({ connectToFirstAudioMs: 420, callId: '[token]' }, CALL_ENDED_LOG_MESSAGE);
    expect(firstAudio(t)).toEqual({ name: 'first_audio', p50Ms: 420, p95Ms: 420, count: 1 });
    expect(base.info).toHaveBeenCalledTimes(2);
    log.warn({}, 'w'); log.error({}, 'e');
    expect(base.warn).toHaveBeenCalledOnce();
    expect(base.error).toHaveBeenCalledOnce();
  });

  it('records nothing without a disposed call, for a null value, or twice for one disposal', () => {
    const t = createTelemetry({ now: () => 1_000 });
    const tap = createFirstAudioTap(t);
    const log = tap.logger(quiet());
    log.info({ connectToFirstAudioMs: 300 }, CALL_ENDED_LOG_MESSAGE);
    tap.callEnding({ callId: 'call_b', businessId: BIZ });
    log.info({ connectToFirstAudioMs: null }, CALL_ENDED_LOG_MESSAGE);
    log.info({ connectToFirstAudioMs: 300 }, CALL_ENDED_LOG_MESSAGE);
    tap.callEnding({ callId: 'call_c', businessId: BIZ });
    log.info({ connectToFirstAudioMs: -1 }, CALL_ENDED_LOG_MESSAGE);
    expect(firstAudio(t)).toBeUndefined();
  });

  it('keeps businesses apart', () => {
    const t = createTelemetry({ now: () => 1_000 });
    const tap = createFirstAudioTap(t);
    const log = tap.logger(quiet());
    tap.callEnding({ callId: 'call_d', businessId: 'biz_barber_01' });
    log.info({ connectToFirstAudioMs: 250 }, CALL_ENDED_LOG_MESSAGE);
    expect(firstAudio(t)).toBeUndefined();
    expect(firstAudio(t, 'biz_barber_01')?.count).toBe(1);
  });

  it('a logger that throws inside telemetry never breaks the line', () => {
    const tap = createFirstAudioTap({ record: () => { throw new Error('boom'); }, time: () => () => {} });
    const base = quiet();
    tap.callEnding({ callId: 'call_e', businessId: BIZ });
    expect(() => tap.logger(base).info({ connectToFirstAudioMs: 10 }, CALL_ENDED_LOG_MESSAGE)).not.toThrow();
    expect(base.info).toHaveBeenCalledOnce();
  });

  it('against the real relay: one first_audio sample per phone call, with the call ID', async () => {
    let clock = 10_000;
    const t = createTelemetry({ now: () => clock });
    const recorded: { callId?: string; ms: number }[] = [];
    const port = { record: (m: Parameters<typeof t.record>[0], i: Parameters<typeof t.record>[1]) => { if (m === 'first_audio') recorded.push({ ...(i.correlationId ? { callId: i.correlationId } : {}), ms: i.ms }); return t.record(m, i); }, time: t.time };
    const tap = createFirstAudioTap(port);
    const pinned: PinnedCall = { callId: 'call_test_01', providerCallId: 'CA123', businessId: BIZ, businessName: 'Demo Pizza Co.', agentId: pizzaSpecV2.id, agentVersionId: 'agv_pizza_01_v2', spec: pizzaSpecV2, facts: PIZZA_SNAPSHOT };
    const tokens = new StreamTokenStore<PinnedCall>();
    const token = tokens.mint(pinned, Date.now()) ?? '';
    const phone = new FakeSocket();
    let model: FakeSocket | undefined;
    const { toolset } = fakeToolset(undefined);
    // The same wrapping compose/index.ts does for the voice toolset.
    const toolsetFactory = vi.fn((ctx: { callId: string; businessId: string }) => ({ ...toolset, dispose: () => { tap.callEnding({ callId: ctx.callId, businessId: ctx.businessId }); toolset.dispose(); } }));
    const { logger, lines } = fakeLogger();
    const relay = runPhoneRelay({ phone, tokens, calls: fakeCalls('IN_PROGRESS'), events: fakeEvents(), toolsetFactory: toolsetFactory as never,
      openaiSocketFactory: () => (model = new FakeSocket()), messageChannel: 'surge', logger: tap.logger(logger), now: () => clock });
    phone.emit({ event: 'start', start: { callSid: 'CA123', streamSid: 'MZ1', customParameters: { streamToken: token } } });
    await vi.waitFor(() => expect(model).toBeDefined());
    model!.open();
    model!.emit({ type: 'session.updated' });
    clock += 640;
    model!.emit({ type: 'response.output_audio.delta', item_id: 'item_1', delta: ulaw(20) });
    phone.emit({ event: 'stop' });
    await relay.done;
    expect(JSON.stringify(lines)).toContain('connectToFirstAudioMs');
    expect(recorded).toEqual([{ callId: 'call_test_01', ms: 640 }]);
    expect(firstAudio(t)).toEqual({ name: 'first_audio', p50Ms: 640, p95Ms: 640, count: 1 });
  });
});
