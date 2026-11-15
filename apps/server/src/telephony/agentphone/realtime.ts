// The fast turn engine for the AgentPhone path (D-12): one OpenAI Realtime session per call, in TEXT mode.
// AgentPhone does the listening, turn-taking and speaking and posts each caller turn as text; this engine
// sends that text as a user item into a session that lives for the whole call, runs the model's function
// calls through the call's own toolset (the same object every turn, so its quote and proposal guards hold),
// answers them, and returns the model's final text.
//
// The guards are the Twilio relay's (voice/relay.ts): only the tools the session capability check returned,
// the per-call cap on tool calls and on proposals, a deadline on every tool call, and log lines that carry
// fixed codes, tool names and timings only. The caller's words, the model's words and tool arguments are
// never logged (AGENTS rules 7 and 8). The socket is the relay's DuplexSocket, so tests use a fake.
import { CAPABILITIES, TOOL_CAPABILITY, ToolNameSchema, type ToolContext, type ToolFailure, type ToolInput, type ToolName } from '@abos/contracts';
import type { CancellableToolHandler } from '../../tools/real/types';
import { OAI_CLIENT, OAI_ITEM, OAI_SERVER } from '../../voice/constants';
import { DEFAULT_LIMITS, phoneToolDefinitions } from '../../voice/relay';
import type { DuplexSocket, OpenAISocketFactory } from '../../voice/types';

/** How long the session may take to open and confirm its settings. */
export const REALTIME_OPEN_TIMEOUT_MS = 5_000;
/** The hard bound on one turn inside the engine. Past it the session is closed and the call falls back. */
export const REALTIME_TURN_LIMIT_MS = 15_000;
/** About three minutes without a turn closes the session. */
export const REALTIME_IDLE_MS = 180_000;
/** Model responses one caller turn may take (each round answers the tool calls of the one before). */
export const MAX_ROUNDS_PER_TURN = 6;

const LIMIT_REACHED = 'The limit for this call is reached.';
const UNAVAILABLE = 'That information is not available right now.';
/**
 * What the model reads for a function call that an abandoned turn did not start. It must not read as an
 * outage: the old text ("This turn has ended", reason INTEGRATION_UNAVAILABLE) made the agent say the
 * ordering system was down (a call on 2026-11-14).
 */
export const TOOL_NOT_RUN = 'This tool call was not run because the caller spoke again first. Nothing is wrong with the system. Call the tool again now if it is still needed.';
const RECOVERABLE_ERRORS = new Set(['response_cancel_not_active', 'conversation_already_has_active_response']);

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined);
const str = (o: Json | undefined, k: string): string | undefined => (typeof o?.[k] === 'string' ? (o[k] as string) : undefined);
const failure = (reason: ToolFailure['reason'], message: string): ToolFailure => ({ ok: false, reason, message });
const isPropose = (t: ToolName) => t === 'propose_order' || t === 'propose_booking';
/** A stored proposal: ok with both IDs (a result with missing fields has neither). */
export const isStoredProposal = (r: unknown): boolean => { const o = obj(r); return o?.ok === true && typeof o.proposalId === 'string' && typeof o.approvalId === 'string'; };

/**
 * Adds a dollars string beside every amount in cents (a key ending in "Minor"), so the model reads the
 * amount instead of converting it. A text trial on 2026-11-14 read 55460 cents back as "fifty five dollars
 * and forty six cents". Only the copy the model reads is changed; the tool result itself is not.
 */
export function withDollars(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withDollars);
  const o = obj(v);
  if (!o) return v;
  const out: Json = {};
  for (const [k, val] of Object.entries(o)) {
    out[k] = withDollars(val);
    if (k.endsWith('Minor') && typeof val === 'number' && Number.isFinite(val)) out[`${k.slice(0, -'Minor'.length)}Dollars`] = (val / 100).toFixed(2);
  }
  return out;
}

export type ToolEvent = { tool: ToolName; args: unknown; result: unknown; ok: boolean; latencyMs: number };
export type RefusalCode = 'unknown_tool' | 'tool_not_allowed' | 'tool_call_limit' | 'proposal_limit';

