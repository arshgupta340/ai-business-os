// One phone call: Twilio Media Stream <-> this server <-> OpenAI Realtime (FLOWS B4 to B30).
// Audio is relayed as G.711 u-law both ways and never stored. No transcript is read or stored:
// every Realtime event other than the few below is dropped unread. Every log line goes through
// `safeLogger` (logic.ts), and only fixed codes, validated tool names and timings are logged.
// Every stage has a deadline, every queue a bound, and every exit runs one idempotent shutdown.
import WebSocket from 'ws';
import type { CancellableToolHandler } from '../tools/real/types';
import {
  ACTIVITY_EVENT_PAYLOADS,
  CAPABILITIES,
  REALTIME_MODEL,
  TOOL_CAPABILITY,
  ToolNameSchema,
  assertToolCapabilities,
  capabilitiesForBundle,
  isToolEffect,
  toolDefinitionsFor,
  toolsForCapabilities,
  validateSpecCapabilities,
  type ActivityEventPayloads,
  type AgentSpec,
  type AgentTemplate,
  type CallEndReason,
  type CallStage,
  type CapabilityId,
  type MessageChannelSetting,
  type ToolContext,
  type ToolDefinition,
  type ToolFailure,
  type ToolInput,
  type ToolName,
} from '@abos/contracts';
import { AUDIO_FORMAT, OAI_CLIENT, OAI_ITEM, OAI_SERVER, OPENAI_REALTIME_URL, STREAM_TOKEN_PARAM, TURN_DETECTION, TWILIO_EVENT, VOICE } from './constants';
import { PlaybackTracker, StreamTokenStore, TimingTracker, errorInfo, safeLogger, spokenText, ulawBase64DurationMs } from './logic';
import { buildInstructions, decisionInstruction, pendingGoodbyeInstruction } from './prompt';
import type {
  CallDecision,
  CallDecisionsPort,
  CallFinishesPort,
  CallsPort,
  DuplexSocket,
  OpenAISocketFactory,
  PinnedCall,
  RelayLimits,
  VoiceEventsPort,
  VoiceLogger,
  VoiceToolset,
  VoiceToolsetFactory,
} from './types';

type JsonObject = Record<string, unknown>;

function asObject(v: unknown): JsonObject | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : undefined;
}
function str(o: JsonObject | undefined, key: string): string | undefined {
  const v = o?.[key];
  return typeof v === 'string' ? v : undefined;
}
function parseJson(raw: string): JsonObject | undefined {
  try {
    return asObject(JSON.parse(raw));
  } catch {
    return undefined;
  }
}
/** Untrusted provider metadata maps to fixed known values only. */
const KNOWN_CODES = new Set(['completed', 'cancelled', 'failed', 'incomplete', 'invalid_request_error', 'server_error', 'invalid_api_key', 'authentication_error', 'permission_denied', 'rate_limit_exceeded', 'response_cancel_not_active', 'conversation_already_has_active_response', 'CAPABILITY_NOT_ALLOWED', 'VALIDATION_FAILED', 'INTEGRATION_UNAVAILABLE', 'NOT_FOUND', 'ITEM_UNAVAILABLE', 'QUOTE_EXPIRED', 'SLOT_CONFLICT']);
function code(v: unknown): string {
  return typeof v === 'string' && KNOWN_CODES.has(v) ? v : 'unknown_error';
}
const RECOVERABLE_ERRORS = new Set(['response_cancel_not_active', 'conversation_already_has_active_response']);

