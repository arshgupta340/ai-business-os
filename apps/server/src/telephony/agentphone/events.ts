// AgentPhone webhook payloads to provider-neutral events. Shapes from the vendor's documentation, not tested:
// https://docs.agentphone.ai/documentation/guides/webhooks.md ("Payloads"). Only routing fields are read.
// The caller's transcript is passed on as data for one agent turn; message bodies are never read.
import { E164Schema } from '@abos/contracts';
import { z } from 'zod';
import type { TelephonyEvent } from '../types';

// Only the fields this server routes on are validated: the event name, the provider's object ID and the
// dialed number. Everything else in a signed delivery is optional context whose exact shape the vendor's
// documentation does not promise (a withheld caller number, a missing transcript, an unexpected status), so
// it is read leniently and never makes the delivery malformed. A refused voice turn is silence for the
// caller, and a refused agent.call_ended (sent once) would leave the call open with no row to recover from.
const Envelope = z.object({
  event: z.string().min(1).max(100),
  channel: z.unknown().optional(),
  test: z.unknown().optional(),
  data: z.record(z.string(), z.unknown()).nullish(),
});

const ProviderId = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/);
const VoiceData = z.object({ callId: ProviderId, to: E164Schema });
const TextData = z.object({ messageId: ProviderId, to: E164Schema });
const CallEndedData = z.object({ callId: ProviderId });

/** The most transcript one turn hands to the agent. The turn runner bounds it again. */
export const MAX_TRANSCRIPT_CHARS = 4000;

/** Last four digits only (voice NOTES: no full caller number is kept). Anything that is not a short string has none. */
function last4(from: unknown): string | undefined {
  if (typeof from !== 'string' || from.length > 40) return undefined;
  const digits = from.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : undefined;
}

export type ParsedAgentPhone = { eventType: string; test: boolean; event: TelephonyEvent } | undefined;

/** Undefined means malformed (not JSON, or a known event without its routing fields). */
export function parseAgentPhoneEvent(rawBody: Buffer): ParsedAgentPhone {
  let json: unknown;
  try { json = JSON.parse(rawBody.toString('utf8')); } catch { return undefined; }
  const env = Envelope.safeParse(json);
  if (!env.success) return undefined;
  const { event: eventType, channel, data } = env.data;
  const test = env.data.test === true;
  if (eventType === 'agent.message' && channel === 'voice') {
    const d = VoiceData.safeParse(data);
    if (!d.success) return undefined;
    const transcript = typeof data?.transcript === 'string' ? data.transcript.slice(0, MAX_TRANSCRIPT_CHARS) : '';
    return { eventType, test, event: { kind: 'incoming_call', providerCallId: d.data.callId, to: d.data.to, callerLast4: last4(data?.from), text: transcript } };
  }
  if (eventType === 'agent.message') {
    const d = TextData.safeParse(data);
    if (!d.success) return undefined;
    return { eventType, test, event: { kind: 'incoming_text', providerMessageId: d.data.messageId, to: d.data.to } };
  }
  if (eventType === 'agent.call_ended') {
    const d = CallEndedData.safeParse(data);
    if (!d.success) return undefined;
    const reason = data?.status === 'completed' ? 'completed' : data?.status === 'failed' ? 'failed' : 'dropped';
    return { eventType, test, event: { kind: 'call_status', providerCallId: d.data.callId, reason } };
  }
  // agent.reaction, agent.contact_shared, number.released and anything new: verified, stored, not acted on.
  return { eventType, test, event: { kind: 'ignored', eventType } };
}
