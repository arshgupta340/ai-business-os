// Pure logic with no I/O, so it can be unit tested.
import { randomBytes } from 'node:crypto';
import { STREAM_TOKEN_PARAM, ULAW_BYTES_PER_MS, WS_PATH } from './constants.js';

// ---------- TwiML ----------

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** `wss://<host>/ws/phone` for a public https origin. Twilio does not allow a query string here. */
export function streamUrl(publicServerUrl: string): string {
  const u = new URL(publicServerUrl);
  return `wss://${u.host}${WS_PATH}`;
}

/** TwiML that says nothing and connects the call to our Media Stream with the token as a parameter. */
export function buildConnectTwiml(publicServerUrl: string, streamToken: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    '  <Connect>',
    `    <Stream url="${xmlEscape(streamUrl(publicServerUrl))}">`,
    `      <Parameter name="${STREAM_TOKEN_PARAM}" value="${xmlEscape(streamToken)}" />`,
    '    </Stream>',
    '  </Connect>',
    '</Response>',
  ].join('\n');
}

/** TwiML for a refused call. */
export function buildRejectTwiml(): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Reject />\n</Response>';
}

// ---------- Stream token ----------

export type TokenCheck = { ok: true } | { ok: false; reason: 'unknown' | 'expired' | 'call_mismatch' };

/**
 * In-memory stream tokens. The webhook mints one per call; the WebSocket consumes it once.
 * The real server will store it against the `calls` row (SPEC 2.9).
 */
export class StreamTokenStore {
  private tokens = new Map<string, { callSid: string; expiresAt: number }>();

  constructor(private ttlMs = 60_000) {}

  mint(callSid: string, now = Date.now(), token = randomBytes(24).toString('base64url')): string {
    this.prune(now);
    this.tokens.set(token, { callSid, expiresAt: now + this.ttlMs });
    return token;
  }

  /** Single use: a token is removed on any check, pass or fail. */
  consume(token: string | undefined, callSid: string | undefined, now = Date.now()): TokenCheck {
    if (!token) return { ok: false, reason: 'unknown' };
    const entry = this.tokens.get(token);
    if (!entry) return { ok: false, reason: 'unknown' };
    this.tokens.delete(token);
    if (now > entry.expiresAt) return { ok: false, reason: 'expired' };
    if (callSid !== undefined && callSid !== entry.callSid) return { ok: false, reason: 'call_mismatch' };
    return { ok: true };
  }

  get size(): number {
    return this.tokens.size;
  }

  private prune(now: number): void {
    for (const [t, e] of this.tokens) if (now > e.expiresAt) this.tokens.delete(t);
  }
}

// ---------- Mark queue and truncate offset ----------

/** Milliseconds of audio in a base64 G.711 u-law payload. */
export function ulawBase64DurationMs(base64: string): number {
  return Buffer.from(base64, 'base64').length / ULAW_BYTES_PER_MS;
}

/**
 * Tracks how much of the model's current audio item the caller has actually heard.
 *
 * After each audio chunk we send Twilio a mark named with the item's cumulative end offset.
 * Twilio echoes a mark once the audio before it has played. So the last echoed mark for an
 * item tells us how far playback got. On barge-in we truncate the item at that offset.
 *
 * After a `clear`, Twilio also echoes the marks for audio it dropped. Those must not count as
 * played, so `interrupt()` empties the queue and any later echo that is not queued is ignored.
 */
export class PlaybackTracker {
  private itemId: string | null = null;
  private sentMs = 0;
  private playedMs = 0;
  private seq = 0;
  private queue: { name: string; itemId: string; endMs: number }[] = [];

  /** Record an audio chunk about to be sent. Returns the mark name to send right after it. */
  onAudioSent(itemId: string, durationMs: number): string {
    if (itemId !== this.itemId) {
      this.itemId = itemId;
      this.sentMs = 0;
      this.playedMs = 0;
    }
    this.sentMs += durationMs;
    const name = `p${++this.seq}`;
    this.queue.push({ name, itemId, endMs: this.sentMs });
    return name;
  }

  /** Twilio echoed a mark. Returns true if it was one we were waiting for. */
  onMark(name: string): boolean {
    const idx = this.queue.findIndex((m) => m.name === name);
    if (idx === -1) return false;
    // Marks play in order, so everything up to and including this one has played.
    const [mark] = this.queue.splice(0, idx + 1).slice(-1);
    if (mark && mark.itemId === this.itemId) this.playedMs = Math.max(this.playedMs, mark.endMs);
    return true;
  }

  /** True when audio has been sent that Twilio has not confirmed as played. */
  get hasPendingAudio(): boolean {
    return this.queue.length > 0;
  }

  get currentItemId(): string | null {
    return this.itemId;
  }

  /**
   * Caller started speaking. If audio is still pending, return what to truncate
   * (item and the whole-millisecond offset the caller heard), then reset. Otherwise null.
   */
  interrupt(): { itemId: string; audioEndMs: number } | null {
    const result =
      this.itemId && this.queue.length > 0
        ? { itemId: this.itemId, audioEndMs: Math.floor(Math.min(this.playedMs, this.sentMs)) }
        : null;
    this.queue = [];
    this.itemId = null;
    this.sentMs = 0;
    this.playedMs = 0;
    return result;
  }
}

// ---------- Timing ----------

export interface CallTimings {
  connectToFirstAudioMs: number | null;
  turns: number[];
}

/** Measures connect to first audio, and end of caller speech to first response audio per turn. */
export class TimingTracker {
  private connectAt: number | null = null;
  private firstAudioMs: number | null = null;
  private speechStoppedAt: number | null = null;
  readonly turns: number[] = [];

  onConnect(now: number): void {
    this.connectAt = now;
  }

  onSpeechStopped(now: number): void {
    this.speechStoppedAt = now;
  }

  /** Caller started talking again before we answered: that turn has no measurement yet. */
  onSpeechStarted(): void {
    this.speechStoppedAt = null;
  }

  /** Call for every audio chunk sent to Twilio. Returns a log line when a measurement completes. */
  onAudioSent(now: number): string | null {
    if (this.firstAudioMs === null && this.connectAt !== null) {
      this.firstAudioMs = now - this.connectAt;
      return `connect to first audio: ${this.firstAudioMs} ms`;
    }
    if (this.speechStoppedAt !== null) {
      const ms = now - this.speechStoppedAt;
      this.speechStoppedAt = null;
      this.turns.push(ms);
      return `turn ${this.turns.length}: end of caller speech to first response audio: ${ms} ms`;
    }
    return null;
  }

  summary(): CallTimings & { p50: number | null; max: number | null } {
    const sorted = [...this.turns].sort((a, b) => a - b);
    const p50 = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : null;
    const max = sorted.length ? sorted[sorted.length - 1]! : null;
    return { connectToFirstAudioMs: this.firstAudioMs, turns: [...this.turns], p50, max };
  }
}
