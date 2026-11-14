// Ports the phone voice worker needs. Each is implemented elsewhere (the live_agent, calls and
// activity_events tables, the real toolset, Twilio, OpenAI) and injected, so tests can pass fakes.
import type { ActivityEventPayloads, AgentSpec, CallEndReason, CatalogItem, CallStage, CallStatus, CapabilityId, MessageChannelSetting, ToolHandler } from '@abos/contracts';
import type { ConsentEvidence, ConsentSource, FactsSnapshot } from '../tools/real/types';

export type { ConsentEvidence, ConsentSource, FactsSnapshot };

/** Which published agent version answers a phone number (SPEC 2.9 `live_agent`, P-06). */
export type LiveAgentResolution =
  | { state: 'none' }
  /** The agent the number points at is not live. Its identity, when known, lets the refused call be recorded (API.md 4). */
  | { state: 'paused'; businessId?: string | undefined; agentId?: string | undefined; agentVersionId?: string | undefined }
  | { state: 'live'; businessId: string; businessName: string; agentId: string; agentVersionId: string; spec: AgentSpec };

export interface LiveAgentPort {
  /** `phoneNumber` is the E.164 number the caller dialed (Twilio `To`). */
  resolve(phoneNumber: string): Promise<LiveAgentResolution>;
}

/** Reads the verified facts once, at the moment the agent version is pinned (FLOWS B2). */
export interface VoiceFactsPort {
  snapshot(businessId: string): Promise<FactsSnapshot>;
}

export type StartCallInput = {
  businessId: string;
  agentId: string;
  agentVersionId: string;
  /** Twilio CallSid. `calls.provider_call_id` is unique. */
  providerCallId: string;
  /** Only the last four digits of the caller's number are ever kept. */
  callerLast4?: string | undefined;
};

/** The `calls` table. The call starts `IN_PROGRESS` with stage `CALL_STARTED` and writes `call.started`. */
export interface CallsPort {
  /** A call already stored for this CallSid, so a retried webhook never creates a second credential. */
  findByProviderCallId(providerCallId: string): Promise<{ callId: string; status: CallStatus } | null>;
  startCall(input: StartCallInput): Promise<{ callId: string }>;
  /** null when no such call exists. */
  getStatus(callId: string): Promise<CallStatus | null>;
  /** Only while the call is IN_PROGRESS. */
  updateStage(callId: string, stage: CallStage): Promise<void>;
  /** Moves the call to COMPLETED, DROPPED or FAILED with the matching reason and writes `call.ended`. */
  endCall(callId: string, reason: CallEndReason): Promise<void>;
}

/** Writes activity events. Payloads carry fixed codes only, nothing from a request body or the caller. */
export interface VoiceEventsPort {
  /** `businessId` comes from trusted configuration, never the request. Absent when none is configured. */
  webhookRejected(input: { businessId?: string | undefined; payload: ActivityEventPayloads['webhook.rejected'] }): Promise<void>;
  guardrailRefused(input: { businessId: string; payload: ActivityEventPayloads['guardrail.refused'] }): Promise<void>;
}

/** The owner's decision on this call's proposal, from the executor (FLOWS 3.1). */
export type CallDecision = ({ kind: 'approved'; messageSent: boolean } | { kind: 'rejected' } | { kind: 'expired' }) & { proposalId?: string; approvalId?: string };

export interface CallDecisionsPort {
  /** Returns an unsubscribe function. */
  subscribe(callId: string, listener: (decision: CallDecision) => void): () => void;
}

/** Trusted conversation controller, never a model tool or a transcript parser in this module. */
export interface CallFinishesPort {
  subscribe(callId: string, listener: (event: { callId: string; agentVersionId: string; responseId: string }) => void): () => void;
}

export type VoiceToolsetContext = {
  businessId: string;
  agentVersionId: string;
  callId: string;
  /** The pinned agent version's capabilities. */
  capabilities: readonly CapabilityId[];
  /** The fact snapshot taken when the version was pinned. The toolset must not read facts again. */
  facts: FactsSnapshot;
  /**
   * PROPOSED (SPEC 2.9): the relay's trusted reader of this call's consent evidence. Pass it to the real
   * toolset as `consent`. It returns evidence only while a proposal for this call is being made.
   */
  consent?: ConsentSource | undefined;
};

/** The per-call toolset. `dispose` runs when the call ends and clears every per-call state. */
export type VoiceToolset = { handler: ToolHandler; dispose(): void };

/** Builds the real toolset for one call. Called once per call. */
export type VoiceToolsetFactory = (ctx: VoiceToolsetContext) => VoiceToolset;

/** Checks `X-Twilio-Signature` against the full webhook URL and the posted form parameters. */
export interface TwilioRequestValidator {
  validate(signature: string, url: string, params: Record<string, string>): boolean;
}

/**
 * The small socket surface the relay uses, for both the Twilio Media Stream and the OpenAI
 * Realtime connection. `ws` sockets are adapted to it; tests pass fakes.
 */
export interface DuplexSocket {
  readonly isOpen: boolean;
  /** Bytes queued but not yet written, for back-pressure. */
  readonly bufferedAmount: number;
  send(data: string): void;
  close(): void;
  /** Hard close after the close grace period. */
  terminate(): void;
  onOpen(fn: () => void): void;
  onMessage(fn: (data: string) => void): void;
  onClose(fn: (code: number) => void): void;
  onError(fn: (err: Error) => void): void;
}

