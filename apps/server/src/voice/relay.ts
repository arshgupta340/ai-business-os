// One phone call: Twilio Media Stream <-> this server <-> OpenAI Realtime (FLOWS B4 to B30).
// Audio is relayed as G.711 u-law both ways and never stored. No transcript is stored, and none is
// read except the one caller turn that answers the PROPOSED text offer (SPEC 2.9), which is matched in
// memory and dropped. Every Realtime event other than the few below is dropped unread. Every log line goes through
// `safeLogger` (logic.ts), and only fixed codes, validated tool names and timings are logged.
// Every stage has a deadline, every queue a bound, and every exit runs one idempotent shutdown.
import WebSocket from 'ws';
import type { CancellableToolHandler } from '../tools/real/types';
import {
  ACTIVITY_EVENT_PAYLOADS,
  CAPABILITIES,
  REALTIME_MODEL,
  canonicalJson,
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
  type JsonValue,
  type MessageChannelSetting,
  type ToolContext,
  type ToolDefinition,
  type ToolFailure,
  type ToolInput,
  type ToolName,
} from '@abos/contracts';
import { AUDIO_FORMAT, OAI_CLIENT, OAI_ITEM, OAI_SERVER, OPENAI_REALTIME_URL, STREAM_TOKEN_PARAM, TRANSCRIBE_MODEL, TURN_DETECTION, TWILIO_EVENT, VOICE } from './constants';
import { matchSpokenAnswer, offerLineSpoken, textOfferAllowed, type SpokenAnswer } from './consent';
import { PlaybackTracker, StreamTokenStore, TimingTracker, errorInfo, safeLogger, spokenText, ulawBase64DurationMs } from './logic';
import { buildInstructions, consentOfferInstruction, consentOfferSentence, consentResultInstruction, decisionInstruction, pendingGoodbyeInstruction, proposalLimitInstruction, toolLimitGoodbyeInstruction } from './prompt';
import type {
  CallDecision,
  CallDecisionsPort,
  CallFinishesPort,
  CallsPort,
  ConsentEvidence,
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

/** Added to every tool description on the phone, where an announcement before a tool call is dead air. */
export const SILENT_TOOL_NOTE = 'Call this silently: say nothing before the call and do not announce it.';

/** The allowed tools as the phone session gets them: the shared definitions plus the silent-call note. */
export function phoneToolDefinitions(tools: readonly ToolName[]): ToolDefinition[] {
  return toolDefinitionsFor(tools).map((d) => ({ ...d, description: `${d.description} ${SILENT_TOOL_NOTE}` }));
}

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
      tools: phoneToolDefinitions(args.tools),
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
  // Issue #95 item 8. A full order or booking call uses about ten to fifteen tool calls and one proposal,
  // or two when a slot conflict or a changed cart needs a second one.
  maxToolCalls: 40,
  maxProposals: 3,
  // About 30 seconds of 20 ms chunks that Twilio has not confirmed as played.
  maxPendingMarks: 1500,
  maxBufferedBytes: 512 * 1024,
  pendingWaitMs: 90_000,
  goodbyeMaxMs: 20_000,
  consentWindowMs: 20_000,
};