/** Resolves with the promise's value, or `fallback` once `ms` passes. Never rejects. */
export async function withDeadline<T, F>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([p.catch(() => fallback), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Capability check (AGENTS rule 6) ----------

/** The propose capability that authorizes each executor bundle an agent may carry. */
const AGENT_BUNDLES = [
  { propose: 'order.propose', bundle: 'order_bundle' },
  { propose: 'booking.propose', bundle: 'booking_bundle' },
] as const;

export type SessionCapabilityCheck = { ok: true; tools: ToolName[] } | { ok: false; unknown: string[]; notAllowed: string[] };

/**
 * Decides which tools the session gets for a pinned spec, or refuses the session.
 *
 * `AgentSpec.capabilities` holds the read and propose tools plus the executor bundle of each
 * propose capability (for example `order.checkout.prepare` with `order.propose`). Those bundle
 * capabilities never become tools. Any other write or external_message capability, or an id not
 * in the registry, refuses the whole session. The resulting tool list is asserted read or propose only.
 */
export function checkSessionCapabilities(spec: Pick<AgentSpec, 'capabilities'>): SessionCapabilityCheck {
  const known = validateSpecCapabilities(spec.capabilities);
  if (!known.ok) return { ok: false, unknown: known.unknown, notAllowed: [] };
  const caps: readonly CapabilityId[] = known.capabilities;
  const bundled = new Set<CapabilityId>();
  for (const { propose, bundle } of AGENT_BUNDLES) {
    if (caps.includes(propose)) for (const c of capabilitiesForBundle(bundle)) bundled.add(c);
  }
  const notAllowed = caps.filter((c) => !isToolEffect(CAPABILITIES[c].effect) && !bundled.has(c));
  if (notAllowed.length > 0) return { ok: false, unknown: [], notAllowed };
  const tools = toolsForCapabilities(caps);
  try {
    assertToolCapabilities(tools.map((t) => TOOL_CAPABILITY[t]));
  } catch {
    return { ok: false, unknown: [], notAllowed: tools.map((t) => TOOL_CAPABILITY[t]) };
  }
  return { ok: true, tools };
}

// ---------- Session config ----------

export type SessionUpdateEvent = {
  type: 'session.update';
  session: {
    type: 'realtime';
    model: string;
    output_modalities: ['audio'];
    instructions: string;
    audio: {
      input: { format: typeof AUDIO_FORMAT; turn_detection: typeof TURN_DETECTION };
      output: { format: typeof AUDIO_FORMAT; voice: string };
    };
    tools: ToolDefinition[];
    tool_choice: 'auto';
  };
};

/** The spike's session shape, proven against gpt-realtime-2.1, with only the allowed tools. */
export function buildSessionUpdate(args: { model: string; voice: string; instructions: string; tools: readonly ToolName[] }): SessionUpdateEvent {
  return {
    type: OAI_CLIENT.sessionUpdate,
    session: {
      type: 'realtime',
      model: args.model,
      output_modalities: ['audio'],
      instructions: args.instructions,
      audio: {
        input: { format: AUDIO_FORMAT, turn_detection: TURN_DETECTION },
        output: { format: AUDIO_FORMAT, voice: args.voice },
      },
      tools: toolDefinitionsFor(args.tools),
      tool_choice: 'auto',
    },
  };
}

// ---------- Call stage ----------

const isProposal = (r: JsonObject | undefined) => r?.ok === true && typeof r.proposalId === 'string' && typeof r.approvalId === 'string';

/** The call's conversation stage after a tool result (SPEC 2.4, FLOWS B6 to B14 and C1 to C5). */
export function nextStage(template: AgentTemplate, current: CallStage, tool: ToolName, result: unknown): CallStage {
  if (current === 'CUSTOMER_CONFIRMED') return current;
  const r = asObject(result);
  const ok = r?.ok === true;
  switch (tool) {
    case 'read_catalog':
    case 'read_business_facts':
      return template !== 'appointment_booker' && current === 'CALL_STARTED' ? 'COLLECTING' : current;
    case 'quote_order':
      if (ok) return 'VALIDATING';
      return str(r, 'reason') === 'ITEM_UNAVAILABLE' ? 'UNAVAILABLE' : current;
    case 'propose_order':
      return isProposal(r) ? 'CUSTOMER_CONFIRMED' : current;
    case 'get_order_status':
      return current;
    case 'read_calendar_availability':
      return ok ? 'SLOT_SEARCH' : current;
    case 'propose_booking':
      return isProposal(r) ? 'CUSTOMER_CONFIRMED' : 'PROPOSAL';
  }
}

/** The stage a session starts in: booking calls begin in INQUIRY (FLOWS C1). */
export function initialStage(template: AgentTemplate): CallStage {
  return template === 'appointment_booker' ? 'INQUIRY' : 'CALL_STARTED';
}

// ---------- Sockets ----------

/** Adapts a `ws` socket to the relay's socket surface. A failed send is reported as a socket error. */
export function adaptWs(ws: WebSocket): DuplexSocket {
  const errorHandlers: ((err: Error) => void)[] = [];
  ws.on('error', (err: Error) => {
    for (const f of errorHandlers) f(err);
  });
  return {
    get isOpen() {
      return ws.readyState === WebSocket.OPEN;
    },
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    send: (data) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(data, (err) => {
        if (err) for (const f of errorHandlers) f(err);
      });
    },
    close: () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    },
    terminate: () => {
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    },
    onOpen: (fn) => {
      if (ws.readyState === WebSocket.OPEN) queueMicrotask(fn);
      else ws.on('open', fn);
    },
    onMessage: (fn) => ws.on('message', (raw: WebSocket.RawData) => fn(Array.isArray(raw) ? Buffer.concat(raw).toString() : Buffer.from(raw as ArrayBuffer).toString())),
    onClose: (fn) => ws.on('close', (c: number) => fn(c)),
    onError: (fn) => {
      errorHandlers.push(fn);
    },
  };
}

