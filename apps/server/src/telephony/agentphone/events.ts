// AgentPhone webhook payloads to provider-neutral events. Shapes from the vendor's documentation, not tested:
// https://docs.agentphone.ai/documentation/guides/webhooks.md ("Payloads"). Only routing fields are read.
// The caller's transcript is passed on as data for one agent turn; message bodies are never read.
import { E164Schema } from '@abos/contracts';
import { z } from 'zod';
import type { TelephonyEvent } from '../types';

const Envelope = z.object({
  event: z.string().min(1).max(100),
  channel: z.string().max(40).nullish(),
  test: z.boolean().optional(),
  data: z.record(z.string(), z.unknown()).nullish(),
});

const ProviderId = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/);
const VoiceData = z.object({ callId: ProviderId, to: E164Schema, from: z.string().max(40).optional(), transcript: z.string().max(4000).optional() });
const TextData = z.object({ messageId: ProviderId, to: E164Schema });
const CallEndedData = z.object({ callId: ProviderId, status: z.string().max(40).optional() });

/** Last four digits only (voice NOTES: no full caller number is kept). */
function last4(from: string | undefined): string | undefined {
  const digits = (from ?? '').replace(/\D/g, '');
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
    return { eventType, test, event: { kind: 'incoming_call', providerCallId: d.data.callId, to: d.data.to, callerLast4: last4(d.data.from), text: d.data.transcript ?? '' } };
  }
  if (eventType === 'agent.message') {
    const d = TextData.safeParse(data);
    if (!d.success) return undefined;
    return { eventType, test, event: { kind: 'incoming_text', providerMessageId: d.data.messageId, to: d.data.to } };
  }
  if (eventType === 'agent.call_ended') {
    const d = CallEndedData.safeParse(data);
    if (!d.success) return undefined;
    const reason = d.data.status === 'completed' ? 'completed' : d.data.status === 'failed' ? 'failed' : 'dropped';
    return { eventType, test, event: { kind: 'call_status', providerCallId: d.data.callId, reason } };
  }
  // agent.reaction, agent.contact_shared, number.released and anything new: verified, stored, not acted on.
  return { eventType, test, event: { kind: 'ignored', eventType } };
}
