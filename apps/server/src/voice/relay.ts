// One phone call: Twilio Media Stream <-> this server <-> OpenAI Realtime (FLOWS B4 to B30).
// Audio is relayed as G.711 u-law both ways and never stored. No transcript is read or stored:
// every Realtime event other than the few below is dropped unread. Only event types, tool names,
// results (ok or reason) and timings are logged.
import WebSocket from 'ws';
import {
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
  type AgentSpec,
  type AgentTemplate,
  type CallEndReason,
  type CallStage,
  type CapabilityId,
  type MessageChannelSetting,
  type ToolContext,
  type ToolDefinition,
  type ToolFailure,
  type ToolHandler,
  type ToolInput,
  type ToolName,
} from '@abos/contracts';
import { AUDIO_FORMAT, OAI_CLIENT, OAI_ITEM, OAI_SERVER, OPENAI_REALTIME_URL, STREAM_TOKEN_PARAM, TURN_DETECTION, TWILIO_EVENT, VOICE } from './constants';
import { PlaybackTracker, StreamTokenStore, TimingTracker, redact, ulawBase64DurationMs } from './logic';
import { buildInstructions } from './prompt';
import type { CallsPort, DuplexSocket, OpenAISocketFactory, PinnedCall, VoiceLogger, VoiceToolsetFactory } from './types';

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

/** The call's conversation stage after a tool result (SPEC 2.4, FLOWS B6 to B14 and C1 to C5). */
export function nextStage(template: AgentTemplate, current: CallStage, tool: ToolName, result: unknown): CallStage {
  if (current === 'CUSTOMER_CONFIRMED') return current;
  const r = asObject(result);
  const ok = r?.ok === true;
  const proposed = ok && typeof r?.proposalId === 'string';
  switch (tool) {
    case 'read_catalog':
    case 'read_business_facts':
      return template !== 'appointment_booker' && current === 'CALL_STARTED' ? 'COLLECTING' : current;
    case 'quote_order':
      if (ok) return 'VALIDATING';
      return str(r, 'reason') === 'ITEM_UNAVAILABLE' ? 'UNAVAILABLE' : current;
    case 'propose_order':
      return proposed ? 'CUSTOMER_CONFIRMED' : current;
    case 'get_order_status':
      return current;
    case 'read_calendar_availability':
      return ok ? 'SLOT_SEARCH' : current;
    case 'propose_booking':
      return proposed ? 'CUSTOMER_CONFIRMED' : 'PROPOSAL';
  }
}

/** The stage a session starts in: booking calls begin in INQUIRY (FLOWS C1). */
export function initialStage(template: AgentTemplate): CallStage {
  return template === 'appointment_booker' ? 'INQUIRY' : 'CALL_STARTED';
}

// ---------- Sockets ----------

/** Adapts a `ws` socket to the relay's socket surface. */
export function adaptWs(ws: WebSocket): DuplexSocket {
  return {
    get isOpen() {
      return ws.readyState === WebSocket.OPEN;
    },
    send: (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    close: () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    },
    onOpen: (fn) => {
      if (ws.readyState === WebSocket.OPEN) queueMicrotask(fn);
      else ws.on('open', fn);
    },
    onMessage: (fn) => ws.on('message', (raw: WebSocket.RawData) => fn(Array.isArray(raw) ? Buffer.concat(raw).toString() : Buffer.from(raw as ArrayBuffer).toString())),
    onClose: (fn) => ws.on('close', (code: number) => fn(code)),
    onError: (fn) => ws.on('error', (err: Error) => fn(err)),
  };
}

/** The production OpenAI socket factory. The key never leaves this closure except in the auth header. */
export function createWsOpenAISocketFactory(args: { apiKey: string; url?: string | undefined }): OpenAISocketFactory {
  const base = args.url ?? OPENAI_REALTIME_URL;
  return ({ model }) => adaptWs(new WebSocket(`${base}?model=${encodeURIComponent(model)}`, { headers: { Authorization: `Bearer ${args.apiKey}` } }));
}

// ---------- The relay ----------

