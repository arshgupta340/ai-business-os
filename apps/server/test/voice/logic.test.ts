import { describe, expect, it } from 'vitest';
import {
  PlaybackTracker,
  StreamTokenStore,
  TimingTracker,
  buildConnectTwiml,
  buildSayTwiml,
  errorInfo,
  last4,
  redact,
  safeLogger,
  streamUrl,
  ulawBase64DurationMs,
} from '../../src/voice/logic';
import { fakeLogger, ulaw } from './helpers';

const pinned = { providerCallId: 'CA123', callId: 'call_test_01' };

describe('voice logic: TwiML', () => {
  it('connects the stream to /ws/phone with the token as a custom parameter', () => {
    const xml = buildConnectTwiml('https://demo.example.test/', 'tok&"<');
    expect(streamUrl('https://demo.example.test')).toBe('wss://demo.example.test/ws/phone');
    expect(xml).toContain('<Stream url="wss://demo.example.test/ws/phone">');
    expect(xml).toContain('<Parameter name="streamToken" value="tok&amp;&quot;&lt;" />');
  });

  it('a spoken refusal says the message and hangs up', () => {
    const xml = buildSayTwiml('Not today & goodbye.');
    expect(xml).toContain('<Say>Not today &amp; goodbye.</Say>');
    expect(xml).toContain('<Hangup />');
  });
});