export type RealtimeTurnResult =
  | { kind: 'reply'; text: string; toolCalls: number; tools: ToolEvent[] }
  /** The per-call cap on tool calls was reached: the call says goodbye and ends. */
  | { kind: 'tool_limit'; toolCalls: number; tools: ToolEvent[] };

export interface RealtimeCallDeps {
  socketFactory: OpenAISocketFactory;
  model: string;
  instructions: string;
  /** The tools checkSessionCapabilities returned for the pinned spec. Nothing else is callable. */
  tools: readonly ToolName[];
  handler: CancellableToolHandler;
  ctx: ToolContext;
  maxToolCalls?: number | undefined;
  maxProposals?: number | undefined;
  /** Overrides every tool's own capability timeout (tests). */
  toolTimeoutMs?: number | undefined;
  openTimeoutMs?: number | undefined;
  turnLimitMs?: number | undefined;
  idleMs?: number | undefined;
  /** After each tool result: stage updates. Its failure never fails the turn. */
  onToolResult?: ((e: ToolEvent) => Promise<void> | void) | undefined;
  /** A refused function call, by fixed code (guardrail.refused). */
  onRefused?: ((e: { reasonCode: RefusalCode; tool?: ToolName | undefined }) => void) | undefined;
  /** The session closed, with a fixed reason. */
  onClose?: ((why: string) => void) | undefined;
}

export interface TurnHooks {
  /** True once nobody will hear this turn: it starts no further tool call. */
  abandoned?: (() => boolean) | undefined;
  /** Called with each tool call the turn starts; settles when that call is over. */
  onToolCall?: ((settled: Promise<void>) => void) | undefined;
}

export interface RealtimeCall {
  readonly closed: boolean;
  /** Function calls the model made on this call, counted when they arrived. */
  readonly toolCallsSeen: number;
  turn(text: string, hooks?: TurnHooks): Promise<RealtimeTurnResult>;
  close(why: string): void;
}

export class RealtimeEngineError extends Error {
  constructor(readonly why: string) { super(`realtime engine: ${why}`); this.name = 'RealtimeEngineError'; }
}

type Pending = {
  resolve(r: RealtimeTurnResult): void;
  reject(e: RealtimeEngineError): void;
  rounds: number;
  toolCalls: number;
  tools: ToolEvent[];
  hooks: TurnHooks;
  busy: boolean;
  /** An answer with no words and no function call was asked for once more. */
  retriedEmpty: boolean;
};

