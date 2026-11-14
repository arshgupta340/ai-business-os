// Ports the phone voice worker needs. Each is implemented elsewhere (the live_agent and calls
// tables, the real toolset, Twilio, OpenAI) and injected, so tests can pass fakes.
import type { AgentSpec, CallEndReason, CallStage, CallStatus, CapabilityId, MessageChannelSetting, ToolHandler } from '@abos/contracts';

/** Which published agent version answers a phone number (SPEC 2.9 `live_agent`, P-06). */
export type LiveAgentResolution =
  | { state: 'none' }
  | { state: 'paused' }
  | { state: 'live'; businessId: string; businessName: string; agentId: string; agentVersionId: string; spec: AgentSpec };

export interface LiveAgentPort {
  /** `phoneNumber` is the E.164 number the caller dialed (Twilio `To`). */
  resolve(phoneNumber: string): Promise<LiveAgentResolution>;
}

export type StartCallInput = {
  businessId: string;
  agentId: string;
  agentVersionId: string;
  /** Twilio CallSid. `calls.provider_call_id` is unique, so a retried webhook must return the same call. */
  providerCallId: string;
  /** Only the last four digits of the caller's number are ever kept. */
  callerLast4?: string | undefined;
};

/** The `calls` table. The call starts `IN_PROGRESS` with stage `CALL_STARTED` and writes `call.started`. */
export interface CallsPort {
  startCall(input: StartCallInput): Promise<{ callId: string }>;
  /** null when no such call exists. */
  getStatus(callId: string): Promise<CallStatus | null>;
  updateStage(callId: string, stage: CallStage): Promise<void>;
  /** Moves the call to COMPLETED, DROPPED or FAILED with the matching reason and writes `call.ended`. */
  endCall(callId: string, reason: CallEndReason): Promise<void>;
}

export type VoiceToolsetContext = {
  businessId: string;
  agentVersionId: string;
  callId: string;
  /** The pinned agent version's capabilities. */
  capabilities: readonly CapabilityId[];
};

/** Builds the real toolset for one call. Called once per call, so the call keeps its fact snapshot. */
export type VoiceToolsetFactory = (ctx: VoiceToolsetContext) => ToolHandler;

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
  send(data: string): void;
  close(): void;
  onOpen(fn: () => void): void;
  onMessage(fn: (data: string) => void): void;
  onClose(fn: (code: number) => void): void;
  onError(fn: (err: Error) => void): void;
}

/** Opens one OpenAI Realtime WebSocket for `model`. The API key stays inside the factory. */
export type OpenAISocketFactory = (args: { model: string }) => DuplexSocket;

/** Structured logger. Fastify's logger fits it. Never pass a phone number, token, key, audio or transcript. */
export interface VoiceLogger {
  info(data: Record<string, unknown>, msg: string): void;
  warn(data: Record<string, unknown>, msg: string): void;
  error(data: Record<string, unknown>, msg: string): void;
}

/** What the webhook pins for a call and the stream token carries to the WebSocket. */
export type PinnedCall = {
  callId: string;
  providerCallId: string;
  businessId: string;
  businessName: string;
  agentId: string;
  agentVersionId: string;
  spec: AgentSpec;
};

export type VoicePluginOptions = {
  /** Public https origin Twilio reaches, for example the tunnel URL. Used for the signature URL and the stream URL. */
  publicServerUrl: string;
  liveAgent: LiveAgentPort;
  calls: CallsPort;
  toolsetFactory: VoiceToolsetFactory;
  twilioValidator: TwilioRequestValidator;
  openaiSocketFactory: OpenAISocketFactory;
  /** The server's MESSAGE_CHANNEL setting, for the consent question and the wait script. */
  messageChannel: MessageChannelSetting;
  /** Defaults to REALTIME_MODEL from the contracts. */
  model?: string | undefined;
  voice?: string | undefined;
  /** Secrets to strip from any logged provider error, for example OPENAI_API_KEY. */
  redactSecrets?: readonly string[] | undefined;
  /** Defaults to the Fastify logger. */
  logger?: VoiceLogger | undefined;
  /** Clock in epoch milliseconds, for tokens and timing. */
  now?: (() => number) | undefined;
  tokenTtlMs?: number | undefined;
};
