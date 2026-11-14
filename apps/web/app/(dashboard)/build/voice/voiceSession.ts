/**
 * The builder voice session as a small state machine, with no React in it.
 *
 *   idle -> requesting_microphone -> connecting -> listening <-> speaking
 *   any active phase -> ended (the owner stopped) or failed (with a reason)
 *
 * Order of steps (task U-12): ask for the microphone first, because the client
 * secret lives 60 seconds; then mint; then open the WebRTC connection and post
 * the SDP offer to OpenAI. Every browser API and network call goes through
 * VoiceDeps, so tests drive the machine with fakes.
 *
 * The client secret only ever lives in a local variable inside start(). It is
 * never put in state, storage, a URL, a log or an error.
 */
import {isApiError} from '@/lib/api';
import {DATA_CHANNEL_LABEL, parseServerEvent, REALTIME_CALLS_URL, speakReplyEvent} from './realtime';

export type VoicePhase = 'idle' | 'requesting_microphone' | 'connecting' | 'listening' | 'speaking' | 'ended' | 'failed';

export type VoiceFailure =
  | 'mock'
  | 'integration_unavailable'
  | 'unsupported'
  | 'microphone_denied'
  | 'no_microphone'
  | 'microphone_failed'
  | 'rate_limited'
  | 'mint_failed'
  | 'expired'
  | 'connection_failed'
  | 'connection_lost';

/** A short note shown while voice stays on. */
export type VoiceNote = 'not_heard' | 'busy' | 'not_sent';

export interface VoiceState {
  phase: VoicePhase;
  failure: VoiceFailure | null;
  isMuted: boolean;
  /** Epoch milliseconds before which voice may not start again (rate limit). */
  retryAt: number | null;
  note: VoiceNote | null;
}

/** Failures that mean voice cannot work on this page at all. The control never asks for the microphone again. */
export const STICKY_FAILURES: ReadonlySet<VoiceFailure> = new Set(['mock', 'integration_unavailable', 'unsupported']);

export interface MintedSecret {
  clientSecret: string;
  expiresAt: string;
}

export interface VoiceDeps {
  isSupported(): boolean;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createPeerConnection(): RTCPeerConnection;
  createAudioElement(): HTMLAudioElement;
  fetch(input: string, init: RequestInit): Promise<Response>;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface VoiceSessionOptions {
  deps: VoiceDeps;
  mint(): Promise<MintedSecret>;
  onTranscript(text: string): void;
  onChange(state: VoiceState): void;
  /** Set in mock mode: voice is off and the microphone is never requested. */
  unavailable?: 'mock';
  /** How long to wait for the data channel after the SDP answer. */
  connectTimeoutMs?: number;
}

const DEFAULT_RETRY_AFTER_SECONDS = 60;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

export function browserVoiceDeps(): VoiceDeps {
  return {
    isSupported: () =>
      typeof window !== 'undefined' &&
      typeof window.RTCPeerConnection === 'function' &&
      typeof navigator !== 'undefined' &&
      typeof navigator.mediaDevices?.getUserMedia === 'function',
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createPeerConnection: () => new RTCPeerConnection(),
    createAudioElement: () => document.createElement('audio'),
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  };
}

function microphoneFailure(err: unknown): VoiceFailure {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as {name: unknown}).name) : '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'microphone_denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'no_microphone';
  return 'microphone_failed';
}

function retryAfterSeconds(details: Record<string, unknown> | undefined): number {
  const value = details?.retryAfterSeconds;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : DEFAULT_RETRY_AFTER_SECONDS;
}

export class VoiceSession {
  #opts: VoiceSessionOptions;
  #state: VoiceState;
  /** Bumped by every release, so a late await from an old attempt does nothing. */
  #generation = 0;
  #disposed = false;
  #stream: MediaStream | null = null;
  #pc: RTCPeerConnection | null = null;
  #dc: RTCDataChannel | null = null;
  #audio: HTMLAudioElement | null = null;
  #abort: AbortController | null = null;
  #connectTimer: unknown = null;
  #sawAudio = false;

