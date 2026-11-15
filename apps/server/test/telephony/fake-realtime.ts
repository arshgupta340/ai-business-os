// A fake OpenAI Realtime socket for the AgentPhone realtime engine. No network: it answers session.update with
// session.updated and each response.create with the next scripted response.done.
import type { DuplexSocket, OpenAISocketFactory } from '../../src/voice/types';

type Json = Record<string, unknown>;
export type FakeCall = { name: string; args: unknown };
/** One scripted model response. `outputs` are the function call outputs the engine has sent so far, parsed. */
export type FakeStep = (ctx: { outputs: Json[]; userTexts: string[] }) =>
  | { text?: string; calls?: FakeCall[]; status?: string }
  | 'error' | 'close' | 'hang';

export interface FakeRealtime {
  factory: OpenAISocketFactory;
  push(...steps: FakeStep[]): void;
  /** Every event the engine sent, across sockets. */
  sent: Json[];
  userTexts: string[];
  outputs: Json[];
  sockets: number;
  open: number;
  /** The session.update the engine sent (instructions and tools). */
  session(): Json | undefined;
}

export function fakeRealtime(opts: { refuseOpen?: boolean; silentOpen?: boolean } = {}): FakeRealtime {
  const steps: FakeStep[] = [];
  const state: FakeRealtime = {
    factory: () => socket(),
    push: (...s) => { steps.push(...s); },
    sent: [], userTexts: [], outputs: [], sockets: 0, open: 0,
    session: () => state.sent.find((e) => e.type === 'session.update'),
  };
  let callSeq = 0;

  function socket(): DuplexSocket {
    state.sockets += 1;
    let isOpen = true;
    let onMessage: (raw: string) => void = () => undefined;
    let onClose: (code: number) => void = () => undefined;
    let onOpen: () => void = () => undefined;
    const emit = (ev: Json) => queueMicrotask(() => { if (isOpen) onMessage(JSON.stringify(ev)); });
    const s: DuplexSocket = {
      get isOpen() { return isOpen; },
      bufferedAmount: 0,
      send(data) {
        const ev = JSON.parse(data) as Json;
        state.sent.push(ev);
        if (ev.type === 'session.update') {
          if (opts.refuseOpen) emit({ type: 'error', error: { type: 'invalid_request_error', code: 'invalid_api_key' } });
          else if (!opts.silentOpen) emit({ type: 'session.updated' });
          return;
        }
        if (ev.type === 'conversation.item.create') {
          const item = ev.item as Json;
          if (item.type === 'message') state.userTexts.push(String(((item.content as Json[])[0] as Json).text));
          if (item.type === 'function_call_output') state.outputs.push(JSON.parse(String(item.output)) as Json);
          return;
        }
        if (ev.type === 'response.create') {
          const step = steps.shift();
          if (!step) { emit({ type: 'response.done', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'No script.' }] }] } }); return; }
          const r = step({ outputs: state.outputs, userTexts: state.userTexts });
          if (r === 'hang') return;
          if (r === 'error') { emit({ type: 'error', error: { type: 'server_error', code: 'server_error' } }); return; }
          if (r === 'close') { queueMicrotask(() => { isOpen = false; onClose(1006); }); return; }
          const output: Json[] = [];
          if (r.text !== undefined) output.push({ type: 'message', content: [{ type: 'output_text', text: r.text }] });
          for (const c of r.calls ?? []) output.push({ type: 'function_call', name: c.name, call_id: `fc_${++callSeq}`, arguments: JSON.stringify(c.args) });
          emit({ type: 'response.done', response: { status: r.status ?? 'completed', output } });
        }
      },
      close() { if (isOpen) { isOpen = false; queueMicrotask(() => onClose(1000)); } },
      terminate() { isOpen = false; },
      onOpen(fn) { onOpen = fn; queueMicrotask(() => { state.open += 1; onOpen(); }); },
      onMessage(fn) { onMessage = fn; },
      onClose(fn) { onClose = fn; },
      onError() { /* the fake never errors on its own */ },
    };
    return s;
  }
  return state;
}
