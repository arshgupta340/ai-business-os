// Pure voice logic with no I/O, so it can be unit tested: TwiML, the per-call stream credential,
// the playback tracker for barge-in, call timing and log redaction.
import { randomBytes } from 'node:crypto';
import { STREAM_TOKEN_TTL_MS } from '@abos/contracts';
import { STREAM_TOKEN_PARAM, ULAW_BYTES_PER_MS, WS_PATH } from './constants';
import type { VoiceLogger } from './types';

// ---------- TwiML ----------

/** Server-authored speech has no Markdown emphasis delimiters. */
export function spokenText(text: string): string {
  return text.replace(/\*+/g, '').replace(/(?<!\w)_{1,3}(.+?)_{1,3}(?!\w)/g, '$1').replace(/~~(.+?)~~/g, '$1').replace(/`+/g, '');
}

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
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<Response>', `  <Say>${xmlEscape(spokenText(message))}</Say>`, '  <Hangup />', '</Response>'].join('\n');
}

/** TwiML for a request we refuse outright (bad signature, replay). */
export function buildRejectTwiml(): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Reject />\n</Response>';
}

export const NOT_TAKING_CALLS_MESSAGE = 'Sorry, this line is not taking calls right now. Please try again later. Goodbye.';
export const CANNOT_TAKE_ORDERS_MESSAGE = 'Sorry, we cannot take orders or bookings by phone right now. Please try again later. Goodbye.';
export const CALL_SETUP_FAILED_MESSAGE = 'Sorry, we cannot take your call right now. Please try again later. Goodbye.';

// ---------- Stream credential ----------

export type TokenCheck<T> = { ok: true; value: T } | { ok: false; reason: 'unknown' | 'expired' | 'call_mismatch' | 'malformed' };

type Credential<T> = { token: string; value: T; expiresAt: number; state: 'pending' | 'claimed' | 'ended'; reported?: true };

/**
 * Why a credential can no longer open its call's stream: `rejected` when the token itself was presented
 * and a check failed (wrong CallSid, no stream ID, too late), `unused` when nobody presented it in time.
 */
export type UnusableCredential = 'rejected' | 'unused';

/** What a repeated webhook for the same CallSid gets. */
export type CredentialLookup = { kind: 'none' } | { kind: 'pending'; token: string } | { kind: 'refused'; state: 'claimed' | 'expired' | 'ended' };

/**
 * One stream credential per call (SPEC 2.9, API 5), keyed by CallSid. The webhook mints it once;
 * a repeated webhook gets the same pending token back and never a second one. The WebSocket claims
 * it once, with the exact CallSid and a stream ID, before it expires. A claimed, expired or ended
 * credential never opens a session, and its record is kept so a later retry is refused.
 *
 * Issue #95 item 6: a credential that can no longer open a stream leaves a call that will never get
 * one. `onUnusable` is told once per call, with the pinned value, so the owner of the store can end
 * that call. It fires only for the call the presented token belongs to, or for a credential that
 * expired unclaimed. A token nobody minted, or a CallSid alone, identifies no call and ends nothing.
 */
export class StreamTokenStore<T extends { providerCallId: string }> {
  private byToken = new Map<string, Credential<T>>();
  private byCall = new Map<string, Credential<T>>();

  constructor(
    private readonly ttlMs = STREAM_TOKEN_TTL_MS,
    /** How long a used credential is remembered, to refuse late retries. */
    private readonly retentionMs = 4 * 60 * 60 * 1000,
    private readonly onUnusable?: ((value: T, why: UnusableCredential) => void) | undefined,
  ) {}

  private unusable(c: Credential<T>, why: UnusableCredential): void {
    if (c.reported) return;
    c.reported = true;
    this.onUnusable?.(c.value, why);
  }

  /** Reports every credential that expired without being presented. Call it once the life of a credential has passed. */
  expireUnclaimed(now = Date.now()): void {
    for (const c of this.byCall.values()) if (c.state === 'pending' && now >= c.expiresAt) this.unusable(c, 'unused');
  }

  lookup(providerCallId: string, now = Date.now()): CredentialLookup {
    this.prune(now);
    const c = this.byCall.get(providerCallId);
    if (c === undefined) return { kind: 'none' };
    if (c.state === 'pending' && now < c.expiresAt) return { kind: 'pending', token: c.token };
    return { kind: 'refused', state: c.state === 'pending' ? 'expired' : c.state };
  }

  /** Mints the call's one credential. Returns the existing pending token if one exists, or null if refused. */
  mint(value: T, now = Date.now(), token = randomBytes(24).toString('base64url')): string | null {
    const existing = this.lookup(value.providerCallId, now);
    if (existing.kind === 'pending') return existing.token;
    if (existing.kind === 'refused') return null;
    const c: Credential<T> = { token, value, expiresAt: now + this.ttlMs, state: 'pending' };
    this.byToken.set(token, c);
    this.byCall.set(value.providerCallId, c);
    return token;
  }

  /** Claims a credential once. Any failed check also burns it. */
  consume(token: string | undefined, providerCallId: string | undefined, streamSid: string | undefined, now = Date.now()): TokenCheck<T> {
    if (token === undefined || token === '') return { ok: false, reason: 'unknown' };
    const c = this.byToken.get(token);
    if (c === undefined || c.state !== 'pending') return { ok: false, reason: 'unknown' };
    this.byToken.delete(token);
    c.state = 'claimed';
    const reason = now >= c.expiresAt ? 'expired' as const
      : providerCallId === undefined || providerCallId === '' || streamSid === undefined || streamSid === '' ? 'malformed' as const
      : providerCallId !== c.value.providerCallId ? 'call_mismatch' as const : undefined;
    if (reason === undefined) return { ok: true, value: c.value };
    // The credential is burned, so this call can never get a stream.
    this.unusable(c, 'rejected');
    return { ok: false, reason };
  }

  /** The call ended: its credential can never be used or reissued. */
  end(providerCallId: string): void {
    const c = this.byCall.get(providerCallId);
    if (c === undefined) return;
    c.state = 'ended';
    this.byToken.delete(c.token);
  }

  get size(): number {
    return this.byCall.size;
  }

  private prune(now: number): void {
    for (const [sid, c] of this.byCall) {
      if (now >= c.expiresAt + this.retentionMs) {
        this.byCall.delete(sid);
        this.byToken.delete(c.token);
      }
    }
  }
}

// ---------- Mark queue and truncate offsets ----------

/** Milliseconds of audio in a base64 G.711 u-law payload. */
export function ulawBase64DurationMs(base64: string): number {
  return Buffer.from(base64, 'base64').length / ULAW_BYTES_PER_MS;
}

export type Interruption = {
  /** The item the caller was hearing, cut at the last offset Twilio confirmed as played. */
  heard: { itemId: string; audioEndMs: number };
  /** Later items already sent to Twilio but not yet heard at all. */
  unheard: string[];
};

/**
 * Tracks, per model audio item and in playback order, how much the caller has heard.
 *
 * After each audio chunk we send Twilio a mark carrying the item and its cumulative end offset.
 * Twilio echoes marks in order once the audio before them has played. The item being heard is the
 * item of the oldest unacknowledged mark, cut at that item's last acknowledged offset. Items behind
 * it have not been heard at all. After a `clear`, Twilio echoes the marks for dropped audio too;
 * `interrupt()` empties the queue so those are ignored, and audio still arriving for a cut item is
 * refused by `isCut`.
 */
export class PlaybackTracker {
  private seq = 0;
  private queue: { name: string; itemId: string; endMs: number }[] = [];
  private sentMs = new Map<string, number>();
  private playedMs = new Map<string, number>();
  private cut = new Set<string>();
  private completed = new Set<string>();

  get retainedItems(): number {
    return new Set([...this.sentMs.keys(), ...this.playedMs.keys(), ...this.cut, ...this.completed]).size;
  }

  /** Generation ended. Offsets remain only while Twilio still has this item's audio. */
  onItemDone(itemId: string): void {
    this.completed.add(itemId);
    this.retire(itemId);
  }

  private retire(itemId: string): void {
    if (!this.completed.has(itemId) || this.queue.some((m) => m.itemId === itemId)) return;
    this.sentMs.delete(itemId);
    this.playedMs.delete(itemId);
    this.cut.delete(itemId);
    this.completed.delete(itemId);
  }

  clear(): void {
    this.queue = [];
    this.sentMs.clear(); this.playedMs.clear(); this.cut.clear(); this.completed.clear();
  }

  /** Record an audio chunk about to be sent. Returns the mark name to send right after it. */
  onAudioSent(itemId: string, durationMs: number): string {
    const sent = (this.sentMs.get(itemId) ?? 0) + durationMs;
    this.sentMs.set(itemId, sent);
    const name = `p${++this.seq}`;
    this.queue.push({ name, itemId, endMs: sent });
    return name;
  }

  /** Twilio echoed a mark. Returns true if it was one we were waiting for. */
  onMark(name: string): boolean {
    const idx = this.queue.findIndex((m) => m.name === name);
    if (idx === -1) return false;
    const acknowledged = this.queue.splice(0, idx + 1);
    for (const m of acknowledged) this.playedMs.set(m.itemId, Math.max(this.playedMs.get(m.itemId) ?? 0, m.endMs));
    for (const m of acknowledged) this.retire(m.itemId);
    return true;
  }

  get hasPendingAudio(): boolean {
    return this.queue.length > 0;
  }

  get pendingMarks(): number {
    return this.queue.length;
  }

  /** Audio for an item that was cut by barge-in must not be played. */
  isCut(itemId: string): boolean {
    return this.cut.has(itemId);
  }

  /** Caller started speaking. Returns what to truncate, or null when nothing is pending; then resets. */
  interrupt(): Interruption | null {
    const head = this.queue[0];
    let result: Interruption | null = null;
    if (head !== undefined) {
      const order: string[] = [];
      for (const m of this.queue) if (!order.includes(m.itemId)) order.push(m.itemId);
      const heardMs = Math.floor(Math.min(this.playedMs.get(head.itemId) ?? 0, this.sentMs.get(head.itemId) ?? 0));
      result = { heard: { itemId: head.itemId, audioEndMs: heardMs }, unheard: order.slice(1) };
      for (const id of order) this.cut.add(id);
    }
    this.queue = [];
    this.sentMs.clear();
    this.playedMs.clear();
    for (const id of this.completed) this.retire(id);
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
  private static readonly MAX_TURNS = 200;

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
      if (this.turns.length < TimingTracker.MAX_TURNS) this.turns.push(ms);
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

// ---------- Redaction: the one path every log line takes ----------

const MAX_LOG_TEXT = 120;
/**
 * Makes any text safe to log: removes configured secrets, OpenAI-style keys, phone numbers (kept as
 * the last four digits), token-like runs (stream tokens, base64) and caps the length.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) if (s.length > 0) out = out.split(s).join('[redacted]');
  out = out.replace(/sk-[A-Za-z0-9_\-*]{4,}/g, '[redacted]');
  out = out.replace(/(Incorrect API key provided: )[^.]*\./, '$1[redacted].');
  out = out.replace(/\+?\d[\d\s().-]{5,}\d/g, (m) => `[number ***${m.replace(/\D/g, '').slice(-4)}]`);
  out = out.replace(/[A-Za-z0-9_-]{24,}/g, '[token]');
  out = out.replace(/\s+/g, ' ');
  return out.length > MAX_LOG_TEXT ? `${out.slice(0, MAX_LOG_TEXT)}...[truncated]` : out;
}

function sanitizeValue(key: string, value: unknown, secrets: readonly string[], depth: number): unknown {
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return redact(value, secrets);
  }
  if (depth > 3) return '[omitted]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitizeValue(key, v, secrets, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value).slice(0, 30)) out[k] = sanitizeValue(k, v, secrets, depth + 1);
    return out;
  }
  return '[omitted]';
}

/** Redacts every field of a log record. */
export function sanitizeLogData(data: Record<string, unknown>, secrets: readonly string[] = []): Record<string, unknown> {
  return sanitizeValue('', data, secrets, 0) as Record<string, unknown>;
}

/** Wraps a logger so every message and field passes through `redact`. */
export function safeLogger(logger: VoiceLogger, secrets: readonly string[] = []): VoiceLogger {
  return {
    info: (data, msg) => logger.info(sanitizeLogData(data, secrets), redact(msg, secrets)),
    warn: (data, msg) => logger.warn(sanitizeLogData(data, secrets), redact(msg, secrets)),
    error: (data, msg) => logger.error(sanitizeLogData(data, secrets), redact(msg, secrets)),
  };
}

/** An error as allowlisted metadata only: its class name and a code, never its message. */
export function errorInfo(err: unknown): { errorName: string; errorCode?: string } {
  const names = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError']);
  const codes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND']);
  const name = err instanceof Error && names.has(err.name) ? err.name : 'unknown_error';
  const code = (err as { code?: unknown } | null)?.code;
  return { errorName: name, errorCode: typeof code === 'string' && codes.has(code) ? code : 'unknown_error' };
}

/** The last four digits of a phone number, the only form that may be logged or stored. */
export function last4(phone: string | undefined): string | undefined {
  if (phone === undefined) return undefined;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : undefined;
}