describe('voice logic: stream credential', () => {
  it('B1: one credential per CallSid; a repeat mint returns the same pending token', () => {
    const store = new StreamTokenStore<typeof pinned>(60_000);
    const t = store.mint(pinned, 0);
    expect(store.mint(pinned, 10)).toBe(t);
    expect(store.lookup('CA123', 10)).toEqual({ kind: 'pending', token: t });
  });

  it('B1: a consumed, expired or ended credential is refused and never reissued', () => {
    const store = new StreamTokenStore<typeof pinned>(60_000);
    const t = store.mint(pinned, 0) ?? '';
    expect(store.consume(t, 'CA123', 'MZ1', 10)).toEqual({ ok: true, value: pinned });
    expect(store.consume(t, 'CA123', 'MZ1', 10)).toEqual({ ok: false, reason: 'unknown' });
    expect(store.lookup('CA123', 20)).toEqual({ kind: 'refused', state: 'claimed' });
    expect(store.mint(pinned, 20)).toBeNull();
    const other = { providerCallId: 'CA456', callId: 'call_test_02' };
    store.mint(other, 0);
    expect(store.lookup('CA456', 60_000)).toEqual({ kind: 'refused', state: 'expired' });
    store.end('CA456');
    expect(store.mint(other, 60_001)).toBeNull();
  });

  it('S8: a start without CallSid or stream ID is refused and burns the token', () => {
    const store = new StreamTokenStore<typeof pinned>(60_000);
    const t = store.mint(pinned, 0) ?? '';
    expect(store.consume(t, undefined, 'MZ1', 10)).toEqual({ ok: false, reason: 'malformed' });
    expect(store.consume(t, 'CA123', 'MZ1', 10)).toEqual({ ok: false, reason: 'unknown' });
    const store2 = new StreamTokenStore<typeof pinned>(60_000);
    const t2 = store2.mint(pinned, 0) ?? '';
    expect(store2.consume(t2, 'CA123', '', 10)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('S8: a token for another CallSid is refused', () => {
    const store = new StreamTokenStore<typeof pinned>(60_000);
    const t = store.mint(pinned, 0) ?? '';
    expect(store.consume(t, 'CA999', 'MZ1', 10)).toEqual({ ok: false, reason: 'call_mismatch' });
  });

  it('S8: a token at its exact expiry instant is refused', () => {
    const store = new StreamTokenStore<typeof pinned>(60_000);
    const t = store.mint(pinned, 0) ?? '';
    expect(store.consume(t, 'CA123', 'MZ1', 60_000)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('voice logic: playback and barge-in offsets', () => {
  it('truncates at the last mark Twilio echoed, not at what was sent', () => {
    const p = new PlaybackTracker();
    const m1 = p.onAudioSent('item_1', ulawBase64DurationMs(ulaw(20)));
    p.onAudioSent('item_1', 20);
    p.onAudioSent('item_1', 20);
    expect(p.onMark(m1)).toBe(true);
    expect(p.interrupt()).toEqual({ heard: { itemId: 'item_1', audioEndMs: 20 }, unheard: [] });
    // Marks for dropped audio echo after clear and are ignored.
    expect(p.onMark('p2')).toBe(false);
    expect(p.interrupt()).toBeNull();
  });

  it('S7: cuts the item being heard, not the newest generated item, and lists the unheard one', () => {
    const p = new PlaybackTracker();
    const a1 = p.onAudioSent('item_A', 20);
    p.onAudioSent('item_A', 20);
    p.onAudioSent('item_B', 20);
    p.onMark(a1);
    expect(p.interrupt()).toEqual({ heard: { itemId: 'item_A', audioEndMs: 20 }, unheard: ['item_B'] });
    expect(p.isCut('item_A')).toBe(true);
    expect(p.isCut('item_B')).toBe(true);
  });

  it('S7: once A has played out, B is the item being heard', () => {
    const p = new PlaybackTracker();
    const a = p.onAudioSent('item_A', 20);
    const b1 = p.onAudioSent('item_B', 20);
    p.onAudioSent('item_B', 20);
    p.onMark(a);
    p.onMark(b1);
    expect(p.interrupt()).toEqual({ heard: { itemId: 'item_B', audioEndMs: 20 }, unheard: [] });
  });

  it('nothing to truncate once everything played', () => {
    const p = new PlaybackTracker();
    p.onMark(p.onAudioSent('item_1', 40));
    expect(p.hasPendingAudio).toBe(false);
    expect(p.interrupt()).toBeNull();
  });
});

describe('voice logic: timing', () => {
  it('measures connect to first audio and each turn', () => {
    const t = new TimingTracker();
    t.onConnect(1000);
    expect(t.onAudioSent(1800)).toEqual({ kind: 'first_audio', ms: 800 });
    t.onSpeechStopped(5000);
    expect(t.onAudioSent(5600)).toEqual({ kind: 'turn', turn: 1, ms: 600 });
    expect(t.onAudioSent(5700)).toBeNull();
    expect(t.summary()).toMatchObject({ connectToFirstAudioMs: 800, turns: [600], p50: 600, max: 600 });
  });
});

describe('voice logic: redaction', () => {
  it('redacts the API key and key-shaped strings', () => {
    const key = 'sk-proj-ABCDEFGHIJKLMNOP';
    expect(redact(`bad key ${key}`, [key])).toBe('bad key [redacted]');
    expect(redact('Incorrect API key provided: sk-pr****MNOP. Check it.')).not.toContain('MNOP');
  });

  it('B3: removes phone numbers, stream tokens and caps long text', () => {
    const out = redact('call +1 (555) 555-0123 or 5555550123 streamToken=opaque-token-abcdefghijklmnop');
    expect(out).not.toContain('555-0123');
    expect(out).not.toContain('5555550123');
    expect(out).toContain('***0123');
    expect(out).not.toContain('opaque-token-abcdefghijklmnop');
    expect(redact('x'.repeat(500)).length).toBeLessThan(200);
  });

  it('B3: the safe logger redacts every field and message, and keeps safe IDs', () => {
    const { logger, lines } = fakeLogger();
    const log = safeLogger(logger, ['SECRET_AUTH_TOKEN_VALUE']);
    log.error({ callId: 'call_test_01', note: 'recipient +15555550123', nested: { err: 'SECRET_AUTH_TOKEN_VALUE leaked' }, tool: '+15555550123' }, 'failed for +15555550123');
    const text = JSON.stringify(lines);
    expect(text).not.toContain('5555550123');
    expect(text).not.toContain('SECRET_AUTH_TOKEN_VALUE');
    expect(lines[0]?.data.callId).toBe('call_test_01');
  });

  it('B3: errors become a class name and a code, never the message', () => {
    const err = Object.assign(new Error('send to +15555550123 failed'), { code: 'ECONNRESET' });
    expect(errorInfo(err)).toEqual({ errorName: 'Error', errorCode: 'ECONNRESET' });
    expect(JSON.stringify(errorInfo('raw +15555550123'))).not.toContain('555');
  });

  it('keeps only the last four digits', () => {
    expect(last4('+15555550123')).toBe('0123');
    expect(last4(undefined)).toBeUndefined();
    expect(last4('12')).toBeUndefined();
  });
});


describe('rereview playback lifecycle', () => {
  it('R6: completed and acknowledged items release all retained offsets', () => {
    const p = new PlaybackTracker();
    for (let i = 0; i < 2000; i++) {
      const id = `item_${i}`;
      const mark = p.onAudioSent(id, 20);
      p.onItemDone(id);
      p.onMark(mark);
    }
    expect(p.retainedItems).toBe(0);
  });

  it('R6: canceled item tombstones survive late deltas until generation ends', () => {
    const p = new PlaybackTracker();
    for (let i = 0; i < 2000; i++) {
      const id = `cut_${i}`;
      p.onAudioSent(id, 20); p.interrupt();
      expect(p.isCut(id)).toBe(true);
      p.onItemDone(id);
    }
    expect(p.retainedItems).toBe(0);
    p.clear(); expect(p.pendingMarks).toBe(0);
  });
});


it('strips Markdown emphasis from server speech', () => {
  expect(buildSayTwiml('**Hello** _friend_')).toContain('<Say>Hello friend</Say>');
});
