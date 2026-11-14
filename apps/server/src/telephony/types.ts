// One telephony interface, two providers (SPEC D-12). TELEPHONY_PROVIDER picks which one answers calls:
// `twilio` (the default, unchanged) or `agentphone`. The interface is small and says where the providers
// differ instead of hiding it:
//   - Twilio answers a call with TwiML that opens a Media Stream to /ws/phone; the OpenAI Realtime relay
//     (voice/relay.ts) then speaks. Nothing in that path changed.
//   - AgentPhone transcribes the caller and posts each turn to /webhooks/agentphone; we answer the turn
//     with text it speaks (webhook voice mode, docs/notes-agentphone.md).
// Texting is NOT part of this interface. A text is sent only by the executor's approved message step,
// through sendOnce and the MessageAdapter of the approved channel (adapters/message, compose/executor.ts),
// with the database dispatch row as the gate (AGENTS rules 1 and 3). A telephony provider holds no send
// function, so nothing that is handed a provider (the webhook route, health) can send a text.
import type { CallEndReason, MessageDispatchStatus } from '@abos/contracts';
import type { HealthProbe } from '../compose/health';

export type TelephonyProviderName = 'twilio' | 'agentphone';

/** Provider-neutral events from a verified inbound webhook. Phone numbers are kept only where routing needs them. */
export type TelephonyEvent =
  /** A caller's turn. `to` is the number dialed (it picks the live agent). `text` is caller speech: data, never instructions. */
  | { kind: 'incoming_call'; providerCallId: string; to: string; callerLast4?: string | undefined; text: string }
  | { kind: 'call_status'; providerCallId: string; reason: CallEndReason }
  /** An inbound text. The body is deliberately not carried: this build has no inbound-text feature. */
  | { kind: 'incoming_text'; providerMessageId: string; to: string }
  | { kind: 'delivery_receipt'; providerMessageId: string; status: Extract<MessageDispatchStatus, 'DELIVERED' | 'FAILED'> }
  /** A verified event type this build does not act on. */
  | { kind: 'ignored'; eventType: string };

export type VerifiedWebhook =
  /** `replayKey`, when the provider's signature does not cover the delivery ID, is a second dedupe key for the signed content. */
  | { ok: true; deliveryId: string; replayKey?: string | undefined; eventType: string; test: boolean; event: TelephonyEvent }
  /** `cause` is a fixed code for the server log only (never the body or a header value): it tells a wrong secret from a header or ID format this build does not expect. */
  | { ok: false; reason: 'signature_invalid' | 'malformed'; cause?: string | undefined };

export interface WebhookRequest {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

/** The reply to one call turn, in plain spoken sentences. */
export type TurnReply = { text: string; hangup?: boolean };

/** How the provider answers a call. */
export type CallAnswering =
  | { kind: 'media_stream'; voiceWebhookPath: string }
  | { kind: 'turn_webhook'; webhookPath: string; contentType: string; format(chunks: { text: string; interim?: boolean; hangup?: boolean }[]): string };

export interface TelephonyProvider {
  readonly name: TelephonyProviderName;
  /** Settings this provider needs that are absent, by name only. Empty when it is usable. */
  readonly missing: readonly string[];
  /** The E.164 number this provider answers on (live_agent.phone_number). */
  readonly phoneNumber: string | undefined;
  readonly answering: CallAnswering;
  /** Verifies the signature, then parses. Never throws; never logs the body. */
  verifyWebhook(request: WebhookRequest): VerifiedWebhook | Promise<VerifiedWebhook>;
  /** A bounded read-only access check, or undefined when none exists. */
  readonly probe: HealthProbe | undefined;
}