/** Opens the session and waits until it confirms its settings. Rejects if it does not in time. */
export function openRealtimeCall(deps: RealtimeCallDeps): Promise<RealtimeCall> {
  const maxToolCalls = deps.maxToolCalls ?? DEFAULT_LIMITS.maxToolCalls;
  const maxProposals = deps.maxProposals ?? DEFAULT_LIMITS.maxProposals;
  const allowed = new Set<ToolName>(deps.tools);
  let socket: DuplexSocket;
  let closed = false;
  let ready = false;
  let pending: Pending | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  let toolCallsSeen = 0;
  const storedApprovals = new Set<string>();
  let uncertainProposals = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let turnTimer: ReturnType<typeof setTimeout> | undefined;
  const active = new Set<AbortController>();

  let openResolve!: (c: RealtimeCall) => void;
  let openReject!: (e: RealtimeEngineError) => void;
  const opened = new Promise<RealtimeCall>((res, rej) => { openResolve = res; openReject = rej; });

  const send = (msg: Json) => { if (!closed && socket.isOpen) socket.send(JSON.stringify(msg)); };

  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => close('idle'), deps.idleMs ?? REALTIME_IDLE_MS);
    (idleTimer as { unref?: () => void }).unref?.();
  };

  function close(why: string) {
    if (closed) return;
    closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (turnTimer) clearTimeout(turnTimer);
    for (const c of active) c.abort();
    active.clear();
    const p = pending;
    pending = undefined;
    p?.reject(new RealtimeEngineError(why));
    if (!ready) openReject(new RealtimeEngineError(why));
    try { socket?.close(); } catch { /* already closed */ }
    deps.onClose?.(why);
  }

  const finish = (r: RealtimeTurnResult) => {
    const p = pending;
    pending = undefined;
    if (turnTimer) clearTimeout(turnTimer);
    armIdle();
    p?.resolve(r);
  };

  async function runCall(p: Pending, call: Json): Promise<unknown> {
    const rawName = str(call, 'name') ?? '';
    const named = ToolNameSchema.safeParse(rawName);
    if (!named.success) { deps.onRefused?.({ reasonCode: 'unknown_tool' }); return failure('CAPABILITY_NOT_ALLOWED', 'There is no such tool.'); }
    const tool = named.data;
    if (!allowed.has(tool)) { deps.onRefused?.({ reasonCode: 'tool_not_allowed', tool }); return failure('CAPABILITY_NOT_ALLOWED', 'There is no such tool.'); }
    if (p.hooks.abandoned?.()) return failure('VALIDATION_FAILED', TOOL_NOT_RUN);
    let args: unknown;
    try {
      const raw = str(call, 'arguments') ?? '';
      args = raw.trim() === '' ? {} : JSON.parse(raw);
    } catch { return failure('VALIDATION_FAILED', 'The arguments were not valid JSON.'); }
    if (isPropose(tool) && storedApprovals.size + uncertainProposals >= maxProposals) {
      deps.onRefused?.({ reasonCode: 'proposal_limit', tool });
      return failure('VALIDATION_FAILED', `${LIMIT_REACHED} No more requests can be sent to the shop on this call.`);
    }
    const timeoutMs = deps.toolTimeoutMs ?? CAPABILITIES[TOOL_CAPABILITY[tool]].timeoutMs;
    const controller = new AbortController();
    active.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const t0 = Date.now();
    let unknownOutcome = false;
    const work = (async () => {
      const aborted = new Promise<ToolFailure>((resolve) => controller.signal.addEventListener('abort', () => { unknownOutcome = true; resolve(failure('INTEGRATION_UNAVAILABLE', UNAVAILABLE)); }, { once: true }));
      try {
        return await Promise.race([Promise.resolve().then(() => deps.handler.call(tool, args as ToolInput[ToolName], deps.ctx, { signal: controller.signal, timeoutMs })), aborted]);
      } catch {
        unknownOutcome = true;
        return failure('INTEGRATION_UNAVAILABLE', UNAVAILABLE);
      } finally {
        clearTimeout(timer);
        active.delete(controller);
      }
    })();
    p.hooks.onToolCall?.(work.then(() => undefined));
    const result = await work;
    if (isPropose(tool)) {
      if (isStoredProposal(result)) storedApprovals.add(String(obj(result)!.approvalId));
      // A proposal that timed out or threw may still have been stored, so it uses one place.
      else if (unknownOutcome) uncertainProposals += 1;
    }
    const event: ToolEvent = { tool, args, result, ok: obj(result)?.ok === true, latencyMs: Date.now() - t0 };
    p.tools.push(event);
    try { await deps.onToolResult?.(event); } catch { /* a stage write failure does not fail the turn */ }
    return result;
  }

  async function onResponseDone(ev: Json) {
    const p = pending;
    if (!p || p.busy) return;
    const response = obj(ev.response);
    const status = str(response, 'status');
    // A response that was cancelled, cut off or failed is not used, and its function calls are not run.
    if (status !== undefined && status !== 'completed') { close(`response_${status === 'cancelled' || status === 'incomplete' || status === 'failed' ? status : 'not_completed'}`); return; }
    const output = Array.isArray(response?.output) ? (response.output as unknown[]).map(obj).filter((o): o is Json => o !== undefined) : [];
    const text = output.filter((o) => o.type === 'message')
      .map((o) => (Array.isArray(o.content) ? (o.content as unknown[]).map((c) => str(obj(c), 'text') ?? str(obj(c), 'transcript') ?? '').join(' ') : ''))
      .join(' ').replace(/\s+/g, ' ').trim();
    const calls = output.filter((o) => o.type === OAI_ITEM.functionCall);
    if (calls.length === 0) {
      // No words and no function call (seen on a call on 2026-11-14, where the caller then heard "I did not
      // catch that"): the model is asked once more before the turn ends with nothing to say.
      if (text === '' && !p.retriedEmpty && !p.hooks.abandoned?.() && p.rounds < MAX_ROUNDS_PER_TURN) {
        p.retriedEmpty = true;
        p.rounds += 1;
        send({ type: OAI_CLIENT.responseCreate });
        return;
      }
      finish({ kind: 'reply', text, toolCalls: p.toolCalls, tools: p.tools });
      return;
    }
    p.busy = true;
    let limitHit = false;
    for (const call of calls) {
      if (closed || pending !== p) return;
      toolCallsSeen += 1;
      let result: unknown;
      if (toolCallsSeen > maxToolCalls) {
        limitHit = true;
        const named = ToolNameSchema.safeParse(str(call, 'name') ?? '');
        deps.onRefused?.({ reasonCode: 'tool_call_limit', tool: named.success ? named.data : undefined });
        result = failure('VALIDATION_FAILED', LIMIT_REACHED);
      } else {
        p.toolCalls += 1;
        result = await runCall(p, call);
      }
      if (closed || pending !== p) return;
      const callId = str(call, 'call_id');
      if (callId !== undefined) send({ type: OAI_CLIENT.itemCreate, item: { type: OAI_ITEM.functionCallOutput, call_id: callId, output: JSON.stringify(withDollars(result)) } });
    }
    p.busy = false;
    if (limitHit) { finish({ kind: 'tool_limit', toolCalls: p.toolCalls, tools: p.tools }); return; }
    // Nobody will hear this turn: it asks for no further response; the next turn answers the outputs.
    if (p.hooks.abandoned?.() || p.rounds >= MAX_ROUNDS_PER_TURN) { finish({ kind: 'reply', text, toolCalls: p.toolCalls, tools: p.tools }); return; }
    p.rounds += 1;
    send({ type: OAI_CLIENT.responseCreate });
  }

  const onMessage = (raw: string) => {
    if (closed) return;
    let ev: Json | undefined;
    try { ev = obj(JSON.parse(raw)); } catch { return; }
    if (!ev) return;
    if (ev.type === OAI_SERVER.sessionUpdated) {
      if (!ready) { ready = true; armIdle(); openResolve(api); }
      return;
    }
    if (ev.type === OAI_SERVER.responseDone) { void onResponseDone(ev).catch(() => close('tool_routing_failed')); return; }
    if (ev.type === OAI_SERVER.error) {
      const code = str(obj(ev.error), 'code') ?? '';
      if (ready && RECOVERABLE_ERRORS.has(code)) return;
      close('model_error');
    }
    // Every other event, the model's partial text included, is dropped unread.
  };

  const api: RealtimeCall = {
    get closed() { return closed; },
    get toolCallsSeen() { return toolCallsSeen; },
    turn(text, hooks = {}) {
      // One turn at a time on the session: a turn waits for the one before it to settle.
      const run = chain.then(() => new Promise<RealtimeTurnResult>((resolve, reject) => {
        if (closed) { reject(new RealtimeEngineError('closed')); return; }
        if (idleTimer) clearTimeout(idleTimer);
        pending = { resolve, reject, rounds: 1, toolCalls: 0, tools: [], hooks, busy: false, retriedEmpty: false };
        turnTimer = setTimeout(() => close('turn_limit'), deps.turnLimitMs ?? REALTIME_TURN_LIMIT_MS);
        (turnTimer as { unref?: () => void }).unref?.();
        send({ type: OAI_CLIENT.itemCreate, item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
        send({ type: OAI_CLIENT.responseCreate });
      }));
      chain = run.catch(() => undefined);
      return run;
    },
    close,
  };

  try {
    socket = deps.socketFactory({ model: deps.model });
  } catch {
    return Promise.reject(new RealtimeEngineError('socket_failed'));
  }
  const openTimer = setTimeout(() => { if (!ready) close('open_timeout'); }, deps.openTimeoutMs ?? REALTIME_OPEN_TIMEOUT_MS);
  (openTimer as { unref?: () => void }).unref?.();
  void opened.finally(() => clearTimeout(openTimer)).catch(() => undefined);
  socket.onOpen(() => {
    send({ type: OAI_CLIENT.sessionUpdate, session: { type: 'realtime', model: deps.model, output_modalities: ['text'], instructions: deps.instructions,
      tools: phoneToolDefinitions(deps.tools), tool_choice: 'auto' } });
  });
  socket.onMessage(onMessage);
  socket.onError(() => close('socket_error'));
  socket.onClose(() => close('socket_closed'));
  return opened;
}