/** Model error events tolerated after the session is ready before the call is ended. */
const MAX_MODEL_ERRORS = 3;
/** Function calls refused after the tool-call cap was reached before the call is cut off without waiting for the goodbye. */
const MAX_CALLS_AFTER_TOOL_LIMIT = 5;
const LIMIT_REACHED = 'The limit for this call is reached.';
const isProposeTool = (tool: ToolName) => tool === 'propose_order' || tool === 'propose_booking';

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
  // Issue #95 item 8: per-call caps. Every function call the model makes is counted when it arrives.
  let toolCallsSeen = 0;
  let toolLimitReached = false;
  let callsAfterToolLimit = 0;
  /** Approvals stored on this call. A repeat that returns the same stored proposal is not a new one. */
  const storedApprovals = new Set<string>();
  /** Proposals whose result is unknown (timed out, cut off or threw): each may have been stored. */
  let uncertainProposals = 0;
  let proposalLimitTold = false;
  let startedAt = now();
  let unsubscribe: (() => void) | undefined;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const playback = new PlaybackTracker();
  const timing = new TimingTracker();

  // ---------- PROPOSED text step (SPEC 2.9 "Consent evidence on a phone call") ----------
  // The server offers one message once per call, at a fixed moment, and reads the caller's answer
  // itself: the server's transcript of the one caller turn that starts after the offer was verified as
  // spoken and fully played, or a keypad press. While it waits, the model does not answer on its own
  // (create_response is off, confirmed by session.updated), no other response is created or played,
  // and input transcription is on; the session is restored as soon as the answer is known. The
  // transcript is matched in memory and dropped. Every transcript outside that one turn is dropped unread.
  type OfferLine = 'offer' | 'reask';
  type ConsentPhase =
    | { kind: 'off' }
    | { kind: 'ready' }
    /** The window's session.update was sent and is not yet confirmed. Nothing is spoken yet. */
    | { kind: 'opening'; line: OfferLine; timer: ReturnType<typeof setTimeout> }
    | { kind: 'offering'; line: OfferLine; tag: string; responseId?: string; responseDone: boolean; audioSent: boolean; spokenOk: boolean; marks: Set<string>; timer: ReturnType<typeof setTimeout> }
    | { kind: 'listening'; offerSpokenAt: number; itemId?: string; timer: ReturnType<typeof setTimeout> }
    /** `usedArgs`: the one proposal operation that consumed the evidence; only its exact replay gets it again. */
    | { kind: 'agreed'; evidence: ConsentEvidence; usedArgs?: string; usedApproval?: boolean }
    | { kind: 'declined' }
    | { kind: 'withdrawn' };
  let consent: ConsentPhase = { kind: 'off' };
  /** The evidence handed to the toolset, only for the duration of one propose call. */
  let proposeEvidence: ConsentEvidence | undefined;
  let proposeInFlight = false;
  let pendingWithdraw = false;
  /** Full offers queued on this call. An undelivered offer is spoken again once, then it is a decline. */
  let offersQueued = 0;
  let unclearAnswers = 0;
  let offerSeq = 0;
  /** What the window should be, and the session.update events not yet confirmed by session.updated. */
  let windowOpen = false;
  let windowUnconfirmed = 0;
  let windowSeq = 0;
  const windowEventIds = new Map<string, boolean>();
  let restoreTimer: ReturnType<typeof setTimeout> | undefined;

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
    // The evidence dies with the call.
    consent = { kind: 'off' };
    proposeEvidence = undefined;
    cancel(restoreTimer);
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
  const instruct = (text: string, generation?: number, metadata?: Record<string, string>, noTools = false) => {
    sendOpenAI({ type: OAI_CLIENT.itemCreate, item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: spokenText(text) }] } });
    const meta = { ...(generation === undefined ? {} : { voiceFinishGeneration: String(generation) }), ...metadata };
    const response = { ...(Object.keys(meta).length === 0 ? {} : { metadata: meta }), ...(noTools ? { tool_choice: 'none' } : {}) };
    sendOpenAI({ type: OAI_CLIENT.responseCreate, ...(Object.keys(response).length === 0 ? {} : { response }) });
  };

  const consentWaiting = () => consent.kind === 'opening' || consent.kind === 'offering' || consent.kind === 'listening';
  /**
   * The window's session settings: no automatic reply and input transcription on, or the call's normal
   * settings. Each update carries an event_id and counts as applied only once session.updated arrives.
   */
  const sendWindow = (open: boolean) => {
    windowOpen = open;
    const eventId = `voice_consent_window_${++windowSeq}`;
    windowEventIds.set(eventId, open);
    windowUnconfirmed++;
    sendOpenAI({ type: OAI_CLIENT.sessionUpdate, event_id: eventId, session: { type: 'realtime', audio: { input: {
      format: AUDIO_FORMAT,
      turn_detection: { ...TURN_DETECTION, create_response: !open },
      transcription: open ? { model: TRANSCRIBE_MODEL } : null,
    } } } });
    if (!open) {
      cancel(restoreTimer);
      // Automatic replies must never stay off: an unconfirmed restore ends the call.
      restoreTimer = later(limits.consentWindowMs, () => {
        if (windowUnconfirmed > 0 && !windowOpen) shutdown('failed', 'consent window restore not confirmed');
      });
    }
  };
  const closeWindow = () => { if (windowOpen) sendWindow(false); };
  const clearConsentTimer = () => {
    if (consent.kind === 'opening' || consent.kind === 'offering' || consent.kind === 'listening') cancel(consent.timer);
  };
  const last4Of = (call: PinnedCall) => (call.callerNumber ?? '').slice(-4);

  /** Queues one line of the offer. The window must already be confirmed open. */
  const speakLine = (line: OfferLine) => {
    const call = pinned;
    if (call === undefined || closed) return;
    clearConsentTimer();
    if (line === 'offer') offersQueued++;
    const tagValue = String(++offerSeq);
    const timer = later(limits.consentWindowMs, () => {
      if (consent.kind === 'offering' && consent.tag === tagValue) settleConsent('declined', 'offer_not_played');
    });
    consent = { kind: 'offering', line, tag: tagValue, responseDone: false, audioSent: false, spokenOk: false, marks: new Set(), timer };
    logger.info({ ...tag(), line }, 'voice: text offer queued');
    instruct(consentOfferInstruction(call.spec.template, deps.messageChannel, last4Of(call), line === 'offer' ? 1 : 2), undefined, { voiceConsentOffer: tagValue }, true);
  };

  const startOffer = () => {
    if (closed || pinned === undefined) return;
    const timer = later(limits.consentWindowMs, () => {
      if (consent.kind === 'opening') windowFailed('window_not_confirmed');
    });
    consent = { kind: 'opening', line: 'offer', timer };
    sendWindow(true);
  };

  /** The window could not be opened: the offer was never made. Restore and let the call go on. */
  const windowFailed = (why: string) => {
    if (consent.kind !== 'opening') return;
    clearConsentTimer();
    consent = { kind: 'declined' };
    logger.warn({ ...tag(), why }, 'voice: text offer not made');
    sendWindow(false);
    if (!closed && !toolLimitReached && finishing === undefined) sendOpenAI({ type: OAI_CLIENT.responseCreate });
  };

  /** An offer line the caller did not fully hear, or the model did not say as written. */
  const notDelivered = (why: string) => {
    if (consent.kind !== 'offering') return;
    if (!consent.responseDone) sendOpenAI({ type: 'response.cancel' });
    logger.info({ ...tag(), why }, 'voice: text offer not delivered');
    if (offersQueued < 2) speakLine('offer');
    else settleConsent('declined', why);
  };

  /** Ends the window and tells the model the result with a fixed server line. */
  const settleConsent = (outcome: 'agreed' | 'declined', why: string, evidence?: ConsentEvidence) => {
    const call = pinned;
    if (call === undefined || !consentWaiting()) return;
    const offerStillPlaying = consent.kind === 'offering' && !consent.responseDone;
    clearConsentTimer();
    consent = outcome === 'agreed' && evidence !== undefined ? { kind: 'agreed', evidence } : { kind: 'declined' };
    closeWindow();
    logger.info({ ...tag(), consent: consent.kind, method: evidence?.method ?? 'none', why }, 'voice: text consent outcome');
    if (closed || toolLimitReached || finishing !== undefined) return;
    if (offerStillPlaying) sendOpenAI({ type: 'response.cancel' });
    instruct(consentResultInstruction(call.spec.template, deps.messageChannel, last4Of(call), consent.kind === 'agreed' ? 'agreed' : 'declined'));
  };

  /** The window ends with no line spoken: the call is saying goodbye for another reason. */
  const abandonConsent = () => {
    if (!consentWaiting()) return;
    clearConsentTimer();
    consent = { kind: 'declined' };
    closeWindow();
    logger.info({ ...tag(), consent: 'declined', method: 'none', why: 'call_finishing' }, 'voice: text consent outcome');
  };

  const agree = (method: 'spoken' | 'keypad') => {
    const call = pinned;
    if (call === undefined || consent.kind !== 'listening' || call.callerNumber === undefined) return;
    const at = now();
    settleConsent('agreed', method, {
      callId: call.callId, agentVersionId: call.agentVersionId, recipient: call.callerNumber,
      offerSpokenAt: new Date(consent.offerSpokenAt).toISOString(), method, consentAt: new Date(at).toISOString(),
    });
  };

  const onAnswer = (answer: SpokenAnswer) => {
    if (consent.kind !== 'listening') return;
    if (answer === 'agreed') agree('spoken');
    else if (answer === 'declined') settleConsent('declined', 'spoken_no');
    else if (++unclearAnswers === 1) speakLine('reask');
    else settleConsent('declined', 'unclear_twice');
  };

  /** Spoken means: the response finished, its own output transcript has the line, and Twilio played every mark of its audio. */
  const checkOfferPlayed = () => {
    if (consent.kind !== 'offering' || !consent.responseDone || !consent.audioSent || !consent.spokenOk || consent.marks.size > 0 || closed) return;
    cancel(consent.timer);
    const timer = later(limits.consentWindowMs, () => {
      if (consent.kind === 'listening' && consent.timer === timer) settleConsent('declined', 'no_answer');
    });
    consent = { kind: 'listening', offerSpokenAt: now(), timer };
  };

  /** A keypad 2 after agreement. Before a proposal used the evidence it withdraws it; after, the server says so plainly. */
  const withdraw = () => {
    const call = pinned;
    if (consent.kind !== 'agreed' || call === undefined) return;
    const alreadySent = consent.usedApproval === true;
    consent = { kind: 'withdrawn' };
    logger.info({ ...tag(), consent: 'withdrawn', method: 'keypad', afterProposal: alreadySent }, 'voice: text consent outcome');
    if (toolLimitReached || finishing !== undefined) return;
    sendOpenAI({ type: 'response.cancel' });
    instruct(consentResultInstruction(call.spec.template, deps.messageChannel, last4Of(call), alreadySent ? 'already_sent' : 'withdrawn'));
  };

  const onDigit = (digit: string) => {
    if (closed) return;
    if (consent.kind === 'offering') settleConsent('declined', 'key_before_offer_played');
    else if (consent.kind === 'listening') {
      if (digit === '1') agree('keypad');
      else settleConsent('declined', 'keypad_no');
    } else if (consent.kind === 'agreed' && digit === '2') {
      if (proposeInFlight) pendingWithdraw = true;
      else withdraw();
    }
  };

  /** FLOWS 3: the fixed moment of the offer. Orders: the first successful quote. Bookings: the first availability with a slot. */
  const isOfferMoment = (template: AgentTemplate, tool: ToolName, r: JsonObject | undefined) => {
    if (r?.ok !== true) return false;
    if (template === 'restaurant_order_taker') return tool === 'quote_order';
    if (template === 'appointment_booker') return tool === 'read_calendar_availability' && Array.isArray(r.slots) && r.slots.length > 0;
    return false;
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

  const onProposed = (result: JsonObject, consented: boolean) => {
    if (pinned === undefined) return;
    cancel(pendingTimer);
    invalidateFinish();
    // The proposal used the server's channel only when the toolset was handed consent evidence for it.
    proposal = { proposalId: String(result.proposalId), approvalId: String(result.approvalId), channel: consented && deps.messageChannel !== 'qr_only' ? deps.messageChannel : 'qr_only' };
    const call = pinned;
    const last4 = proposal.channel === 'qr_only' ? undefined : last4Of(call);
    pendingTimer = later(limits.pendingWaitMs, () => {
      pendingTimer = undefined;
      if (closed) return;
      const generation = beginFinish();
      instruct(pendingGoodbyeInstruction(call.spec.template, proposal?.channel ?? 'qr_only', call.businessName, last4), generation);
    });
    if (deps.decisions !== undefined && unsubscribe === undefined) {
      unsubscribe = deps.decisions.subscribe(call.callId, (decision: CallDecision) => {
        // Once the call is saying its final goodbye for the tool-call cap, nothing reopens it.
        if (closed || toolLimitReached || proposal === undefined || decision.proposalId !== proposal.proposalId || decision.approvalId !== proposal.approvalId) return;
        cancel(pendingTimer); pendingTimer = undefined;
        invalidateFinish();
        sendOpenAI({ type: 'response.cancel' });
        logger.info({ ...tag(), state: decision.kind }, 'voice: owner decision instruction queued');
        instruct(decisionInstruction(call.spec.template, decision, proposal.channel, proposal.channel === 'qr_only' ? undefined : last4Of(call)));
      });
    }
  };

  const runFunctionCall = async (name: string, argsJson: string): Promise<{ result: unknown; tool: ToolName | null; proposalLimit?: true; consented?: boolean }> => {
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
    // Issue #95 item 8: a caller who keeps changing the cart and saying yes cannot fill the approvals inbox.
    if (isProposeTool(tool) && storedApprovals.size + uncertainProposals >= limits.maxProposals) {
      logger.warn({ ...tag(), tool, maxProposals: limits.maxProposals }, 'voice: proposal limit reached; proposal refused');
      guardrail({ callId: pinned.callId, rule: 'unsupported_request', reasonCode: 'proposal_limit', toolName: tool });
      return { result: toolFailure('VALIDATION_FAILED', LIMIT_REACHED), tool, proposalLimit: true };
    }
    // The text question is open: no proposal until the server has the caller's answer.
    if (isProposeTool(tool) && consentWaiting()) return { result: toolFailure('VALIDATION_FAILED', 'Wait for the server status about the message.'), tool };
    const ctx: ToolContext = { businessId: pinned.businessId, agentVersionId: pinned.agentVersionId, callId: pinned.callId, correlationId: pinned.callId };
    const timeoutMs = limits.toolTimeoutMs ?? CAPABILITIES[TOOL_CAPABILITY[tool]].timeoutMs;
    const handler = toolset.handler as CancellableToolHandler;
    const controller = new AbortController();
    activeInvocations.add(controller);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let result: unknown;
    let unknownOutcome = false;
    // The evidence is fixed when the proposal starts. It serves one proposal operation: the first
    // proposal after agreement, and afterwards only an exact replay of that same request.
    const argsKey = isProposeTool(tool) ? canonicalJson(args as JsonValue) : '';
    const evidence = isProposeTool(tool) && consent.kind === 'agreed' && (consent.usedArgs === undefined || consent.usedArgs === argsKey) ? consent.evidence : undefined;
    if (isProposeTool(tool)) { proposeInFlight = true; proposeEvidence = evidence; }
    try {
      const aborted = new Promise<ToolFailure>((resolve) => controller.signal.addEventListener('abort', () => { unknownOutcome = true; resolve(toolFailure('INTEGRATION_UNAVAILABLE', UNAVAILABLE)); }, { once: true }));
      result = await Promise.race([
        Promise.resolve().then(() => handler.call(tool, args as ToolInput[ToolName], ctx, { signal: controller.signal, timeoutMs })),
        aborted,
      ]);
    } catch {
      unknownOutcome = true;
      result = toolFailure('INTEGRATION_UNAVAILABLE', UNAVAILABLE);
    } finally {
      clearTimeout(timeout);
      activeInvocations.delete(controller);
      if (isProposeTool(tool)) { proposeEvidence = undefined; proposeInFlight = false; }
    }
    const r = asObject(result);
    if (isProposeTool(tool)) {
      if (isProposal(r) && r !== undefined) storedApprovals.add(String(r.approvalId));
      // A proposal that timed out or threw may still have been stored, so it uses one place.
      else if (unknownOutcome) uncertainProposals++;
      // Evidence handed to an operation that stored, or may have stored, a proposal is used up.
      if (evidence !== undefined && consent.kind === 'agreed' && (isProposal(r) || unknownOutcome)) {
        consent.usedArgs = argsKey;
        consent.usedApproval = true;
      }
    }
    if (r?.ok === false && r.reason === 'CAPABILITY_NOT_ALLOWED') guardrail({ callId: pinned.callId, rule: 'no_cross_business', reasonCode: 'CAPABILITY_NOT_ALLOWED', toolName: tool });
    return { result, tool, ...(isProposeTool(tool) ? { consented: evidence !== undefined } : {}) };
  };

  const handleCalls = async (calls: JsonObject[]) => {
    let tellProposalLimit = false;
    let offerDue = false;
    let noTextForThis = false;
    for (const call of calls) {
      if (closed) return;
      const callId = str(call, 'call_id');
      const t0 = now();
      const { result, tool, proposalLimit, consented } = await runFunctionCall(str(call, 'name') ?? '', str(call, 'arguments') ?? '{}');
      if (tool !== null && isProposeTool(tool) && isProposal(asObject(result)) && consented !== true && (consent.kind === 'agreed' && consent.usedApproval === true)) noTextForThis = true;
      if (proposalLimit && !proposalLimitTold) tellProposalLimit = true;
      // A result that arrives after the call ended changes nothing.
      if (closed || pinned === undefined) return;
      toolCalls++;
      const r = asObject(result);
      // Arguments are never logged: they can hold a name and a phone number.
      logger.info({ ...tag(), tool: tool ?? 'unknown_tool', ok: r?.ok === true, reason: code(r?.reason), latencyMs: now() - t0 }, 'voice: tool call');
      if (tool !== null) {
        setStage(nextStage(pinned.spec.template, stage, tool, result));
        if ((tool === 'propose_order' || tool === 'propose_booking') && isProposal(r) && r !== undefined) onProposed(r, consented === true);
        if (consent.kind === 'ready' && storedApprovals.size === 0 && uncertainProposals === 0 && isOfferMoment(pinned.spec.template, tool, r)) offerDue = true;
      }
      if (callId !== undefined) sendOpenAI({ type: OAI_CLIENT.itemCreate, item: { type: OAI_ITEM.functionCallOutput, call_id: callId, output: JSON.stringify(result) } });
    }
    // The final goodbye for the tool-call cap follows on the tool chain: no other response is asked for.
    if (toolLimitReached || closed || pinned === undefined) return;
    if (tellProposalLimit) {
      // Told once, by a fixed server instruction. Later refused proposals answer the model with the failure only.
      proposalLimitTold = true;
      instruct(proposalLimitInstruction(pinned.spec.template, proposal !== undefined));
      return;
    }
    // A keypad 2 that came while a proposal was being stored is answered now, after its result.
    if (pendingWithdraw) {
      pendingWithdraw = false;
      withdraw();
      return;
    }
    // A later request on a call whose one text was already used goes without one, and the agent is told.
    if (noTextForThis) {
      instruct(consentResultInstruction(pinned.spec.template, deps.messageChannel, last4Of(pinned), 'not_for_this_request'));
      return;
    }
    // The offer is spoken instead of the next ordinary reply, once per call.
    if (offerDue && consent.kind === 'ready') {
      startOffer();
      return;
    }
    // While the server waits for the caller's answer, only its own lines create a response.
    if (consentWaiting()) return;
    sendOpenAI({ type: OAI_CLIENT.responseCreate });
  };

  /**
   * Issue #95 item 8: function calls past the per-call cap. Each is answered with a failure at once,
   * without reaching the toolset, and recorded as guardrail.refused with fixed codes (never the name or
   * arguments the model sent, unless the name is a registered tool). The first time, the agent is told
   * by a fixed server instruction to say it cannot continue, and the call ends after that goodbye. A
   * model that keeps calling tools instead is cut off.
   */
  const refuseOverToolLimit = (calls: JsonObject[]) => {
    const call = pinned;
    if (call === undefined) return;
    for (const c of calls) {
      const named = ToolNameSchema.safeParse(str(c, 'name') ?? '');
      const tool = named.success ? named.data : undefined;
      logger.warn({ ...tag(), tool: tool ?? 'unknown_tool', maxToolCalls: limits.maxToolCalls }, 'voice: tool call limit reached; call refused');
      guardrail({ callId: call.callId, rule: 'unsupported_request', reasonCode: 'tool_call_limit', ...(tool ? { toolName: tool } : {}) });
      const callId = str(c, 'call_id');
      if (callId !== undefined) sendOpenAI({ type: OAI_CLIENT.itemCreate, item: { type: OAI_ITEM.functionCallOutput, call_id: callId, output: JSON.stringify(toolFailure('VALIDATION_FAILED', LIMIT_REACHED)) } });
    }
    if (toolLimitReached) {
      callsAfterToolLimit += calls.length;
      if (callsAfterToolLimit > MAX_CALLS_AFTER_TOOL_LIMIT) shutdown('completed', 'tool call limit: the model kept calling tools');
      return;
    }
    toolLimitReached = true;
    cancel(pendingTimer); pendingTimer = undefined;
    // After the tool work already queued, so its outputs come first.
    toolChain = toolChain.then(() => {
      if (closed) return;
      abandonConsent();
      sendOpenAI({ type: 'response.cancel' });
      const generation = beginFinish();
      instruct(toolLimitGoodbyeInstruction(call.businessName, proposal !== undefined), generation);
    });
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
    if (consent.kind === 'offering' && consent.responseId !== undefined && consent.responseId === str(response, 'id')) {
      // An offer cut off, silent, or with a tool call was not delivered as written.
      if (incomplete) notDelivered('offer_cut');
      else if (!consent.audioSent) notDelivered('offer_silent');
      else if (calls.length > 0) notDelivered('offer_tool_call');
      else { consent.responseDone = true; checkOfferPlayed(); }
    }
    // While the text question is open no tool runs and nothing asks for another response.
    if (consentWaiting() && calls.length > 0) {
      for (const c of calls) {
        const callId = str(c, 'call_id');
        if (callId !== undefined) sendOpenAI({ type: OAI_CLIENT.itemCreate, item: { type: OAI_ITEM.functionCallOutput, call_id: callId, output: JSON.stringify(toolFailure('VALIDATION_FAILED', 'Wait for the server status about the message.')) } });
      }
      return;
    }
    if (calls.length === 0) {
      if (finishing?.responseId !== undefined && finishing.responseId === str(response, 'id') && response?.status === 'completed') {
        finishing.complete = true;
        finishWhenPlayed();
      }
      return;
    }
    // Issue #95 item 8: every function call counts when it arrives, whatever its name. The calls past the
    // cap are refused here and never queued.
    const room = Math.max(0, limits.maxToolCalls - toolCallsSeen);
    toolCallsSeen += calls.length;
    if (calls.length > room) refuseOverToolLimit(calls.splice(room));
    if (calls.length === 0 || closed) return;
    if (pendingResponses >= limits.maxPendingResponses) {
      // Bounded: answer at once instead of queueing behind slow tools.
      logger.warn({ ...tag(), pendingResponses }, 'voice: tool queue full; answering unavailable');
      for (const c of calls) {
        const callId = str(c, 'call_id');
        if (callId !== undefined) sendOpenAI({ type: OAI_CLIENT.itemCreate, item: { type: OAI_ITEM.functionCallOutput, call_id: callId, output: JSON.stringify(toolFailure('INTEGRATION_UNAVAILABLE', UNAVAILABLE)) } });
      }
      if (!consentWaiting()) sendOpenAI({ type: OAI_CLIENT.responseCreate });
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
        const createdId = str(response, 'id');
        if (consent.kind === 'offering' && consent.responseId === undefined && str(asObject(response?.metadata), 'voiceConsentOffer') === consent.tag && createdId !== undefined) {
          consent.responseId = createdId;
        } else if (consentWaiting() && createdId !== undefined) {
          // Only the server's own offer line may speak while the question is open.
          sendOpenAI({ type: 'response.cancel', response_id: createdId });
          logger.info({ ...tag() }, 'voice: response cancelled while the text question is open');
        }
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
        } else if (windowUnconfirmed > 0) {
          // The window's own updates are the only ones sent after setup, and they are confirmed in order.
          windowUnconfirmed--;
          if (windowUnconfirmed === 0) {
            if (!windowOpen) { cancel(restoreTimer); restoreTimer = undefined; }
            else if (consent.kind === 'opening') speakLine(consent.line);
          }
        }
        break;
      case OAI_SERVER.audioDelta: {
        const delta = str(ev, 'delta');
        const itemId = str(ev, 'item_id') ?? 'unknown';
        if (streamSid === undefined || delta === undefined || playback.isCut(itemId)) break;
        // While the text question is open, only the offer response's own audio reaches the caller.
        const isOfferAudio = consent.kind === 'offering' && consent.responseId !== undefined && str(ev, 'response_id') === consent.responseId;
        if (consentWaiting() && !isOfferAudio) break;
        if (phone.bufferedAmount + Buffer.byteLength(JSON.stringify({ event: TWILIO_EVENT.media, streamSid, media: { payload: delta } })) > limits.maxBufferedBytes || playback.pendingMarks >= limits.maxPendingMarks || playback.retainedItems >= 128) {
          // Drop policy: the caller's line cannot keep up, so the call fails rather than buffering without bound.
          logger.error({ ...tag(), bufferedBytes: phone.bufferedAmount, pendingMarks: playback.pendingMarks }, 'voice: phone back-pressure limit reached');
          failOrHandOff('phone back-pressure', { phoneLineOverloaded: true, modelSessionReady: sessionReady });
          break;
        }
        sendTwilio({ event: TWILIO_EVENT.media, streamSid, media: { payload: delta } });
        const mark = playback.onAudioSent(itemId, ulawBase64DurationMs(delta));
        if (isOfferAudio && consent.kind === 'offering') { consent.audioSent = true; consent.marks.add(mark); }
        sendTwilio({ event: TWILIO_EVENT.mark, streamSid, mark: { name: mark } });
        const m = timing.onAudioSent(now());
        if (m?.kind === 'first_audio') logger.info({ ...tag(), connectToFirstAudioMs: m.ms }, 'voice: timing');
        else if (m?.kind === 'turn') logger.info({ ...tag(), turn: m.turn, turnMs: m.ms }, 'voice: timing');
        break;
      }
      case OAI_SERVER.speechStarted: {
        // A caller who talks over the offer has not heard it: it is spoken again in full.
        if (consent.kind === 'offering') notDelivered('barge_in');
        // The first caller turn that starts while listening is the one answer the server reads.
        else if (consent.kind === 'listening' && consent.itemId === undefined) {
          const id = str(ev, 'item_id');
          if (id !== undefined) consent.itemId = id;
        }
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
      case OAI_SERVER.outputTranscriptDone: {
        // The model's own words for the offer response only: checked in memory against the fixed line, never logged.
        if (consent.kind !== 'offering' || consent.responseId === undefined || str(ev, 'response_id') !== consent.responseId || pinned === undefined) break;
        if (offerLineSpoken(consentOfferSentence(pinned.spec.template, deps.messageChannel, last4Of(pinned), consent.line === 'offer' ? 1 : 2), str(ev, 'transcript'))) { consent.spokenOk = true; checkOfferPlayed(); }
        else notDelivered('offer_wording');
        break;
      }
      case OAI_SERVER.transcriptionCompleted:
      case OAI_SERVER.transcriptionFailed: {
        // Read only for the one answer turn; every other transcript is dropped unread. The text is
        // matched here and goes out of scope: it is never logged, stored or sent anywhere.
        if (consent.kind !== 'listening' || consent.itemId === undefined || str(ev, 'item_id') !== consent.itemId) break;
        onAnswer(ev.type === OAI_SERVER.transcriptionCompleted ? matchSpokenAnswer(str(ev, 'transcript')) : 'unclear');
        break;
      }
      case OAI_SERVER.error: {
        // Only the error's type and code are logged; its message can echo input or a key.
        const e = asObject(ev.error);
        logger.error({ ...tag(), errorType: code(e?.type), errorCode: code(e?.code) }, 'voice: OpenAI error');
        const failedWindow = windowEventIds.get(str(e, 'event_id') ?? '');
        if (sessionReady && failedWindow !== undefined) {
          // The window's session.update was refused. Opening: the offer is not made. Closing: the call ends,
          // so automatic replies can never stay off.
          windowUnconfirmed = Math.max(0, windowUnconfirmed - 1);
          if (failedWindow) windowFailed('window_refused');
          else shutdown('failed', 'consent window restore refused');
          break;
        }
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
    // The full number is redacted from every log line, as a second guard: no line is meant to carry it.
    if (call.callerNumber !== undefined) secrets.push(call.callerNumber);
    consent = textOfferAllowed(call.spec, deps.messageChannel, call.callerNumber) ? { kind: 'ready' } : { kind: 'off' };
    try {
      toolset = deps.toolsetFactory({ businessId: call.businessId, agentVersionId: call.agentVersionId, callId: call.callId, capabilities: call.spec.capabilities, facts: call.facts,
        consent: { callId: call.callId, agentVersionId: call.agentVersionId, read: () => proposeEvidence } });
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
        abandonConsent();
        beginFinish(event.responseId);
      });
    }
    stage = 'CALL_STARTED';
    setStage(initialStage(call.spec.template));
    const instructions = buildInstructions(call.spec, { businessName: call.businessName, messageChannel: deps.messageChannel, facts: call.facts, menu: call.menu, nowMs: now(),
      ...(consent.kind === 'ready' ? { textOffer: { last4: last4Of(call) } } : {}) });
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
        if (name !== undefined && consent.kind === 'offering') consent.marks.delete(name);
        finishWhenPlayed();
        checkOfferPlayed();
        break;
      }
      case TWILIO_EVENT.dtmf: {
        if (pinned === undefined) return;
        const digit = str(asObject(msg.dtmf), 'digit');
        if (digit !== undefined && /^[0-9*#A-D]$/.test(digit)) onDigit(digit);
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