  constructor(opts: VoiceSessionOptions) {
    this.#opts = opts;
    this.#state = {
      phase: opts.unavailable ? 'failed' : 'idle',
      failure: opts.unavailable ?? null,
      isMuted: false,
      retryAt: null,
      note: null,
    };
  }

  get state(): VoiceState {
    return this.#state;
  }

  get isActive(): boolean {
    const {phase} = this.#state;
    return phase === 'requesting_microphone' || phase === 'connecting' || phase === 'listening' || phase === 'speaking';
  }

  get isConnected(): boolean {
    return this.#state.phase === 'listening' || this.#state.phase === 'speaking';
  }

  canStart(): boolean {
    if (this.#disposed || this.isActive) return false;
    const {failure, retryAt} = this.#state;
    if (failure && STICKY_FAILURES.has(failure)) return false;
    if (retryAt !== null && this.#opts.deps.now() < retryAt) return false;
    return true;
  }

  /**
   * Marks voice as unsupported when this browser has no WebRTC or microphone
   * API. Called after mount, so server HTML and the first client render match.
   */
  checkSupport(): void {
    if (this.#disposed || this.#state.phase !== 'idle') return;
    if (!this.#opts.deps.isSupported()) this.#set({phase: 'failed', failure: 'unsupported'});
  }

  async start(): Promise<void> {
    if (!this.canStart()) return;
    const {deps} = this.#opts;
    const gen = ++this.#generation;
    const current = () => gen === this.#generation && !this.#disposed;

    if (!deps.isSupported()) {
      this.#fail('unsupported');
      return;
    }

    // 1. The microphone, only now that the owner pressed the button, and before minting.
    this.#set({phase: 'requesting_microphone', failure: null, retryAt: null, note: null, isMuted: false});
    let stream: MediaStream;
    try {
      stream = await deps.getUserMedia({audio: true});
    } catch (err) {
      if (current()) this.#fail(microphoneFailure(err));
      return;
    }
    if (!current()) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.#stream = stream;
    this.#set({phase: 'connecting'});

    // 2. Mint. The secret stays in this local variable.
    let secret: string;
    try {
      const minted = await this.#opts.mint();
      if (!current()) return;
      const expires = Date.parse(minted.expiresAt);
      if (!Number.isFinite(expires) || expires <= deps.now()) {
        this.#fail('expired');
        return;
      }
      secret = minted.clientSecret;
    } catch (err) {
      if (!current()) return;
      if (isApiError(err) && err.code === 'INTEGRATION_UNAVAILABLE') this.#fail('integration_unavailable');
      else if (isApiError(err) && err.code === 'RATE_LIMITED') {
        this.#fail('rate_limited', deps.now() + retryAfterSeconds(err.details) * 1000);
      } else this.#fail('mint_failed');
      return;
    }

    // 3. WebRTC: mic track out, remote audio in, the event channel, then the SDP exchange.
    try {
      const pc = deps.createPeerConnection();
      this.#pc = pc;
      const audio = deps.createAudioElement();
      audio.autoplay = true;
      this.#audio = audio;
      pc.ontrack = (event) => {
        if (current()) audio.srcObject = event.streams[0] ?? null;
      };
      pc.onconnectionstatechange = () => {
        if (!current()) return;
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          this.#fail(this.#state.phase === 'connecting' ? 'connection_failed' : 'connection_lost');
        }
      };
      for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);

      const dc = pc.createDataChannel(DATA_CHANNEL_LABEL);
      this.#dc = dc;
      dc.onopen = () => {
        if (!current() || this.#state.phase !== 'connecting') return;
        this.#clearConnectTimer();
        this.#set({phase: 'listening'});
      };
      dc.onclose = () => {
        if (current() && this.isActive) this.#fail(this.#state.phase === 'connecting' ? 'connection_failed' : 'connection_lost');
      };
      dc.onmessage = (event) => {
        if (current()) this.#handleEvent(event.data);
      };

      const offer = await pc.createOffer();
      if (!current()) return;
      await pc.setLocalDescription(offer);
      if (!current()) return;

      this.#abort = new AbortController();
      const res = await deps.fetch(REALTIME_CALLS_URL, {
        method: 'POST',
        body: offer.sdp ?? '',
        headers: {Authorization: `Bearer ${secret}`, 'Content-Type': 'application/sdp'},
        signal: this.#abort.signal,
      });
      secret = '';
      if (!current()) return;
      if (!res.ok) {
        // The body is a provider response. It is not read or shown.
        await res.body?.cancel().catch(() => undefined);
        if (current()) this.#fail('connection_failed');
        return;
      }
      const answer = await res.text();
      if (!current()) return;
      await pc.setRemoteDescription({type: 'answer', sdp: answer});
      if (!current()) return;
      if (this.#state.phase === 'connecting') {
        const timeout = this.#opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
        this.#connectTimer = deps.setTimeout(() => {
          if (current() && this.#state.phase === 'connecting') this.#fail('connection_failed');
        }, timeout);
      }
    } catch {
      secret = '';
      if (current()) this.#fail('connection_failed');
    }
  }

  /** The owner pressed stop. Releases the microphone and closes the connection. */
  stop(): void {
    const wasActive = this.isActive;
    this.#release();
    if (wasActive) this.#set({phase: 'ended', note: null, isMuted: false});
  }

  /** Unmount. Releases everything and stops reporting. */
  dispose(): void {
    this.#release();
    this.#disposed = true;
  }

  setMuted(isMuted: boolean): void {
    if (!this.isConnected && this.#state.phase !== 'connecting') return;
    this.#stream?.getAudioTracks().forEach((t) => {
      t.enabled = !isMuted;
    });
    this.#set({isMuted});
  }

  setNote(note: VoiceNote | null): void {
    if (this.#state.note !== note) this.#set({note});
  }

  /** Asks the model to read this builder reply aloud. Returns false when voice is not connected. */
  speak(text: string): boolean {
    const dc = this.#dc;
    if (!this.isConnected || !dc || dc.readyState !== 'open' || !text.trim()) return false;
    try {
      dc.send(JSON.stringify(speakReplyEvent(text)));
    } catch {
      return false;
    }
    this.#sawAudio = false;
    this.#set({phase: 'speaking'});
    return true;
  }

  #handleEvent(data: unknown): void {
    const event = parseServerEvent(data);
    switch (event.kind) {
      case 'transcript': {
        const text = event.transcript.trim();
        if (text) this.#opts.onTranscript(text);
        else this.setNote('not_heard');
        return;
      }
      case 'transcript_failed':
        this.setNote('not_heard');
        return;
      case 'audio_started':
        this.#sawAudio = true;
        return;
      case 'audio_stopped':
        if (this.#state.phase === 'speaking') this.#set({phase: 'listening'});
        return;
      case 'response_done':
        if (this.#state.phase === 'speaking' && (event.status !== 'completed' || !this.#sawAudio)) this.#set({phase: 'listening'});
        return;
      default:
        return;
    }
  }

  #fail(failure: VoiceFailure, retryAt: number | null = null): void {
    this.#release();
    this.#set({phase: 'failed', failure, retryAt, note: null, isMuted: false});
  }

  #clearConnectTimer(): void {
    if (this.#connectTimer !== null) this.#opts.deps.clearTimeout(this.#connectTimer);
    this.#connectTimer = null;
  }

  #release(): void {
    this.#generation++;
    this.#clearConnectTimer();
    this.#abort?.abort();
    this.#abort = null;
    this.#stream?.getTracks().forEach((t) => t.stop());
    this.#stream = null;
    const dc = this.#dc;
    this.#dc = null;
    if (dc) {
      dc.onopen = null;
      dc.onclose = null;
      dc.onmessage = null;
      try {
        dc.close();
      } catch {
        // already closed
      }
    }
    const pc = this.#pc;
    this.#pc = null;
    if (pc) {
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.getSenders?.().forEach((s) => s.track?.stop());
      try {
        pc.close();
      } catch {
        // already closed
      }
    }
    const audio = this.#audio;
    this.#audio = null;
    if (audio) {
      try {
        audio.pause();
      } catch {
        // not playing
      }
      audio.srcObject = null;
    }
  }

  #set(patch: Partial<VoiceState>): void {
    if (this.#disposed) return;
    this.#state = {...this.#state, ...patch};
    this.#opts.onChange(this.#state);
  }
}
