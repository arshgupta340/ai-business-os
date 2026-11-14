import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findEnvFile } from '../src/env.js';
import {
  buildConnectTwiml,
  PlaybackTracker,
  StreamTokenStore,
  streamUrl,
  TimingTracker,
  ulawBase64DurationMs,
} from '../src/logic.js';
import { redact } from '../src/relay.js';
import { runTool, toolDefinitions } from '../src/tools.js';

describe('TwiML', () => {
  it('connects to wss://<host>/ws/phone with the token as a Parameter and says nothing', () => {
    const xml = buildConnectTwiml('https://demo.ngrok-free.app', 'tok_abc');
    expect(xml).toContain('<Connect>');
    expect(xml).toContain('<Stream url="wss://demo.ngrok-free.app/ws/phone">');
    expect(xml).toContain('<Parameter name="streamToken" value="tok_abc" />');
    expect(xml).not.toContain('<Say');
    expect(xml).not.toMatch(/url="[^"]*\?/); // Twilio rejects a query string in the Stream url
  });

  it('drops any path or trailing slash on PUBLIC_SERVER_URL and keeps a port', () => {
    expect(streamUrl('https://x.example.com/')).toBe('wss://x.example.com/ws/phone');
    expect(streamUrl('https://x.example.com:8443/foo')).toBe('wss://x.example.com:8443/ws/phone');
  });

  it('escapes XML in the token', () => {
    expect(buildConnectTwiml('https://h.example', 'a"<&')).toContain('value="a&quot;&lt;&amp;"');
  });
});

describe('StreamTokenStore', () => {
  it('accepts a fresh token once for the right call', () => {
    const s = new StreamTokenStore(1000);
    const t = s.mint('CA1', 0);
    expect(s.consume(t, 'CA1', 500)).toEqual({ ok: true });
    expect(s.consume(t, 'CA1', 600)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('rejects missing, unknown, expired and mismatched tokens', () => {
    const s = new StreamTokenStore(1000);
    expect(s.consume(undefined, 'CA1', 0).ok).toBe(false);
    expect(s.consume('nope', 'CA1', 0)).toEqual({ ok: false, reason: 'unknown' });
    const t1 = s.mint('CA1', 0);
    expect(s.consume(t1, 'CA1', 1001)).toEqual({ ok: false, reason: 'expired' });
    const t2 = s.mint('CA1', 0);
    expect(s.consume(t2, 'CA2', 10)).toEqual({ ok: false, reason: 'call_mismatch' });
  });

  it('mints distinct random tokens and prunes expired ones', () => {
    const s = new StreamTokenStore(1000);
    const a = s.mint('CA1', 0);
    const b = s.mint('CA2', 0);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
    s.mint('CA3', 5000);
    expect(s.size).toBe(1);
  });
});

describe('PlaybackTracker (mark queue and truncate offset)', () => {
  it('computes u-law duration at 8 bytes per ms', () => {
    expect(ulawBase64DurationMs(Buffer.alloc(160).toString('base64'))).toBe(20);
  });

  it('truncates at the end of the last chunk Twilio confirmed as played', () => {
    const p = new PlaybackTracker();
    const m1 = p.onAudioSent('item_1', 100);
    const m2 = p.onAudioSent('item_1', 100);
    p.onAudioSent('item_1', 100);
    expect(p.onMark(m1)).toBe(true);
    expect(p.onMark(m2)).toBe(true);
    expect(p.interrupt()).toEqual({ itemId: 'item_1', audioEndMs: 200 });
  });

  it('truncates at 0 when nothing has played yet', () => {
    const p = new PlaybackTracker();
    p.onAudioSent('item_1', 40);
    expect(p.interrupt()).toEqual({ itemId: 'item_1', audioEndMs: 0 });
  });

  it('returns null when all audio has played, so no clear or truncate is sent', () => {
    const p = new PlaybackTracker();
    const m = p.onAudioSent('item_1', 40);
    p.onMark(m);
    expect(p.hasPendingAudio).toBe(false);
    expect(p.interrupt()).toBeNull();
  });

  it('ignores marks Twilio echoes after a clear', () => {
    const p = new PlaybackTracker();
    p.onAudioSent('item_1', 50);
    const dropped = p.onAudioSent('item_1', 50);
    p.interrupt();
    expect(p.onMark(dropped)).toBe(false);
    const m = p.onAudioSent('item_2', 30);
    p.onAudioSent('item_2', 30);
    p.onMark(m);
    expect(p.interrupt()).toEqual({ itemId: 'item_2', audioEndMs: 30 });
  });

  it('resets the offset when a new item starts', () => {
    const p = new PlaybackTracker();
    const a = p.onAudioSent('item_1', 500);
    p.onMark(a);
    p.onAudioSent('item_2', 20);
    expect(p.interrupt()).toEqual({ itemId: 'item_2', audioEndMs: 0 });
  });

  it('floors fractional offsets to whole milliseconds', () => {
    const p = new PlaybackTracker();
    const m = p.onAudioSent('i', 12.5);
    p.onAudioSent('i', 10);
    p.onMark(m);
    expect(p.interrupt()?.audioEndMs).toBe(12);
  });

  it('treats a later mark as confirming every earlier one', () => {
    const p = new PlaybackTracker();
    p.onAudioSent('i', 10);
    const m2 = p.onAudioSent('i', 10);
    p.onAudioSent('i', 10);
    p.onMark(m2);
    expect(p.interrupt()?.audioEndMs).toBe(20);
  });
});

describe('TimingTracker', () => {
  it('measures connect to first audio, then each turn', () => {
    const t = new TimingTracker();
    t.onConnect(1000);
    expect(t.onAudioSent(2200)).toContain('1200 ms');
    expect(t.onAudioSent(2300)).toBeNull();
    t.onSpeechStopped(5000);
    expect(t.onAudioSent(5800)).toContain('800 ms');
    t.onSpeechStopped(9000);
    t.onSpeechStarted();
    t.onSpeechStopped(9500);
    t.onAudioSent(10100);
    expect(t.summary()).toEqual({ connectToFirstAudioMs: 1200, turns: [800, 600], p50: 600, max: 800 });
  });
});

describe('tools', () => {
  it('exposes get_test_fact as a function tool', () => {
    expect(toolDefinitions()).toEqual([expect.objectContaining({ type: 'function', name: 'get_test_fact' })]);
  });
  it('runs the tool and handles unknown tools and bad JSON', async () => {
    expect((await runTool('get_test_fact', '{}')).ok).toBe(true);
    expect(await runTool('nope', '{}')).toEqual({ ok: false, reason: 'unknown_tool' });
    expect(await runTool('get_test_fact', '{bad')).toEqual({ ok: false, reason: 'bad_arguments' });
  });
});

describe('redact', () => {
  it('removes the key and key-like strings from OpenAI error text', () => {
    const msg = 'Incorrect API key provided: sk-proj-abc***wxyz. You can find your API key at x.';
    expect(redact(msg, 'sk-proj-realsecret')).toBe('Incorrect API key provided: [redacted]. You can find your API key at x.');
    expect(redact('token mysecret here', 'mysecret')).toBe('token [redacted] here');
  });
});

describe('findEnvFile', () => {
  it('walks up parent directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'envwalk-'));
    const deep = join(root, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(root, '.env.local'), 'X=1\n');
    expect(findEnvFile(deep)).toBe(join(root, '.env.local'));
    expect(findEnvFile(deep, '.env.does-not-exist-anywhere')).toBeNull();
  });
});
