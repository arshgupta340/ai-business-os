// The telephony switch (D-12). TELEPHONY_PROVIDER = twilio (default) | agentphone picks which provider
// answers calls. Selecting a provider whose settings are missing never falls back to the other one: the
// selected provider reports what is missing (health shows it on the phone-line entry, the route answers 503).
import type { Env } from '../env';
import type { MessageAdapter } from '../adapters/message/index';
import type { HealthProbe } from '../compose/health';
import type { TwilioRequestValidator } from '../voice/types';
import { createAgentPhoneProvider, type AgentPhoneProvider } from './agentphone/index';
import type { HttpPort } from './agentphone/client';
import { createTwilioProvider } from './twilio';
import type { TelephonyProvider, TelephonyProviderName } from './types';

export type * from './types';
export { createAgentPhoneProvider, type AgentPhoneProvider } from './agentphone/index';
export { createTwilioProvider } from './twilio';

export interface Telephony {
  /** The provider TELEPHONY_PROVIDER selected. */
  active: TelephonyProvider;
  name: TelephonyProviderName;
  /** Built whenever AgentPhone settings or the agentphone message channel are in use, also for texting only. */
  agentphone: AgentPhoneProvider | undefined;
}

const defaultHttp: HttpPort = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, json: () => res.json() as Promise<unknown> };
};

export function buildTelephony(env: Env, ports: {
  now(): Date;
  twilio: { validator: TwilioRequestValidator | undefined; messageAdapter: MessageAdapter | undefined; probe: HealthProbe | undefined; missing: readonly string[] };
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  http?: HttpPort;
}): Telephony {
  const name: TelephonyProviderName = env.TELEPHONY_PROVIDER ?? 'twilio';
  const wantsAgentPhone = name === 'agentphone' || env.MESSAGE_CHANNEL === 'agentphone';
  const agentphone = wantsAgentPhone ? createAgentPhoneProvider({
    apiKey: env.AGENTPHONE_API_KEY, webhookSecret: env.AGENTPHONE_WEBHOOK_SECRET, numberId: env.AGENTPHONE_NUMBER_ID, phoneNumber: env.AGENTPHONE_PHONE_NUMBER,
  }, { fetch: ports.fetch ?? ((url, init) => fetch(url, init)), http: ports.http ?? defaultHttp, nowMs: () => ports.now().getTime(), publicServerUrl: env.PUBLIC_SERVER_URL }) : undefined;
  const twilio = createTwilioProvider({ phoneNumber: env.TWILIO_PHONE_NUMBER, publicServerUrl: env.PUBLIC_SERVER_URL, ...ports.twilio });
  return { name, agentphone, active: name === 'agentphone' && agentphone ? agentphone : twilio };
}
