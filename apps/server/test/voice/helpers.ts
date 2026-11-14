// Fakes shared by the voice tests. No network, no provider.
import { vi } from 'vitest';
import type { AgentSpec, CallStatus, ToolHandler } from '@abos/contracts';
import type { CallsPort, DuplexSocket, VoiceLogger } from '../../src/voice/types';

export type Json = Record<string, unknown>;

export class FakeSocket implements DuplexSocket {
  isOpen = true;
  readonly sent: Json[] = [];
  private readonly handlers = {
    open: [] as (() => void)[],
    message: [] as ((d: string) => void)[],
    close: [] as ((c: number) => void)[],
    error: [] as ((e: Error) => void)[],
  };

  send(data: string): void {
    if (this.isOpen) this.sent.push(JSON.parse(data) as Json);
  }
  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    for (const f of this.handlers.close) f(1000);
  }
  onOpen(fn: () => void): void {
    this.handlers.open.push(fn);
  }
  onMessage(fn: (d: string) => void): void {
    this.handlers.message.push(fn);
  }
  onClose(fn: (c: number) => void): void {
    this.handlers.close.push(fn);
  }
  onError(fn: (e: Error) => void): void {
    this.handlers.error.push(fn);
  }

  // Test controls.
  open(): void {
    for (const f of this.handlers.open) f();
  }
  emit(msg: Json): void {
    for (const f of this.handlers.message) f(JSON.stringify(msg));
  }
  /** The other side closed the socket. */
  remoteClose(code = 1000): void {
    this.isOpen = false;
    for (const f of this.handlers.close) f(code);
  }
  ofType(type: string): Json[] {
    return this.sent.filter((m) => m.type === type || m.event === type);
  }
}

export function fakeLogger() {
  const lines: { level: string; data: Record<string, unknown>; msg: string }[] = [];
  const logger: VoiceLogger = {
    info: (data, msg) => lines.push({ level: 'info', data, msg }),
    warn: (data, msg) => lines.push({ level: 'warn', data, msg }),
    error: (data, msg) => lines.push({ level: 'error', data, msg }),
  };
  return { logger, lines };
}

export function fakeCalls(status: CallStatus | null = 'IN_PROGRESS') {
  const calls = {
    startCall: vi.fn<CallsPort['startCall']>(async () => ({ callId: 'call_test_01' })),
    getStatus: vi.fn<CallsPort['getStatus']>(async () => status),
    updateStage: vi.fn<CallsPort['updateStage']>(async () => undefined),
    endCall: vi.fn<CallsPort['endCall']>(async () => undefined),
  };
  return calls satisfies CallsPort;
}

export function fakeHandler(result: unknown = { ok: true, items: [] }) {
  const call = vi.fn(async () => result);
  return { handler: { toolset: 'real', call } as unknown as ToolHandler, call };
}

export function specWith(spec: AgentSpec, patch: Partial<AgentSpec>): AgentSpec {
  return { ...spec, ...patch };
}

/** Base64 G.711 u-law of `ms` milliseconds of silence. */
export function ulaw(ms: number): string {
  return Buffer.alloc(ms * 8, 0xff).toString('base64');
}