export type PhoneRelayDeps = {
  phone: DuplexSocket;
  tokens: StreamTokenStore<PinnedCall>;
  calls: CallsPort;
  toolsetFactory: VoiceToolsetFactory;
  openaiSocketFactory: OpenAISocketFactory;
  messageChannel: MessageChannelSetting;
  logger: VoiceLogger;
  model?: string | undefined;
  voice?: string | undefined;
  redactSecrets?: readonly string[] | undefined;
  now?: (() => number) | undefined;
};

/** How the relay finished. `rejected` means no session was started (bad token or call not in progress). */
export type RelayOutcome = { endReason: CallEndReason | null; why: string };

const toolFailure = (reason: ToolFailure['reason'], message: string): ToolFailure => ({ ok: false, reason, message });

export function runPhoneRelay(deps: PhoneRelayDeps): { done: Promise<RelayOutcome> } {
  const { phone, logger } = deps;
  const now = deps.now ?? Date.now;
  const model = deps.model ?? REALTIME_MODEL;
  const secrets = deps.redactSecrets ?? [];

  let resolveDone: (o: RelayOutcome) => void = () => undefined;
  const done = new Promise<RelayOutcome>((r) => {
    resolveDone = r;
  });

  let pinned: PinnedCall | undefined;
  let streamSid: string | undefined;
  let openai: DuplexSocket | undefined;
  let handler: ToolHandler | undefined;
  let allowedTools: ToolName[] = [];
  let stage: CallStage = 'CALL_STARTED';
  let sessionReady = false;
  let closed = false;
  let droppedEarlyChunks = 0;
  let bargeIns = 0;
  let toolCalls = 0;
  let startedAt = now();
  let toolQueue: Promise<void> = Promise.resolve();
  const playback = new PlaybackTracker();
  const timing = new TimingTracker();

  const tag = (): JsonObject => (pinned ? { callId: pinned.callId, agentVersionId: pinned.agentVersionId } : {});
  const sendTwilio = (msg: JsonObject) => phone.send(JSON.stringify(msg));
  const sendOpenAI = (msg: JsonObject) => {
    if (openai?.isOpen) openai.send(JSON.stringify(msg));
  };

  const shutdown = (endReason: CallEndReason | null, why: string) => {
    if (closed) return;
    closed = true;
    const s = timing.summary();
    logger.info(
      { ...tag(), why, endReason, durationMs: now() - startedAt, connectToFirstAudioMs: s.connectToFirstAudioMs, turnsMs: s.turns, p50Ms: s.p50, p95Ms: s.p95, maxMs: s.max, toolCalls, bargeIns, droppedEarlyChunks },
      'voice: call ended',
    );
    openai?.close();
    phone.close();
    const finish = () => resolveDone({ endReason, why });
    if (pinned !== undefined && endReason !== null) {
      deps.calls
        .endCall(pinned.callId, endReason)
        .catch((err: unknown) => logger.error({ ...tag(), err: redact(String(err), secrets) }, 'voice: could not end call'))
        .finally(finish);
    } else {
      finish();
    }
  };

  const setStage = (next: CallStage) => {
    if (pinned === undefined || next === stage) return;
    stage = next;
    deps.calls.updateStage(pinned.callId, next).catch((err: unknown) => logger.error({ ...tag(), stage: next, err: redact(String(err), secrets) }, 'voice: could not update call stage'));
  };

  const runFunctionCall = async (name: string, argsJson: string): Promise<unknown> => {
    const parsedName = ToolNameSchema.safeParse(name);
    if (!parsedName.success || !allowedTools.includes(parsedName.data) || handler === undefined || pinned === undefined) {
      return toolFailure('CAPABILITY_NOT_ALLOWED', 'There is no such tool.');
    }
    let args: unknown;
    try {
      args = argsJson.trim() === '' ? {} : JSON.parse(argsJson);
    } catch {
      return toolFailure('VALIDATION_FAILED', 'The arguments were not valid JSON.');
    }
    const ctx: ToolContext = { businessId: pinned.businessId, agentVersionId: pinned.agentVersionId, callId: pinned.callId, correlationId: pinned.callId };
    let result: unknown;
    try {
      result = await handler.call(parsedName.data, args as ToolInput[ToolName], ctx);
    } catch {
      result = toolFailure('INTEGRATION_UNAVAILABLE', 'That information is not available right now.');
    }
    setStage(nextStage(pinned.spec.template, stage, parsedName.data, result));
    return result;
  };

  const handleResponseDone = async (ev: JsonObject) => {
    const response = asObject(ev.response);
    const output = Array.isArray(response?.output) ? response.output : [];
    const status = str(response, 'status');
    if (status !== undefined && status !== 'completed') logger.info({ ...tag(), status }, 'voice: response.done not completed');
    const calls = output.map(asObject).filter((o): o is JsonObject => o !== undefined && o.type === OAI_ITEM.functionCall);
    if (calls.length === 0) return;
    for (const call of calls) {
      if (closed) return;
      const name = str(call, 'name') ?? '';
      const callId = str(call, 'call_id');
      const t0 = now();
      const result = await runFunctionCall(name, str(call, 'arguments') ?? '{}');
      toolCalls++;
      const r = asObject(result);
      // Arguments are not logged: they can hold a name and a phone number.
      logger.info({ ...tag(), tool: name, ok: r?.ok === true, reason: str(r, 'reason'), latencyMs: now() - t0 }, 'voice: tool call');
      if (callId === undefined) continue;
      sendOpenAI({ type: OAI_CLIENT.itemCreate, item: { type: OAI_ITEM.functionCallOutput, call_id: callId, output: JSON.stringify(result) } });
    }
    if (!closed) sendOpenAI({ type: OAI_CLIENT.responseCreate });
  };

  const onOpenAIMessage = (raw: string) => {
    const ev = parseJson(raw);
    if (ev === undefined) return;
    switch (ev.type) {
      case OAI_SERVER.sessionUpdated:
        if (!sessionReady) {
          sessionReady = true;
          logger.info(tag(), 'voice: session ready; model speaks first');
          sendOpenAI({ type: OAI_CLIENT.responseCreate });
        }
        break;
      case OAI_SERVER.audioDelta: {
        const delta = str(ev, 'delta');
        if (streamSid === undefined || delta === undefined) break;
        sendTwilio({ event: TWILIO_EVENT.media, streamSid, media: { payload: delta } });
        const mark = playback.onAudioSent(str(ev, 'item_id') ?? 'unknown', ulawBase64DurationMs(delta));
        sendTwilio({ event: TWILIO_EVENT.mark, streamSid, mark: { name: mark } });
        const m = timing.onAudioSent(now());
        if (m?.kind === 'first_audio') logger.info({ ...tag(), connectToFirstAudioMs: m.ms }, 'voice: timing');
        else if (m?.kind === 'turn') logger.info({ ...tag(), turn: m.turn, turnMs: m.ms }, 'voice: timing');
        break;
      }
      case OAI_SERVER.speechStarted: {
        // Barge-in (SPEC 4): clear Twilio's buffer and truncate the item where the caller last heard it.
        timing.onSpeechStarted();
        const cut = playback.interrupt();
        if (cut !== null && streamSid !== undefined) {
          bargeIns++;
          sendTwilio({ event: TWILIO_EVENT.clear, streamSid });
          sendOpenAI({ type: OAI_CLIENT.itemTruncate, item_id: cut.itemId, content_index: 0, audio_end_ms: cut.audioEndMs });
          logger.info({ ...tag(), audioEndMs: cut.audioEndMs }, 'voice: barge-in');
        }
        break;
      }
      case OAI_SERVER.speechStopped:
        timing.onSpeechStopped(now());
        break;
      case OAI_SERVER.responseDone:
        toolQueue = toolQueue.then(() => handleResponseDone(ev)).catch((err: unknown) => logger.error({ ...tag(), err: redact(String(err), secrets) }, 'voice: tool routing failed'));
        break;
      case OAI_SERVER.error:
        // An invalid-key error echoes part of the key, so redact before logging.
        logger.error({ ...tag(), error: redact(JSON.stringify(ev.error ?? ev), secrets) }, 'voice: OpenAI error');
        break;
      default:
        // Transcripts and every other event are dropped unread.
        break;
    }
  };

  const openSession = (call: PinnedCall) => {
    const check = checkSessionCapabilities(call.spec);
    if (!check.ok) {
      logger.error({ ...tag(), unknown: check.unknown, notAllowed: check.notAllowed }, 'voice: agent spec has a capability that is not allowed; session refused');
      shutdown('failed', 'capability not allowed');
      return;
    }
    allowedTools = check.tools;
    try {
      handler = deps.toolsetFactory({ businessId: call.businessId, agentVersionId: call.agentVersionId, callId: call.callId, capabilities: call.spec.capabilities });
      openai = deps.openaiSocketFactory({ model });
    } catch (err) {
      logger.error({ ...tag(), err: redact(String(err), secrets) }, 'voice: could not open the model session');
      shutdown('failed', 'session setup failed');
      return;
    }
    stage = 'CALL_STARTED';
    setStage(initialStage(call.spec.template));
    const instructions = buildInstructions(call.spec, { businessName: call.businessName, messageChannel: deps.messageChannel });
    const session = buildSessionUpdate({ model, voice: deps.voice ?? VOICE, instructions, tools: allowedTools });
    openai.onOpen(() => {
      logger.info({ ...tag(), model, tools: allowedTools }, 'voice: OpenAI socket open');
      sendOpenAI(session);
    });
    openai.onMessage(onOpenAIMessage);
    openai.onError((err) => logger.error({ ...tag(), err: redact(err.message, secrets) }, 'voice: OpenAI socket error'));
    openai.onClose((code) => shutdown('failed', `OpenAI socket closed (code ${code})`));
  };

  const onStart = async (msg: JsonObject) => {
    if (pinned !== undefined) return;
    const start = asObject(msg.start);
    const providerCallId = str(start, 'callSid');
    streamSid = str(start, 'streamSid') ?? str(msg, 'streamSid');
    const token = str(asObject(start?.customParameters), STREAM_TOKEN_PARAM);
    const check = deps.tokens.consume(token, providerCallId, now());
    if (!check.ok) {
      logger.warn({ reason: check.reason }, 'voice: stream token rejected');
      shutdown(null, `stream token rejected: ${check.reason}`);
      return;
    }
    pinned = check.value;
    startedAt = now();
    timing.onConnect(startedAt);
    let status: Awaited<ReturnType<CallsPort['getStatus']>>;
    try {
      status = await deps.calls.getStatus(pinned.callId);
    } catch (err) {
      logger.error({ ...tag(), err: redact(String(err), secrets) }, 'voice: could not read call status');
      shutdown('failed', 'call status unavailable');
      return;
    }
    if (status !== 'IN_PROGRESS') {
      logger.warn({ ...tag(), status }, 'voice: call is not in progress; stream refused');
      // A call that already ended is left as it is.
      shutdown(null, 'call not in progress');
      return;
    }
    if (closed) return;
    logger.info(tag(), 'voice: stream started; token accepted');
    openSession(pinned);
  };

  phone.onMessage((raw) => {
    const msg = parseJson(raw);
    if (msg === undefined) return;
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
        if (payload !== undefined) sendOpenAI({ type: OAI_CLIENT.audioAppend, audio: payload });
        break;
      }
      case TWILIO_EVENT.mark: {
        const name = str(asObject(msg.mark), 'name');
        if (name !== undefined) playback.onMark(name);
        break;
      }
      case TWILIO_EVENT.stop:
        shutdown('completed', 'Twilio sent stop');
        break;
      default:
        break;
    }
  });
  phone.onError((err) => logger.error({ ...tag(), err: redact(err.message, secrets) }, 'voice: Twilio socket error'));
  phone.onClose(() => shutdown(pinned === undefined ? null : 'dropped', 'Twilio socket closed'));

  return { done };
}