/** The production OpenAI socket factory. The key never leaves this closure except in the auth header. */
export function createWsOpenAISocketFactory(args: { apiKey: string; url?: string | undefined; handshakeTimeoutMs?: number | undefined }): OpenAISocketFactory {
  const base = args.url ?? OPENAI_REALTIME_URL;
  return ({ model }) =>
    adaptWs(new WebSocket(`${base}?model=${encodeURIComponent(model)}`, { headers: { Authorization: `Bearer ${args.apiKey}` }, handshakeTimeout: args.handshakeTimeoutMs ?? 8000 }));
}

// ---------- The relay ----------

export const DEFAULT_LIMITS: RelayLimits = {
  startTimeoutMs: 10_000,
  setupTimeoutMs: 10_000,
  idleTimeoutMs: 30_000,
  maxSessionMs: 20 * 60_000,
  statusPollMs: 15_000,
  cleanupTimeoutMs: 5_000,
  closeGraceMs: 2_000,
  maxPendingResponses: 4,
  // About 30 seconds of 20 ms chunks that Twilio has not confirmed as played.
  maxPendingMarks: 1500,
  maxBufferedBytes: 512 * 1024,
  pendingWaitMs: 90_000,
  goodbyeMaxMs: 20_000,
};

/** Model error events tolerated after the session is ready before the call is ended. */
const MAX_MODEL_ERRORS = 3;

export type PhoneRelayDeps = {
  phone: DuplexSocket;
  tokens: StreamTokenStore<PinnedCall>;
  calls: CallsPort;
  events: VoiceEventsPort;
  decisions?: CallDecisionsPort | undefined;
  finishes?: CallFinishesPort | undefined;
  toolsetFactory: VoiceToolsetFactory;
  openaiSocketFactory: OpenAISocketFactory;
  messageChannel: MessageChannelSetting;
  logger: VoiceLogger;
  model?: string | undefined;
  voice?: string | undefined;
  redactSecrets?: readonly string[] | undefined;
  now?: (() => number) | undefined;
  limits?: Partial<RelayLimits> | undefined;
  /** Human fallback (B-28 hook points). Resolves true only when the call was handed to a person. */
  fallback?: RelayFallback | undefined;
};

/** Trusted relay outcomes only (B-28 NOTES, voice wiring 3). Never caller text. */
export type RelayFallback = (input: {
  businessId: string; callId: string; providerCallId: string;
  signals: { modelSessionFailed?: boolean; modelSessionReady?: boolean; phoneLineOverloaded?: boolean; guardrailRefusals?: number };
}) => Promise<boolean>;

/** How the relay finished. A null `endReason` means the call row was not changed. */
export type RelayOutcome = { endReason: CallEndReason | null; why: string };

const toolFailure = (reason: ToolFailure['reason'], message: string): ToolFailure => ({ ok: false, reason, message });
const UNAVAILABLE = 'That information is not available right now.';

