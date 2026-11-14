// The AgentPhone telephony provider (D-12). Built from injected ports: HTTP for the REST reads (GET only)
// and a clock for the signature window. Nothing here reads the environment or the network by itself, and
// nothing here can send a text: the agentphone message channel is built once, in compose/providers.ts, and
// only the executor's approved message step reaches it.
import { WEBHOOK_ENDPOINTS } from '@abos/contracts';
import type { HealthProbe } from '../../compose/health';
import type { TelephonyProvider, VerifiedWebhook } from '../types';
import { createAgentPhoneClient, type AgentPhoneClient, type HttpPort } from './client';
import { parseAgentPhoneEvent } from './events';
import { formatTurnChunks, AGENTPHONE_NDJSON } from './plugin';
import { verifyAgentPhoneSignature } from './signature';

export interface AgentPhoneSettings {
  apiKey?: string | undefined;
  webhookSecret?: string | undefined;
  numberId?: string | undefined;
  phoneNumber?: string | undefined;
  baseUrl?: string | undefined;
}

/** Every setting the AgentPhone provider needs, by name (never values). */
export function missingAgentPhoneSettings(s: AgentPhoneSettings, publicServerUrl: string | undefined): string[] {
  return [
    ...(s.apiKey ? [] : ['AGENTPHONE_API_KEY']),
    ...(s.webhookSecret ? [] : ['AGENTPHONE_WEBHOOK_SECRET']),
    ...(s.numberId ? [] : ['AGENTPHONE_NUMBER_ID']),
    ...(s.phoneNumber ? [] : ['AGENTPHONE_PHONE_NUMBER']),
    ...(publicServerUrl ? [] : ['PUBLIC_SERVER_URL']),
  ];
}

export type AgentPhoneProvider = TelephonyProvider & { name: 'agentphone'; client: AgentPhoneClient | undefined };

export function createAgentPhoneProvider(settings: AgentPhoneSettings, ports: { http: HttpPort; nowMs(): number; publicServerUrl: string | undefined }): AgentPhoneProvider {
  const missing = missingAgentPhoneSettings(settings, ports.publicServerUrl);
  const client = settings.apiKey && settings.numberId
    ? createAgentPhoneClient({ apiKey: settings.apiKey, numberId: settings.numberId, http: ports.http, ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}) })
    : undefined;

  // Read only and bounded by the client's timeout: the number exists and its outbound SMS readiness.
  const probe: HealthProbe | undefined = client ? async () => {
    try {
      const n = await client.getNumber();
      if (n.outboundSms === 'enabled') return { ok: true, detail: 'agentphone number readable; outbound SMS enabled' };
      // Calls work without SMS registration; texts to US numbers do not (docs/notes-agentphone.md, A2P 10DLC).
      return { ok: true, detail: `agentphone number readable; outbound SMS ${n.outboundSms}` };
    } catch { return { ok: false, detail: 'AgentPhone refused the number read' }; }
  } : undefined;

  return {
    name: 'agentphone',
    missing,
    phoneNumber: settings.phoneNumber,
    answering: { kind: 'turn_webhook', webhookPath: WEBHOOK_ENDPOINTS.agentphone.path, contentType: AGENTPHONE_NDJSON, format: formatTurnChunks },
    client,
    probe,
    verifyWebhook({ rawBody, headers }): VerifiedWebhook {
      const sig = verifyAgentPhoneSignature({ rawBody, headers, secret: settings.webhookSecret, nowMs: ports.nowMs() });
      if (!sig.ok) return { ok: false, reason: 'signature_invalid' };
      const parsed = parseAgentPhoneEvent(rawBody);
      if (!parsed) return { ok: false, reason: 'malformed' };
      return { ok: true, deliveryId: sig.deliveryId, eventType: parsed.eventType, test: parsed.test, event: parsed.event };
    },
  };
}