/** Opens one OpenAI Realtime WebSocket for `model`. The API key stays inside the factory. */
export type OpenAISocketFactory = (args: { model: string }) => DuplexSocket;

/** Structured logger. Fastify's logger fits it. The relay wraps it so every field is redacted. */
export interface VoiceLogger {
  info(data: Record<string, unknown>, msg: string): void;
  warn(data: Record<string, unknown>, msg: string): void;
  error(data: Record<string, unknown>, msg: string): void;
}

/** What the webhook pins for a call and the stream credential carries to the WebSocket. */
export type PinnedCall = {
  callId: string;
  providerCallId: string;
  businessId: string;
  businessName: string;
  agentId: string;
  agentVersionId: string;
  spec: AgentSpec;
  facts: FactsSnapshot;
  /** The menu read when the call was pinned, for the prompt only. Absent when it could not be read. */
  menu?: readonly CatalogItem[] | undefined;
  /**
   * The caller's full E.164 number from the signed webhook's `From`, for the text step only. Pinned only
   * when the call could get the offer (channel sends, spec capability, A attestation, not forwarded) and
   * removed when the call's credential is ended or unusable. Held in memory with the call. Never logged, never in an event, never sent to the model (only its last four
   * digits), and stored only inside a proposal after the caller consented. Absent for anonymous,
   * restricted or malformed callers: those calls have no text step.
   */
  callerNumber?: string | undefined;
};

/** Deadlines and bounds of one relay, in milliseconds or counts. */
export type RelayLimits = {
  /** Socket open to Twilio `start`. */
  startTimeoutMs: number;
  /** `start` to `session.updated` (model connection and handshake). */
  setupTimeoutMs: number;
  /** No message from Twilio for this long ends the call. */
  idleTimeoutMs: number;
  maxSessionMs: number;
  /** How often the call status is re-read, so a call ended elsewhere stops this relay. */
  statusPollMs: number;
  /** Bound on `endCall` and on any port call during shutdown. */
  cleanupTimeoutMs: number;
  /** Close, then terminate after this grace period. */
  closeGraceMs: number;
  /** Per-tool deadline; the registry `timeoutMs` when absent. */
  toolTimeoutMs?: number | undefined;
  /** Model responses waiting for tool work. More are answered as unavailable. */
  maxPendingResponses: number;
  /** Issue #95 item 8: function calls the model may make on one call, whatever their name. More are refused and recorded. */
  maxToolCalls: number;
  /** Proposals one call may store: distinct approvals, plus proposals whose result is unknown. More are refused and recorded. */
  maxProposals: number;
  /** Unacknowledged marks before the call fails for back-pressure. */
  maxPendingMarks: number;
  /** Bytes queued on the Twilio socket before the call fails for back-pressure. */
  maxBufferedBytes: number;
  /** FLOWS 3.1: still pending this long after a proposal, say goodbye and end the call. */
  pendingWaitMs: number;
  /** After the goodbye instruction, the longest wait for the goodbye to finish playing. */
  goodbyeMaxMs: number;
  /**
   * PROPOSED text step: the longest wait, per attempt, for the offer to finish playing, and again for
   * the caller's answer after it. Past it the caller has declined.
   */
  consentWindowMs: number;
};

/** The cached menu of a business (`catalog_items`, P-10). */
export interface VoiceMenuPort {
  snapshot(businessId: string): Promise<CatalogItem[]>;
}

export type VoicePluginOptions = {
  /** Public https origin Twilio reaches, for example the tunnel URL. Used for the signature URL and the stream URL. */
  publicServerUrl: string;
  liveAgent: LiveAgentPort;
  facts: VoiceFactsPort;
  /** Reads the cached menu of a business when a call is pinned, so the agent knows it from the first word. Display only: totals still come from quote_order. */
  menu?: VoiceMenuPort | undefined;
  /** The longest the webhook waits for the menu before the call goes on without it. Defaults to 1500. */
  menuTimeoutMs?: number | undefined;
  calls: CallsPort;
  events: VoiceEventsPort;
  decisions?: CallDecisionsPort | undefined;
  finishes?: CallFinishesPort | undefined;
  toolsetFactory: VoiceToolsetFactory;
  twilioValidator: TwilioRequestValidator;
  openaiSocketFactory: OpenAISocketFactory;
  /** The server's MESSAGE_CHANNEL setting, for the consent question and the wait script. */
  messageChannel: MessageChannelSetting;
  /** Human fallback (B-28) at the relay's hook points. Absent: those failures end the call as before. */
  fallback?: import('./relay').RelayFallback | undefined;
  /** The business that owns the Twilio integration, from configuration. Used only for `webhook.rejected`. */
  twilioBusinessId?: string | undefined;
  /** Defaults to REALTIME_MODEL from the contracts. */
  model?: string | undefined;
  voice?: string | undefined;
  /** Secrets to strip from every log line, for example OPENAI_API_KEY and TWILIO_AUTH_TOKEN. */
  redactSecrets?: readonly string[] | undefined;
  /** Defaults to the Fastify logger. */
  logger?: VoiceLogger | undefined;
  /** Clock in epoch milliseconds, for tokens and timing. */
  now?: (() => number) | undefined;
  tokenTtlMs?: number | undefined;
  limits?: Partial<RelayLimits> | undefined;
  /** Tests only: receives the plugin's stream credential store, so a test can inspect what stays pinned. */
  inspectTokens?: ((store: import('./logic').StreamTokenStore<PinnedCall>) => void) | undefined;
};
