import type { ActivityEventOf, BusinessFact, CallEndReason, CallStatus } from '@abos/contracts';

/** Internal routing reasons, not new contract states or event types. */
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

/** Populated by account configuration, never by a caller or the model. */
export type OwnedCallerId = { number: string; accountOwned: boolean };

export type FallbackTwimlInput = {
  reason: FallbackReason;
  /** Already verified by the router's fact port. This pure builder still checks E.164. */
  fallbackNumber?: string;
  businessName: string;
  callerId?: OwnedCallerId;
};

export type FallbackRequest = {
  businessId: string;
  callId: string;
  providerCallId: string;
  businessName: string;
  mode: 'webhook' | 'stream';
  signals: FallbackInput;
};

export type CallUpdateInstruction = {
  providerCallId: string;
  twiml: string;
  /** Stable infrastructure operation key, including across timeouts and process restarts. */
  idempotencyKey: string;
};

export type FallbackResult =
  | { kind: 'continue' }
  | { kind: 'duplicate' }
  | { kind: 'webhook'; reason: FallbackReason; twiml: string }
  | { kind: 'redirect'; reason: FallbackReason; instruction: CallUpdateInstruction }
  | { kind: 'redirect_unknown'; reason: FallbackReason };

export type FallbackAttempt = {
  businessId: string;
  callId: string;
  providerCallId: string;
  reason: FallbackReason;
  mode: FallbackRequest['mode'];
  disposition: 'dial' | 'hangup';
  fallbackLast4?: string;
  idempotencyKey: string;
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
  idempotencyKey: string;
};

export interface FallbackPorts {
  facts: {
    /** Return the business's contact/fallback_phone_number fact; absence means no destination. */
    readFallbackNumber(businessId: string): Promise<BusinessFact | null>;
  };
  callerId: {
    /** Assert ownership using trusted Twilio account configuration. Absence disables dialing. */
    readOwnedNumber(businessId: string): Promise<OwnedCallerId | null>;
  };
  attempts: {
    /** Durable atomic reservation. False means already attempted. Never release on unknown results. */
    claim(idempotencyKey: string): Promise<boolean>;
    /** Idempotent internal audit record; no full phone numbers, model text, or secrets. */
    record(attempt: FallbackAttempt): Promise<void>;
  };
  calls: {
    /** Adapter implements client.calls(providerCallId).update({ twiml }). Never retry blindly. */
    update(instruction: CallUpdateInstruction): Promise<void>;
  };
  outcomes: {
    /**
     * Atomically update the matching IN_PROGRESS call and insert its one call.ended event.
     * Check businessId, callId and providerCallId against stored routing attempts. A replay or
     * already terminal call changes nothing. The same transaction must deduplicate other end paths.
     */
    record(outcome: FallbackOutcome): Promise<void>;
  };
}
