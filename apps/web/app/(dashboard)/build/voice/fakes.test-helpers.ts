/**
 * Fakes for the voice tests: microphone, RTCPeerConnection, data channel,
 * audio element, fetch and timers. Each step is written to `log` so a test
 * can check the order (microphone before mint before the SDP post).
 */
import {ApiError} from '@/lib/api';
import type {MintedSecret, VoiceDeps} from './voiceSession';

export const SECRET = 'ek_test_SECRET_value_123';
export const ANSWER_SDP = 'v=0 answer';

export class FakeTrack {
  kind = 'audio';
  enabled = true;
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

export class FakeStream {
  tracks = [new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
}

export class FakeDataChannel {
  readyState: 'connecting' | 'open' | 'closed' = 'connecting';
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: {data: unknown}) => void) | null = null;
  constructor(readonly label: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 'closed';
  }
  open() {
    this.readyState = 'open';
    this.onopen?.();
  }
  remoteClose() {
    this.readyState = 'closed';
    this.onclose?.();
  }
  emit(event: unknown) {
    this.onmessage?.({data: JSON.stringify(event)});
  }
  sentEvents(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s));
  }
}

export class FakePeerConnection {
  connectionState = 'new';
  ontrack: ((event: {streams: unknown[]}) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  added: FakeTrack[] = [];
  channels: FakeDataChannel[] = [];
  closed = false;
  local: unknown = null;
  remote: {type: string; sdp: string} | null = null;
  constructor(private log: string[]) {}
  addTrack(track: FakeTrack) {
    this.log.push('addTrack');
    this.added.push(track);
    return {track};
  }
  getSenders() {
    return this.added.map((track) => ({track}));
  }
  createDataChannel(label: string) {
    this.log.push(`createDataChannel:${label}`);
    const dc = new FakeDataChannel(label);
    this.channels.push(dc);
    return dc;
  }
  async createOffer() {
    this.log.push('createOffer');
    return {type: 'offer', sdp: 'v=0 offer'};
  }
  async setLocalDescription(d: unknown) {
    this.log.push('setLocalDescription');
    this.local = d;
  }
  async setRemoteDescription(d: {type: string; sdp: string}) {
    this.log.push('setRemoteDescription');
    this.remote = d;
  }
  close() {
    this.closed = true;
    this.connectionState = 'closed';
  }
  drop() {
    this.connectionState = 'failed';
    this.onconnectionstatechange?.();
  }
}

export class FakeAudio {
  autoplay = false;
  srcObject: unknown = null;
  paused = true;
  pause() {
    this.paused = true;
  }
}

export interface FakeOptions {
  supported?: boolean;
  micError?: {name: string};
  /** Resolve the microphone by hand with `releaseMic()`. */
  holdMic?: boolean;
  mintError?: unknown;
  holdMint?: boolean;
  expiresInMs?: number;
  sdpStatus?: number;
  fetchThrows?: boolean;
}

export function createFakes(options: FakeOptions = {}) {
  const log: string[] = [];
  const streams: FakeStream[] = [];
  const pcs: FakePeerConnection[] = [];
  const audios: FakeAudio[] = [];
  const fetchCalls: Array<{url: string; init: RequestInit}> = [];
  const timers: Array<{fn: () => void; ms: number; cleared: boolean}> = [];
  let now = Date.parse('2026-11-14T10:00:00Z');
  let releaseMic: () => void = () => undefined;
  let releaseMint: () => void = () => undefined;

  const deps: VoiceDeps = {
    isSupported: () => options.supported ?? true,
    getUserMedia: (constraints) => {
      log.push(`getUserMedia:${JSON.stringify(constraints)}`);
      if (options.micError) return Promise.reject(Object.assign(new Error('mic'), options.micError));
      const stream = new FakeStream();
      streams.push(stream);
      if (options.holdMic) {
        return new Promise((resolve) => {
          releaseMic = () => resolve(stream as unknown as MediaStream);
        });
      }
      return Promise.resolve(stream as unknown as MediaStream);
    },
    createPeerConnection: () => {
      log.push('createPeerConnection');
      const pc = new FakePeerConnection(log);
      pcs.push(pc);
      return pc as unknown as RTCPeerConnection;
    },
    createAudioElement: () => {
      const audio = new FakeAudio();
      audios.push(audio);
      return audio as unknown as HTMLAudioElement;
    },
    fetch: async (url, init) => {
      log.push('fetch');
      fetchCalls.push({url, init});
      if (options.fetchThrows) throw new TypeError('Failed to fetch');
      const status = options.sdpStatus ?? 201;
      return new Response(status >= 200 && status < 300 ? ANSWER_SDP : 'provider error body', {status});
    },
    now: () => now,
    setTimeout: (fn, ms) => {
      const timer = {fn, ms, cleared: false};
      timers.push(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      (handle as {cleared: boolean}).cleared = true;
    },
  };

  const mint = (): Promise<MintedSecret> => {
    log.push('mint');
    if (options.mintError) return Promise.reject(options.mintError);
    const minted = {clientSecret: SECRET, expiresAt: new Date(now + (options.expiresInMs ?? 60_000)).toISOString()};
    if (options.holdMint) {
      return new Promise((resolve) => {
        releaseMint = () => resolve(minted);
      });
    }
    return Promise.resolve(minted);
  };

  return {
    deps,
    mint,
    log,
    streams,
    pcs,
    audios,
    fetchCalls,
    timers,
    advance: (ms: number) => {
      now += ms;
    },
    releaseMic: () => releaseMic(),
    releaseMint: () => releaseMint(),
    get pc() {
      return pcs[pcs.length - 1];
    },
    get dc() {
      const pc = pcs[pcs.length - 1];
      return pc?.channels[pc.channels.length - 1];
    },
    get tracks() {
      return streams.flatMap((s) => s.tracks);
    },
  };
}

export function apiError(code: 'INTEGRATION_UNAVAILABLE' | 'RATE_LIMITED' | 'NOT_FOUND', details?: Record<string, unknown>) {
  return new ApiError({code, message: 'refused', status: code === 'RATE_LIMITED' ? 429 : 503, retryable: true, details, kind: 'http'});
}

/** Lets pending promise callbacks run. */
export async function flush(times = 10) {
  for (let i = 0; i < times; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
