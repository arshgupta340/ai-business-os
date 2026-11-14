// Ports the phone voice worker needs. Each is implemented elsewhere (the live_agent, calls and
// activity_events tables, the real toolset, Twilio, OpenAI) and injected, so tests can pass fakes.
import type { ActivityEventPayloads, AgentSpec, CallEndReason, CallStage, CallStatus, CapabilityId, MessageChannelSetting, ToolHandler } from '@abos/contracts';
import type { FactsSnapshot } from '../tools/real/types';

export type { FactsSnapshot };

/** Which published agent version answers a phone number (SPEC 2.9 `live_agent`, P-06). */
export type LiveAgentResolution =
  | { state: 'none' }
  | { state: 'paused' }
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
export type CallDecision = { kind: 'approved'; messageSent: boolean } | { kind: 'rejected' } | { kind: 'expired' };

export interface CallDecisionsPort {
  /** Returns an unsubscribe function. */
  subscribe(callId: string, listener: (decision: CallDecision) => void): () => void;
}

export type VoiceToolsetContext = {
  businessId: string;
  agentVersionId: string;
  callId: string;
  /** The pinned agent version's capabilities. */
  capabilities: readonly CapabilityId[];
  /** The fact snapshot taken when the version was pinned. The toolset must not read facts again. */
  facts: FactsSnapshot;
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
  /** Unacknowledged marks before the call fails for back-pressure. */
  maxPendingMarks: number;
  /** Bytes queued on the Twilio socket before the call fails for back-pressure. */
  maxBufferedBytes: number;
  /** FLOWS 3.1: still pending this long after a proposal, say goodbye and end the call. */
  pendingWaitMs: number;
  /** After the goodbye instruction, the longest wait for the goodbye to finish playing. */
  goodbyeMaxMs: number;
};

export type VoicePluginOptions = {
  /** Public https origin Twilio reaches, for example the tunnel URL. Used for the signature URL and the stream URL. */
  publicServerUrl: string;
  liveAgent: LiveAgentPort;
  facts: VoiceFactsPort;
  calls: CallsPort;
  events: VoiceEventsPort;
  decisions?: CallDecisionsPort | undefined;
  toolsetFactory: VoiceToolsetFactory;
  twilioValidator: TwilioRequestValidator;
  openaiSocketFactory: OpenAISocketFactory;
  /** The server's MESSAGE_CHANNEL setting, for the consent question and the wait script. */
  messageChannel: MessageChannelSetting;
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
};