export function runPhoneRelay(deps: PhoneRelayDeps): { done: Promise<RelayOutcome> } {
  const { phone } = deps;
  const limits: RelayLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  const now = deps.now ?? Date.now;
  const model = deps.model ?? REALTIME_MODEL;
  const secrets = [...(deps.redactSecrets ?? [])];
  const logger = safeLogger(deps.logger, secrets);

  let resolveDone: (o: RelayOutcome) => void = () => undefined;
  const done = new Promise<RelayOutcome>((r) => {
    resolveDone = r;
  });

  let pinned: PinnedCall | undefined;
  let streamSid: string | undefined;
  let openai: DuplexSocket | undefined;
  let toolset: VoiceToolset | undefined;
  let allowedTools: ToolName[] = [];
  let stage: CallStage = 'CALL_STARTED';
  let stageChain: Promise<void> = Promise.resolve();
  let toolChain: Promise<void> = Promise.resolve();
  let pendingResponses = 0;
  let sessionReady = false;
  let closed = false;
  let finishing: { generation: number; responseId?: string; complete: boolean } | undefined;
  let finishGeneration = 0;
  const finishTimers = new Set<ReturnType<typeof setTimeout>>();
  const activeInvocations = new Set<AbortController>();
  let unsubscribeFinish: (() => void) | undefined;
  let phoneClosed = false;
  let modelClosed = false;
  let closeGrace: ReturnType<typeof setTimeout> | undefined;
  let modelErrors = 0;
  let droppedEarlyChunks = 0;
  let bargeIns = 0;
  let toolCalls = 0;
  let startedAt = now();
  let unsubscribe: (() => void) | undefined;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const playback = new PlaybackTracker();
  const timing = new TimingTracker();

  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    (t as { unref?: () => void }).unref?.();
    timers.add(t);
    return t;
  };
  const cancel = (t: ReturnType<typeof setTimeout> | undefined) => {
    if (t === undefined) return;
    clearTimeout(t);
    timers.delete(t);
  };

  const tag = (): JsonObject => (pinned ? { callId: pinned.callId, agentVersionId: pinned.agentVersionId } : {});
  const sendTwilio = (msg: JsonObject) => phone.send(JSON.stringify(msg));
  const sendOpenAI = (msg: JsonObject) => {
    if (!closed && openai?.isOpen) openai.send(JSON.stringify(msg));
  };

  /**
   * B-28 hook: before failing the call for a pre-ready model failure or phone back-pressure, offer the
   * call to the human fallback router. A handoff ends the relay without a terminal call write; the
   * verified Twilio status callback records the outcome. Otherwise the call fails as before.
   */
  let handingOff = false;
  const failOrHandOff = (why: string, signals: Parameters<RelayFallback>[0]['signals']) => {
    const call = pinned;
    if (closed || handingOff) return;
    if (deps.fallback === undefined || call === undefined) { shutdown('failed', why); return; }
    handingOff = true;
    void deps.fallback({ businessId: call.businessId, callId: call.callId, providerCallId: call.providerCallId, signals })
      .catch(() => false)
      .then((handed) => { handingOff = false; shutdown(handed ? null : 'failed', handed ? `handed to a person: ${why}` : why); });
  };

  const shutdown = (endReason: CallEndReason | null, why: string) => {
    if (closed) return;
    closed = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    unsubscribe?.();
    unsubscribeFinish?.();
    for (const controller of activeInvocations) controller.abort();
    activeInvocations.clear();
    playback.clear();
    toolset?.dispose();
    if (pinned !== undefined) deps.tokens.end(pinned.providerCallId);
    const s = timing.summary();
    logger.info(
      { ...tag(), why, endReason, durationMs: now() - startedAt, connectToFirstAudioMs: s.connectToFirstAudioMs, turnsMs: s.turns, p50Ms: s.p50, p95Ms: s.p95, maxMs: s.max, toolCalls, bargeIns, droppedEarlyChunks },
      'voice: call ended',
    );
    openai?.close();
    phone.close();
    // A peer that ignores the close is terminated after the grace period.
    if (!phoneClosed || (openai !== undefined && !modelClosed)) {
      closeGrace = setTimeout(() => {
        openai?.terminate();
        phone.terminate();
      }, limits.closeGraceMs);
      (closeGrace as { unref?: () => void }).unref?.();
    }
    const call = pinned;
    if (call !== undefined && endReason !== null) {
      // Pending stage writes land first; the end itself is bounded so `done` always settles.
      const ending = stageChain.then(() => deps.calls.endCall(call.callId, endReason));
      void withDeadline(ending, limits.cleanupTimeoutMs, 'timeout' as const).then((r) => {
        if (r === 'timeout') logger.error({ ...tag() }, 'voice: ending the call did not finish in time');
        resolveDone({ endReason, why });
      });
    } else {
      resolveDone({ endReason, why });
    }
  };

  const setStage = (next: CallStage) => {
    if (closed || pinned === undefined || next === stage) return;
    stage = next;
    const callId = pinned.callId;
    // Serialized and skipped once the call has ended, so writes never land out of order or late.
    stageChain = stageChain.then(async () => {
      if (closed) return;
      const r = await withDeadline(deps.calls.updateStage(callId, next), limits.cleanupTimeoutMs, 'failed' as const);
      if (r === 'failed') logger.error({ ...tag(), stage: next }, 'voice: could not update call stage');
    });
  };

  const guardrail = (payload: ActivityEventPayloads['guardrail.refused']) => {
    if (pinned === undefined) return;
    const parsed = ACTIVITY_EVENT_PAYLOADS['guardrail.refused'].safeParse(payload);
    if (!parsed.success) return;
    void withDeadline(deps.events.guardrailRefused({ businessId: pinned.businessId, payload: parsed.data }), limits.cleanupTimeoutMs, 'failed' as const).then((r) => {
      if (r === 'failed') logger.error({ ...tag() }, 'voice: could not write guardrail.refused');
    });
  };

  /** Only fixed server instructions are injected, with emphasis stripped before speech. */
  const instruct = (text: string, generation?: number) => {
    sendOpenAI({ type: OAI_CLIENT.itemCreate, item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: spokenText(text) }] } });
    sendOpenAI({ type: OAI_CLIENT.responseCreate, ...(generation === undefined ? {} : { response: { metadata: { voiceFinishGeneration: String(generation) } } }) });
  };

  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  let proposal: { proposalId: string; approvalId: string; channel: MessageChannelSetting } | undefined;

  const invalidateFinish = () => {
    finishGeneration++;
    finishing = undefined;
    for (const t of finishTimers) cancel(t);
    finishTimers.clear();
  };
  const finishLater = (ms: number, fn: () => void) => {
    const t = later(ms, () => { finishTimers.delete(t); fn(); });
    finishTimers.add(t);
  };
  const beginFinish = (responseId?: string) => {
    invalidateFinish();
    const generation = finishGeneration;
    finishing = { generation, complete: false, ...(responseId === undefined ? {} : { responseId }) };
    finishLater(limits.goodbyeMaxMs, () => {
      if (finishing?.generation === generation) shutdown('completed', 'goodbye time limit');
    });
    return generation;
  };
  const finishWhenPlayed = () => {
    if (!closed && finishing?.complete && !playback.hasPendingAudio) shutdown('completed', 'goodbye played');
  };

  const onProposed = (result: JsonObject) => {
    if (pinned === undefined) return;
    cancel(pendingTimer);
    invalidateFinish();
    // Until trusted consent is wired, the real toolset always creates QR-only proposals.
    proposal = { proposalId: String(result.proposalId), approvalId: String(result.approvalId), channel: 'qr_only' };
    const call = pinned;
    pendingTimer = later(limits.pendingWaitMs, () => {
      pendingTimer = undefined;
      if (closed) return;
      const generation = beginFinish();
      instruct(pendingGoodbyeInstruction(call.spec.template, proposal?.channel ?? 'qr_only', call.businessName), generation);
    });
    if (deps.decisions !== undefined && unsubscribe === undefined) {
      unsubscribe = deps.decisions.subscribe(call.callId, (decision: CallDecision) => {
        if (closed || proposal === undefined || decision.proposalId !== proposal.proposalId || decision.approvalId !== proposal.approvalId) return;
        cancel(pendingTimer); pendingTimer = undefined;
        invalidateFinish();
        sendOpenAI({ type: 'response.cancel' });
        logger.info({ ...tag(), state: decision.kind }, 'voice: owner decision instruction queued');
        instruct(decisionInstruction(call.spec.template, decision, proposal.channel));
      });
    }
  };

  const runFunctionCall = async (name: string, argsJson: string): Promise<{ result: unknown; tool: ToolName | null }> => {
    const parsedName = ToolNameSchema.safeParse(name);
    if (!parsedName.success) {
      // The name came from the model: it is never logged or stored, only its length.
      logger.warn({ ...tag(), tool: 'unknown_tool', nameLength: name.length }, 'voice: model asked for an unknown tool');
      guardrail({ callId: pinned?.callId, rule: 'unsupported_request', reasonCode: 'unknown_tool' });
      return { result: toolFailure('CAPABILITY_NOT_ALLOWED', 'There is no such tool.'), tool: null };
    }
    const tool = parsedName.data;
    if (!allowedTools.includes(tool) || toolset === undefined || pinned === undefined) {
      guardrail({ callId: pinned?.callId, rule: 'unsupported_request', reasonCode: 'tool_not_allowed', toolName: tool });
      return { result: toolFailure('CAPABILITY_NOT_ALLOWED', 'There is no such tool.'), tool };
    }
    let args: unknown;
    try {
      args = argsJson.trim() === '' ? {} : JSON.parse(argsJson);
    } catch {
      return { result: toolFailure('VALIDATION_FAILED', 'The arguments were not valid JSON.'), tool };
    }
    const ctx: ToolContext = { businessId: pinned.businessId, agentVersionId: pinned.agentVersionId, callId: pinned.callId, correlationId: pinned.callId };
    const timeoutMs = limits.toolTimeoutMs ?? CAPABILITIES[TOOL_CAPABILITY[tool]].timeoutMs;
    const handler = toolset.handler as CancellableToolHandler;
    const controller = new AbortController();
    activeInvocations.add(controller);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let result: unknown;
    try {
      const aborted = new Promise<ToolFailure>((resolve) => controller.signal.addEventListener('abort', () => resolve(toolFailure('INTEGRATION_UNAVAILABLE', UNAVAILABLE)), { once: true }));
      result = await Promise.race([
        Promise.resolve().then(() => handler.call(tool, args as ToolInput[ToolName], ctx, { signal: controller.signal, timeoutMs })),
        aborted,
      ]);
    } catch {
      result = toolFailure('INTEGRATION_UNAVAILABLE', UNAVAILABLE);
    } finally {
      clearTimeout(timeout);
      activeInvocations.delete(controller);
    }
    const r = asObject(result);
    if (r?.ok === false && r.reason === 'CAPABILITY_NOT_ALLOWED') guardrail({ callId: pinned.callId, rule: 'no_cross_business', reasonCode: 'CAPABILITY_NOT_ALLOWED', toolName: tool });
    return { result, tool };
  };

  const handleCalls = async (calls: JsonObject[]) => {
    for (const call of calls) {
      if (closed) return;
      const callId = str(call, 'call_id');
      const t0 = now();
      const { result, tool } = await runFunctionCall(str(call, 'name') ?? '', str(call, 'arguments') ?? '{}');
      // A result that arrives after the call ended changes nothing.
      if (closed || pinned === undefined) return;
      toolCalls++;
      const r = asObject(result);
      // Arguments are never logged: they can hold a name and a phone number.
      logger.info({ ...tag(), tool: tool ?? 'unknown_tool', ok: r?.ok === true, reason: code(r?.reason), latencyMs: now() - t0 }, 'voice: tool call');
      if (tool !== null) {
        setStage(nextStage(pinned.spec.template, stage, tool, result));
        if ((tool === 'propose_order' || tool === 'propose_booking') && isProposal(r) && r !== undefined) onProposed(r);
      }
      if (callId !== undefined) sendOpenAI({ type: OAI_CLIENT.itemCreate, item: { type: OAI_ITEM.functionCallOutput, call_id: callId, output: JSON.stringify(result) } });
    }
    sendOpenAI({ type: OAI_CLIENT.responseCreate });
  };

  const onResponseDone = (ev: JsonObject) => {
    const response = asObject(ev.response);
    const output = Array.isArray(response?.output) ? response.output : [];
    const status = code(response?.status);
    if (status !== undefined && status !== 'completed') logger.info({ ...tag(), status }, 'voice: response.done not completed');
    // Issue #95 item 7: a function call on a response that was cancelled, cut off or failed is not run.
    // The raw status, not the logged code: a response with no status field is treated as complete.
    const raw = typeof response?.status === 'string' ? response.status : undefined;
    const incomplete = raw !== undefined && raw !== 'completed';
    const calls = incomplete ? [] : output.map(asObject).filter((o): o is JsonObject => o !== undefined && o.type === OAI_ITEM.functionCall);
    if (calls.length === 0) {
      if (finishing?.responseId !== undefined && finishing.responseId === str(response, 'id') && response?.status === 'completed') {
        finishing.complete = true;
        finishWhenPlayed();
      }
      return;
    }
    if (pendingResponses >= limits.maxPendingResponses) {
      // Bounded: answer at once instead of queueing behind slow tools.
      logger.warn({ ...tag(), pendingResponses }, 'voice: tool queue full; answering unavailable');
      for (const c of calls) {
        const callId = str(c, 'call_id');
        if (callId !== undefined) sendOpenAI({ type: OAI_CLIENT.itemCreate, item: { type: OAI_ITEM.functionCallOutput, call_id: callId, output: JSON.stringify(toolFailure('INTEGRATION_UNAVAILABLE', UNAVAILABLE)) } });
      }
      sendOpenAI({ type: OAI_CLIENT.responseCreate });
      return;
    }
    pendingResponses++;
    toolChain = toolChain
      .then(() => handleCalls(calls))
      .catch((err: unknown) => logger.error({ ...tag(), ...errorInfo(err) }, 'voice: tool routing failed'))
      .finally(() => {
        pendingResponses--;
      });
  };

  const onOpenAIMessage = (raw: string) => {
    if (closed) return;
    const ev = parseJson(raw);
    if (ev === undefined) return;
    switch (ev.type) {
      case 'response.created': {
        const response = asObject(ev.response);
        if (finishing !== undefined && finishing.responseId === undefined && str(asObject(response?.metadata), 'voiceFinishGeneration') === String(finishing.generation)) {
          const id = str(response, 'id');
          if (id !== undefined) finishing.responseId = id;
        }
        break;
      }
      case 'response.output_item.done': {
        const id = str(asObject(ev.item), 'id');
        if (id !== undefined) playback.onItemDone(id);
        break;
      }
      case OAI_SERVER.sessionUpdated:
        if (!sessionReady) {
          sessionReady = true;
          logger.info(tag(), 'voice: session ready; model speaks first');
          sendOpenAI({ type: OAI_CLIENT.responseCreate });
        }
        break;
      case OAI_SERVER.audioDelta: {
        const delta = str(ev, 'delta');
        const itemId = str(ev, 'item_id') ?? 'unknown';
        if (streamSid === undefined || delta === undefined || playback.isCut(itemId)) break;
        if (phone.bufferedAmount + Buffer.byteLength(JSON.stringify({ event: TWILIO_EVENT.media, streamSid, media: { payload: delta } })) > limits.maxBufferedBytes || playback.pendingMarks >= limits.maxPendingMarks || playback.retainedItems >= 128) {
          // Drop policy: the caller's line cannot keep up, so the call fails rather than buffering without bound.
          logger.error({ ...tag(), bufferedBytes: phone.bufferedAmount, pendingMarks: playback.pendingMarks }, 'voice: phone back-pressure limit reached');
          failOrHandOff('phone back-pressure', { phoneLineOverloaded: true, modelSessionReady: sessionReady });
          break;
        }
        sendTwilio({ event: TWILIO_EVENT.media, streamSid, media: { payload: delta } });
        const mark = playback.onAudioSent(itemId, ulawBase64DurationMs(delta));
        sendTwilio({ event: TWILIO_EVENT.mark, streamSid, mark: { name: mark } });
        const m = timing.onAudioSent(now());
        if (m?.kind === 'first_audio') logger.info({ ...tag(), connectToFirstAudioMs: m.ms }, 'voice: timing');
        else if (m?.kind === 'turn') logger.info({ ...tag(), turn: m.turn, turnMs: m.ms }, 'voice: timing');
        break;
      }
      case OAI_SERVER.speechStarted: {
        // Barge-in (SPEC 4): clear Twilio's buffer, cut the item being heard where the caller last
        // heard it, and cut every later item the caller has not heard at all.
        timing.onSpeechStarted();
        const cut = playback.interrupt();
        if (cut !== null && streamSid !== undefined) {
          bargeIns++;
          sendTwilio({ event: TWILIO_EVENT.clear, streamSid });
          sendOpenAI({ type: OAI_CLIENT.itemTruncate, item_id: cut.heard.itemId, content_index: 0, audio_end_ms: cut.heard.audioEndMs });
          for (const itemId of cut.unheard) sendOpenAI({ type: OAI_CLIENT.itemTruncate, item_id: itemId, content_index: 0, audio_end_ms: 0 });
          logger.info({ ...tag(), audioEndMs: cut.heard.audioEndMs, unheardItems: cut.unheard.length }, 'voice: barge-in');
        }
        break;
      }
      case OAI_SERVER.speechStopped:
        timing.onSpeechStopped(now());
        break;
      case OAI_SERVER.responseDone:
        onResponseDone(ev);
        break;
      case OAI_SERVER.error: {
        // Only the error's type and code are logged; its message can echo input or a key.
        const e = asObject(ev.error);
        logger.error({ ...tag(), errorType: code(e?.type), errorCode: code(e?.code) }, 'voice: OpenAI error');
        modelErrors++;
        if (!sessionReady) failOrHandOff('model error during setup', { modelSessionFailed: true, modelSessionReady: false });
        else if (!RECOVERABLE_ERRORS.has(code(e?.code))) shutdown('failed', 'fatal model error');
        else if (modelErrors >= MAX_MODEL_ERRORS) shutdown('failed', 'repeated model errors');
        break;
      }
      default:
        // Transcripts and every other event are dropped unread.
        break;
    }
  };

  const openSession = (call: PinnedCall) => {
    const check = checkSessionCapabilities(call.spec);
    if (!check.ok) {
      logger.error({ ...tag(), unknown: check.unknown.length, notAllowed: check.notAllowed }, 'voice: agent spec has a capability that is not allowed; session refused');
      shutdown('failed', 'capability not allowed');
      return;
    }
    allowedTools = check.tools;
    try {
      toolset = deps.toolsetFactory({ businessId: call.businessId, agentVersionId: call.agentVersionId, callId: call.callId, capabilities: call.spec.capabilities, facts: call.facts });
      openai = deps.openaiSocketFactory({ model });
    } catch (err) {
      logger.error({ ...tag(), ...errorInfo(err) }, 'voice: could not open the model session');
      failOrHandOff('session setup failed', { modelSessionFailed: true, modelSessionReady: false });
      return;
    }
    if (deps.finishes !== undefined) {
      unsubscribeFinish = deps.finishes.subscribe(call.callId, (event) => {
        if (closed || event.callId !== call.callId || event.agentVersionId !== call.agentVersionId || event.responseId === '') return;
        cancel(pendingTimer); pendingTimer = undefined;
        beginFinish(event.responseId);
      });
    }
    stage = 'CALL_STARTED';
    setStage(initialStage(call.spec.template));
    const instructions = buildInstructions(call.spec, { businessName: call.businessName, messageChannel: deps.messageChannel });
    const session = buildSessionUpdate({ model, voice: deps.voice ?? VOICE, instructions, tools: allowedTools });
    const socket = openai;
    socket.onOpen(() => {
      logger.info({ ...tag(), model, tools: allowedTools }, 'voice: OpenAI socket open');
      sendOpenAI(session);
    });
    socket.onMessage(onOpenAIMessage);
    socket.onError((err) => {
      logger.error({ ...tag(), ...errorInfo(err) }, 'voice: OpenAI socket error');
      shutdown('failed', 'OpenAI socket error');
    });
    socket.onClose(() => { modelClosed = true; if (phoneClosed) clearTimeout(closeGrace); shutdown('failed', 'OpenAI socket closed'); });
  };

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    if (pinned === undefined || closed) return;
    cancel(idleTimer);
    idleTimer = later(limits.idleTimeoutMs, () => shutdown('dropped', 'no audio from Twilio'));
  };

  const pollStatus = () => {
    later(limits.statusPollMs, async () => {
      if (closed || pinned === undefined) return;
      const status = await withDeadline(deps.calls.getStatus(pinned.callId), limits.cleanupTimeoutMs, 'unknown' as const);
      if (closed) return;
      if (status !== 'IN_PROGRESS' && status !== 'unknown') shutdown(null, 'call ended elsewhere');
      else pollStatus();
    });
  };

  const onStart = async (msg: JsonObject) => {
    if (pinned !== undefined || closed) return;
    const start = asObject(msg.start);
    const providerCallId = str(start, 'callSid');
    const sid = str(start, 'streamSid') ?? str(msg, 'streamSid');
    const token = str(asObject(start?.customParameters), STREAM_TOKEN_PARAM);
    const check = deps.tokens.consume(token, providerCallId, sid, now());
    if (!check.ok) {
      logger.warn({ reason: check.reason }, 'voice: stream token rejected');
      shutdown(null, `stream token rejected: ${check.reason}`);
      return;
    }
    if (token !== undefined) secrets.push(token);
    pinned = check.value;
    streamSid = sid;
    startedAt = now();
    timing.onConnect(startedAt);
    later(limits.setupTimeoutMs, () => {
      if (!sessionReady) failOrHandOff('model session not ready in time', { modelSessionFailed: true, modelSessionReady: false });
    });
    later(limits.maxSessionMs, () => shutdown('completed', 'maximum call length'));
    touch();
    const status = await withDeadline(deps.calls.getStatus(pinned.callId), limits.cleanupTimeoutMs, 'unknown' as const);
    if (closed) return;
    if (status === 'unknown') {
      logger.error({ ...tag() }, 'voice: could not read call status');
      shutdown('failed', 'call status unavailable');
      return;
    }
    if (status !== 'IN_PROGRESS') {
      logger.warn({ ...tag(), status: status ?? 'missing' }, 'voice: call is not in progress; stream refused');
      shutdown(null, 'call not in progress');
      return;
    }
    logger.info(tag(), 'voice: stream started; token accepted');
    pollStatus();
    openSession(pinned);
  };

  // An unauthenticated socket that never sends `start` is closed.
  later(limits.startTimeoutMs, () => {
    if (pinned === undefined) shutdown(null, 'no start message');
  });

  phone.onMessage((raw) => {
    if (closed) return;
    const msg = parseJson(raw);
    if (msg === undefined) return;
    touch();
    switch (msg.event) {
      case TWILIO_EVENT.start:
        void onStart(msg);
        break;
      case TWILIO_EVENT.media: {
        if (streamSid === undefined || pinned === undefined) return;
        if (!sessionReady) {
          droppedEarlyChunks++;
          return;
        }
        const payload = str(asObject(msg.media), 'payload');
        if (payload !== undefined) {
          const message = { type: OAI_CLIENT.audioAppend, audio: payload };
          if ((openai?.bufferedAmount ?? 0) + Buffer.byteLength(JSON.stringify(message)) > limits.maxBufferedBytes) {
            shutdown('failed', 'model back-pressure');
            return;
          }
          sendOpenAI(message);
        }
        break;
      }
      case TWILIO_EVENT.mark: {
        const name = str(asObject(msg.mark), 'name');
        if (name !== undefined) playback.onMark(name);
        finishWhenPlayed();
        break;
      }
      case TWILIO_EVENT.stop:
        shutdown(pinned === undefined ? null : 'completed', 'Twilio sent stop');
        break;
      default:
        break;
    }
  });
  phone.onError((err) => {
    logger.error({ ...tag(), ...errorInfo(err) }, 'voice: Twilio socket error');
    shutdown(pinned === undefined ? null : 'dropped', 'Twilio socket error');
  });
  phone.onClose(() => { phoneClosed = true; if (modelClosed || openai === undefined) clearTimeout(closeGrace); shutdown(pinned === undefined ? null : 'dropped', 'Twilio socket closed'); });

  return { done };
}
