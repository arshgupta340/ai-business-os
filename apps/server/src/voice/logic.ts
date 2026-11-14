// Pure voice logic with no I/O, so it can be unit tested: TwiML, the stream token store,
// the playback tracker for barge-in, call timing and log redaction.
import { randomBytes } from 'node:crypto';
import { STREAM_TOKEN_TTL_MS } from '@abos/contracts';
import { STREAM_TOKEN_PARAM, ULAW_BYTES_PER_MS, WS_PATH } from './constants';

// ---------- TwiML ----------

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** `wss://<host>/ws/phone` for the public origin. Twilio does not allow a query string here. */
export function streamUrl(publicServerUrl: string): string {
  return `wss://${new URL(publicServerUrl).host}${WS_PATH}`;
}

/** TwiML that says nothing and connects the call to our Media Stream with the token as a custom parameter. */
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

/** TwiML that speaks a short message and hangs up. */
export function buildSayTwiml(message: string): string {
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<Response>', `  <Say>${xmlEscape(message)}</Say>`, '  <Hangup />', '</Response>'].join('\n');
}

/** TwiML for a request we refuse outright (bad signature). */
export function buildRejectTwiml(): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Reject />\n</Response>';
}

export const NOT_TAKING_CALLS_MESSAGE = 'Sorry, this line is not taking calls right now. Please try again later. Goodbye.';
export const CALL_SETUP_FAILED_MESSAGE = 'Sorry, we cannot take your call right now. Please try again later. Goodbye.';

// ---------- Stream token ----------

export type TokenCheck<T> = { ok: true; value: T } | { ok: false; reason: 'unknown' | 'expired' | 'call_mismatch' };

/**
 * Single-use stream tokens (SPEC 2.9, API 5). The webhook mints one per call; the WebSocket
 * consumes it once. Each token carries what the webhook pinned for that call.
 */
export class StreamTokenStore<T extends { providerCallId: string }> {
  private tokens = new Map<string, { value: T; expiresAt: number }>();

  constructor(private readonly ttlMs = STREAM_TOKEN_TTL_MS) {}

  mint(value: T, now = Date.now(), token = randomBytes(24).toString('base64url')): string {
    this.prune(now);
    this.tokens.set(token, { value, expiresAt: now + this.ttlMs });
    return token;
  }

  /** A token is removed on any check, pass or fail. */
  consume(token: string | undefined, providerCallId: string | undefined, now = Date.now()): TokenCheck<T> {
    if (token === undefined || token === '') return { ok: false, reason: 'unknown' };
    const entry = this.tokens.get(token);
    if (entry === undefined) return { ok: false, reason: 'unknown' };
    this.tokens.delete(token);
    if (now > entry.expiresAt) return { ok: false, reason: 'expired' };
    if (providerCallId !== undefined && providerCallId !== entry.value.providerCallId) return { ok: false, reason: 'call_mismatch' };
    return { ok: true, value: entry.value };
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
 * After each audio chunk we send Twilio a mark named for the item's cumulative end offset.
 * Twilio echoes a mark once the audio before it has played, so the last echoed mark tells us how
 * far playback got. On barge-in we truncate the item at that offset. After a `clear`, Twilio also
 * echoes the marks for audio it dropped; `interrupt()` empties the queue so those are ignored.
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
    const [mark] = this.queue.splice(0, idx + 1).slice(-1);
    if (mark && mark.itemId === this.itemId) this.playedMs = Math.max(this.playedMs, mark.endMs);
    return true;
  }

  get hasPendingAudio(): boolean {
    return this.queue.length > 0;
  }

  /** Caller started speaking. If audio is pending, return the item and the whole-millisecond offset heard, then reset. */
  interrupt(): { itemId: string; audioEndMs: number } | null {
    const result = this.itemId && this.queue.length > 0 ? { itemId: this.itemId, audioEndMs: Math.floor(Math.min(this.playedMs, this.sentMs)) } : null;
    this.queue = [];
    this.itemId = null;
    this.sentMs = 0;
    this.playedMs = 0;
    return result;
  }
}

// ---------- Timing ----------

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

  onSpeechStarted(): void {
    this.speechStoppedAt = null;
  }

  /** Call for every audio chunk sent to Twilio. Returns a measurement when one completes. */
  onAudioSent(now: number): { kind: 'first_audio'; ms: number } | { kind: 'turn'; turn: number; ms: number } | null {
    if (this.firstAudioMs === null && this.connectAt !== null) {
      this.firstAudioMs = now - this.connectAt;
      return { kind: 'first_audio', ms: this.firstAudioMs };
    }
    if (this.speechStoppedAt !== null) {
      const ms = now - this.speechStoppedAt;
      this.speechStoppedAt = null;
      this.turns.push(ms);
      return { kind: 'turn', turn: this.turns.length, ms };
    }
    return null;
  }

  summary(): { connectToFirstAudioMs: number | null; turns: number[]; p50: number | null; p95: number | null; max: number | null } {
    const sorted = [...this.turns].sort((a, b) => a - b);
    const at = (q: number) => (sorted.length ? (sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] ?? null) : null);
    return { connectToFirstAudioMs: this.firstAudioMs, turns: [...this.turns], p50: at(0.5), p95: at(0.95), max: sorted.length ? (sorted[sorted.length - 1] ?? null) : null };
  }
}

// ---------- Redaction ----------

/** Removes the given secrets and anything that looks like an OpenAI key from a log line. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) if (s.length > 0) out = out.split(s).join('[redacted]');
  out = out.replace(/sk-[A-Za-z0-9_\-*]{4,}/g, '[redacted]');
  return out.replace(/(Incorrect API key provided: )[^.]*\./, '$1[redacted].');
}

/** The last four digits of a phone number, the only form that may be logged or stored. */
export function last4(phone: string | undefined): string | undefined {
  if (phone === undefined) return undefined;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : undefined;
}
