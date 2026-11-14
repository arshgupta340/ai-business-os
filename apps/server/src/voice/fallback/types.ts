import type { ActivityEventOf, BusinessFact, CallEndReason, CallStatus } from '@abos/contracts';

export type FallbackReason =
  | 'caller_requested_person'
  | 'repeated_guardrail_refusals'
  | 'repeated_tool_failures'
  | 'model_session_failed'
  | 'live_agent_unavailable'
  | 'phone_line_overloaded';

/** Trusted tool/refusal and relay outcomes only. Never populate by parsing caller text here. */
export type FallbackInput = {
  callerRequestedPerson?: boolean;
  guardrailRefusals?: number;
  toolFailures?: number;
  modelSessionFailed?: boolean;
  modelSessionReady?: boolean;
  liveAgentMissing?: boolean;
  liveAgentUnpublished?: boolean;
  phoneLineOverloaded?: boolean;
};

export type FallbackDecision = { handoff: false } | { handoff: true; reason: FallbackReason };
export type OwnedCallerId = { number: string; accountOwned: boolean };

export type FallbackTwimlInput = {
  reason: FallbackReason;
  fallbackNumber?: string;
  businessName: string;
  callerId?: OwnedCallerId;
};

/** IDs come from a signature-verified webhook or an already bound media stream, never caller text. */
export type FallbackRequest = {
  businessId: string;
  callId: string;
  providerCallId: string;
  /** Ignored by the router. The reservation routine returns the trusted business name. */
  businessName: string;
  mode: 'webhook' | 'stream';
  signals: FallbackInput;
};

export type CallUpdateInstruction = {
  providerCallId: string;
  twiml: string;
  /** One key returned by the durable reservation for this provider call. */
  idempotencyKey: string;
};

export type FallbackResult =
  | { kind: 'continue' }
  | { kind: 'duplicate' }
  | { kind: 'blocked' }
  | { kind: 'webhook'; reason: FallbackReason; twiml: string }
  | { kind: 'redirect'; reason: FallbackReason; instruction: CallUpdateInstruction }
  | { kind: 'redirect_unknown'; reason: FallbackReason };

/** A trusted database routine returns this only after reserving the unique provider-call operation. */
export type FallbackReservation = {
  businessId: string;
  callId: string;
  providerCallId: string;
  businessName: string;
  callStatus: 'IN_PROGRESS';
  channel: 'phone';
  /** Derived from the published version pinned to this stored call. */
  humanFallbackEnabled: true;
  /** The stored verified business fact returned by the same checked routine. */
  fallbackFact: BusinessFact;
  idempotencyKey: string;
};

export type ReserveFallbackInput = {
  businessId: string;
  callId: string;
  providerCallId: string;
  reason: FallbackReason;
};

/** Only call after signature verification, deduplication, and resolution of the trusted call row. */
export type ConfirmedFallbackEnd = {
  businessId: string;
  callId: string;
  providerCallId: string;
  reason: CallEndReason;
  durationSec: number;
  occurredAt: string;
};

export type FallbackOutcome = ConfirmedFallbackEnd & {
  status: CallStatus;
  event: ActivityEventOf<'call.ended'>;
  /** Stable provider-call key. The outcome routine resolves the bound reservation before changing state. */
  idempotencyKey: string;
};

export interface FallbackPorts {
  callerId: {
    /** Trusted account configuration only. Implementations must honor abort before any external work begins. */
    readOwnedNumber(businessId: string, signal: AbortSignal): Promise<OwnedCallerId | null>;
  };
  fallback: {
    /**
     * One checked database routine: lock the active phone call, require matching business and provider SID,
     * require the call's published version to enable fallback, read a verified contact/fallback_phone_number
     * fact, and reserve one immutable operation per provider call. Null fails closed.
     */
    reserve(input: ReserveFallbackInput, signal: AbortSignal): Promise<FallbackReservation | null>;
    /**
     * One checked database routine: recheck that the reserved call remains IN_PROGRESS, persist the exact
     * TwiML hash/material and mark dispatch started. It must return false after terminal handling wins.
     */
    beginDispatch(input: CallUpdateInstruction, signal: AbortSignal): Promise<boolean>;
  };
  calls: {
    /** The adapter may call Twilio only while signal is not aborted. It must not log the instruction. */
    update(instruction: CallUpdateInstruction, signal: AbortSignal): Promise<void>;
  };
  outcomes: {
    /**
     * One checked database routine: resolve the reservation, conditionally end its matching IN_PROGRESS call,
     * and insert one call.ended event. Replays and competing end paths change nothing.
     */
    record(outcome: FallbackOutcome): Promise<void>;
  };
}

export type FallbackRouterOptions = {
  now?: () => number;
  routingDeadlineMs?: number;
};
