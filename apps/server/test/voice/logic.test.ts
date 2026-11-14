import { describe, expect, it } from 'vitest';
import { PlaybackTracker, StreamTokenStore, TimingTracker, buildConnectTwiml, buildSayTwiml, last4, redact, streamUrl, ulawBase64DurationMs } from '../../src/voice/logic';
import { ulaw } from './helpers';

const pinned = { providerCallId: 'CA123', callId: 'call_test_01' };

describe('voice logic: TwiML', () => {
  it('connects the stream to /ws/phone with the token as a custom parameter', () => {
    const xml = buildConnectTwiml('https://demo.example.test/', 'tok&"<');
    expect(streamUrl('https://demo.example.test')).toBe('wss://demo.example.test/ws/phone');
    expect(xml).toContain('<Connect>');
    expect(xml).toContain('<Stream url="wss://demo.example.test/ws/phone">');
    expect(xml).toContain('<Parameter name="streamToken" value="tok&amp;&quot;&lt;" />');
  });

  it('a spoken refusal says the message and hangs up', () => {
    const xml = buildSayTwiml('Not today & goodbye.');
    expect(xml).toContain('<Say>Not today &amp; goodbye.</Say>');
    expect(xml).toContain('<Hangup />');
  });
});

describe('voice logic: stream token', () => {
  it('is single use and tied to its call', () => {
    const store = new StreamTokenStore<typeof pinned>(60_000);
    const t = store.mint(pinned, 0);
    expect(store.consume(t, 'CA999', 10)).toEqual({ ok: false, reason: 'call_mismatch' });
    const t2 = store.mint(pinned, 0);
    expect(store.consume(t2, 'CA123', 10)).toEqual({ ok: true, value: pinned });
    expect(store.consume(t2, 'CA123', 10)).toEqual({ ok: false, reason: 'unknown' });
    expect(store.consume(undefined, 'CA123', 10)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('expires', () => {
    const store = new StreamTokenStore<typeof pinned>(60_000);
    const t = store.mint(pinned, 0);
    expect(store.consume(t, 'CA123', 60_001)).toEqual({ ok: false, reason: 'expired' });
    expect(store.size).toBe(0);
  });

  it('mints distinct tokens', () => {
    const store = new StreamTokenStore<typeof pinned>();
    expect(store.mint(pinned)).not.toBe(store.mint(pinned));
  });
});

describe('voice logic: playback and barge-in offset', () => {
  it('truncates at the last mark Twilio echoed, not at what was sent', () => {
    const p = new PlaybackTracker();
    const m1 = p.onAudioSent('item_1', ulawBase64DurationMs(ulaw(20)));
    p.onAudioSent('item_1', 20);
    p.onAudioSent('item_1', 20);
    expect(p.onMark(m1)).toBe(true);
    expect(p.interrupt()).toEqual({ itemId: 'item_1', audioEndMs: 20 });
    // Marks for dropped audio echo after clear and are ignored.
    expect(p.onMark('p2')).toBe(false);
    expect(p.interrupt()).toBeNull();
  });

  it('nothing to truncate once everything played', () => {
    const p = new PlaybackTracker();
    const m = p.onAudioSent('item_1', 40);
    p.onMark(m);
    expect(p.hasPendingAudio).toBe(false);
    expect(p.interrupt()).toBeNull();
  });
});

describe('voice logic: timing, redaction, last4', () => {
  it('measures connect to first audio and each turn', () => {
    const t = new TimingTracker();
    t.onConnect(1000);
    expect(t.onAudioSent(1800)).toEqual({ kind: 'first_audio', ms: 800 });
    t.onSpeechStopped(5000);
    expect(t.onAudioSent(5600)).toEqual({ kind: 'turn', turn: 1, ms: 600 });
    expect(t.onAudioSent(5700)).toBeNull();
    expect(t.summary()).toMatchObject({ connectToFirstAudioMs: 800, turns: [600], p50: 600, max: 600 });
  });

  it('redacts the API key and key-shaped strings', () => {
    const key = 'sk-proj-ABCDEFGHIJKLMNOP';
    expect(redact(`bad key ${key}`, [key])).toBe('bad key [redacted]');
    expect(redact('Incorrect API key provided: sk-pr****MNOP. Check it.')).not.toContain('MNOP');
  });

  it('keeps only the last four digits', () => {
    expect(last4('+15555550123')).toBe('0123');
    expect(last4(undefined)).toBeUndefined();
    expect(last4('12')).toBeUndefined();
  });
});
