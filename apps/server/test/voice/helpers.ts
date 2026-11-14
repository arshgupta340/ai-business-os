// Fakes shared by the voice tests. No network, no provider.
import { vi } from 'vitest';
import type { AgentSpec, CallStatus, ToolHandler } from '@abos/contracts';
import { pizzaVerifiedFacts } from '@abos/contracts/fixtures';
import type { CallsPort, DuplexSocket, FactsSnapshot, VoiceEventsPort, VoiceLogger, VoiceToolset } from '../../src/voice/types';

export type Json = Record<string, unknown>;

export class FakeSocket implements DuplexSocket {
  isOpen = true;
  bufferedAmount = 0;
  terminated = false;
  readonly sent: Json[] = [];
  private readonly handlers = {
    open: [] as (() => void)[],
    message: [] as ((d: string) => void)[],
    close: [] as ((c: number) => void)[],
    error: [] as ((e: Error) => void)[],
  };

  /** Plays the Twilio side: after a `clear`, echo every outstanding mark, as real Twilio does. */
  echoMarksOnClear = false;
  /** Marks sent and not yet echoed back. */
  readonly pendingMarks: string[] = [];

  send(data: string): void {
    if (!this.isOpen) return;
    const msg = JSON.parse(data) as Json;
    this.sent.push(msg);
    if (msg.event === 'mark') this.pendingMarks.push(String((msg.mark as Json).name));
    if (msg.event === 'clear' && this.echoMarksOnClear) queueMicrotask(() => this.ackMarks());
  }

  /** Twilio confirms playback of everything sent so far. */
  ackMarks(): void {
    for (const name of this.pendingMarks.splice(0)) for (const f of this.handlers.message) f(JSON.stringify({ event: 'mark', mark: { name } }));
  }
  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    for (const f of this.handlers.close) f(1000);
  }
  terminate(): void {
    this.terminated = true;
    this.isOpen = false;
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
  fail(err: Error): void {
    for (const f of this.handlers.error) f(err);
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
    findByProviderCallId: vi.fn<CallsPort['findByProviderCallId']>(async () => null),
    startCall: vi.fn<CallsPort['startCall']>(async () => ({ callId: 'call_test_01' })),
    getStatus: vi.fn<CallsPort['getStatus']>(async () => status),
    updateStage: vi.fn<CallsPort['updateStage']>(async () => undefined),
    endCall: vi.fn<CallsPort['endCall']>(async () => undefined),
  };
  return calls satisfies CallsPort;
}

export function fakeEvents() {
  const events = {
    webhookRejected: vi.fn<VoiceEventsPort['webhookRejected']>(async () => undefined),
    guardrailRefused: vi.fn<VoiceEventsPort['guardrailRefused']>(async () => undefined),
  };
  return events satisfies VoiceEventsPort;
}

export function fakeToolset(result: unknown = { ok: true, items: [] }) {
  const call = vi.fn(async (..._args: unknown[]): Promise<unknown> => result);
  const dispose = vi.fn();
  const toolset: VoiceToolset = { handler: { toolset: 'real', call } as unknown as ToolHandler, dispose };
  return { toolset, call, dispose };
}

export function specWith(spec: AgentSpec, patch: Partial<AgentSpec>): AgentSpec {
  return { ...spec, ...patch };
}

export const PIZZA_SNAPSHOT: FactsSnapshot = {
  facts: pizzaVerifiedFacts.flatMap((f) => (f.kind === 'menu_item' ? [] : [{ kind: f.kind, key: f.key, value: f.value, version: f.version }])),
  timezone: 'America/Los_Angeles',
};

/** Base64 G.711 u-law of `ms` milliseconds of silence. */
export function ulaw(ms: number): string {
  return Buffer.alloc(ms * 8, 0xff).toString('base64');
}
