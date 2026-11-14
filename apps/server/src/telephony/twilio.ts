// The Twilio telephony provider (D-12): the thinnest wrapper over code that already exists, with no change
// in behavior. The voice webhook and the Media Stream relay (voice/plugin.ts, voice/relay.ts) and the status
// webhook (webhooks/plugin.ts) stay registered exactly as before; this object only describes them behind the
// shared interface and reuses their validator, parser and health probe. It sends nothing.
import { WEBHOOK_ENDPOINTS } from '@abos/contracts';
import type { HealthProbe } from '../compose/health';
import type { TwilioRequestValidator } from '../voice/types';
import { parseTwilioStatus } from '../webhooks/twilio-status';
import type { TelephonyEvent, TelephonyProvider, VerifiedWebhook } from './types';

const CALL_REASON: Record<string, 'completed' | 'dropped' | 'failed' | undefined> = {
  completed: 'completed', busy: 'dropped', 'no-answer': 'dropped', canceled: 'dropped', failed: 'failed',
};
const RECEIPT: Record<string, 'DELIVERED' | 'FAILED' | undefined> = { delivered: 'DELIVERED', read: 'DELIVERED', failed: 'FAILED', undelivered: 'FAILED' };

export function createTwilioProvider(input: {
  phoneNumber: string | undefined;
  publicServerUrl: string | undefined;
  validator: TwilioRequestValidator | undefined;
  probe: HealthProbe | undefined;
  /** What already keeps the Twilio phone path off (compose/index.ts voiceMissing). */
  missing: readonly string[];
}): TelephonyProvider {
  const statusUrl = `${(input.publicServerUrl ?? '').replace(/\/+$/, '')}${WEBHOOK_ENDPOINTS.twilioStatus.path}`;
  return {
    name: 'twilio',
    missing: input.missing,
    phoneNumber: input.phoneNumber,
    answering: { kind: 'media_stream', voiceWebhookPath: WEBHOOK_ENDPOINTS.twilioVoice.path },
    probe: input.probe,
    verifyWebhook({ rawBody, headers }): VerifiedWebhook {
      const params: Record<string, string> = Object.fromEntries(new URLSearchParams(rawBody.toString('utf8')));
      const header = headers[WEBHOOK_ENDPOINTS.twilioStatus.signatureHeader];
      if (!input.validator || typeof header !== 'string' || !input.publicServerUrl || !input.validator.validate(header, statusUrl, params)) return { ok: false, reason: 'signature_invalid' };
      const parsed = parseTwilioStatus(params);
      if (!parsed) return { ok: true, deliveryId: 'unparsed', eventType: 'unknown', test: false, event: { kind: 'ignored', eventType: 'unknown' } };
      const providerId = parsed.payload.providerId ?? '';
      const status = parsed.payload.status ?? '';
      let event: TelephonyEvent = { kind: 'ignored', eventType: parsed.eventType };
      if (parsed.eventType === 'call.status' && CALL_REASON[status]) event = { kind: 'call_status', providerCallId: providerId, reason: CALL_REASON[status]! };
      if (parsed.eventType === 'message.status' && RECEIPT[status]) event = { kind: 'delivery_receipt', providerMessageId: providerId, status: RECEIPT[status]! };
      return { ok: true, deliveryId: parsed.providerEventId, eventType: parsed.eventType, test: false, event };
    },
  };
}
