// Provider clients built from the environment. Every one is optional: a missing or unusable key
// leaves that provider undefined, the feature that needs it answers INTEGRATION_UNAVAILABLE, and
// GET /api/integrations/health reports it as not connected. Nothing here performs a provider call
// at startup. Only the executor (B-11) may use the write paths of these adapters, and only for an
// approved step.
import { calendar } from '@googleapis/calendar';
import { sheets } from '@googleapis/sheets';
import { JWT } from 'google-auth-library';
import type { MessageChannelSetting } from '@abos/contracts';
import { createCalendarAdapter, type CalendarAdapter } from '../adapters/calendar/index';
import { createMessageAdapter, type MessageAdapter } from '../adapters/message/index';
import { createSheetsAdapter, type ReportingAdapter } from '../adapters/sheets/index';
import { createSandboxSquareClient, createSquareAdapter, type SquareAdapter } from '../adapters/square/index';
import { createPriceAdapter, type PriceAdapter } from '../adapters/square/price';
import type { Env } from '../env';
import type { HealthProbe } from './health';
import { createTwilioRequestValidator, createWsOpenAISocketFactory, type OpenAISocketFactory, type TwilioRequestValidator } from '../voice/plugin';

export type ProviderKey = 'square' | 'twilio' | 'openai' | 'google_calendar' | 'google_sheets' | 'message_channel';
/** Configuration only. `noProviderNeeded` marks a setting that talks to no provider (qr_only), so no probe is needed. */
export type ProviderStatus = { configured: boolean; detail: string; noProviderNeeded?: true };

export interface Providers {
  square?: SquareAdapter | undefined;
  /** P-11: read and write one variation's price at the configured location (sandbox only). */
  prices?: PriceAdapter | undefined;
  /** The Square location the checkout order is built for (the adapter refuses any other). */
  squareLocationId?: string | undefined;
  /** Reads a payment's Square status (FAILED, CANCELED, ...) for a payment that did not verify. Read only. */
  squarePaymentStatus?: ((paymentId: string) => Promise<string | undefined>) | undefined;
  calendar?: CalendarAdapter | undefined;
  /** The one demo calendar shared with the service account (P-15). */
  calendarId?: string | undefined;
  sheets?: ReportingAdapter | undefined;
  sheetId?: string | undefined;
  message?: MessageAdapter | undefined;
  messageChannel: MessageChannelSetting;
  twilioValidator?: TwilioRequestValidator | undefined;
  /** Twilio Calls update with inline TwiML, used only by human fallback (B-28). Honors the signal before sending. */
  twilioCalls?: { update(input: { callSid: string; twiml: string; signal: AbortSignal }): Promise<void> } | undefined;
  openaiSocketFactory?: OpenAISocketFactory | undefined;
  /** Why each provider is or is not configured. Never holds a value from the environment. */
  status: Record<ProviderKey, ProviderStatus>;
  /** Bounded read-only access checks, run by integration health on refresh=1 (compose/health.ts). */
  probes?: Partial<Record<ProviderKey, HealthProbe>> | undefined;
}

const ok = (detail = 'configured'): ProviderStatus => ({ configured: true, detail });
const missing = (...names: string[]): ProviderStatus => ({ configured: false, detail: `missing ${names.join(', ')}` });
const invalid = (name: string): ProviderStatus => ({ configured: false, detail: `${name} is not usable` });

function googleAuth(json: string | undefined, scopes: string[]): JWT | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as { client_email?: unknown; private_key?: unknown };
    // Review finding 5: empty or malformed fields are not usable credentials.
    if (typeof parsed.client_email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(parsed.client_email.trim())) return undefined;
    if (typeof parsed.private_key !== 'string' || !/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----/.test(parsed.private_key)) return undefined;
    return new JWT({ email: parsed.client_email, key: parsed.private_key, scopes });
  } catch {
    return undefined;
  }
}

export function buildProviders(env: Env, now: () => Date, overrides: Partial<Providers> = {}): Providers {
  const status = {} as Record<ProviderKey, ProviderStatus>;
  // Every probe is a read: list one payment, read calendar or sheet metadata, read the account or models.
  const probes: Partial<Record<ProviderKey, HealthProbe>> = {};
  const fixed = (ok: boolean, detail: string) => (ok ? { ok: true as const, detail } : { ok: false as const, detail });

  // Square: sandbox only (AGENTS rule 4). env.ts already refuses any other SQUARE_ENVIRONMENT.
  let square: SquareAdapter | undefined;
  let squarePaymentStatus: Providers['squarePaymentStatus'];
  let prices: PriceAdapter | undefined;
  if (env.SQUARE_ACCESS_TOKEN && env.SQUARE_LOCATION_ID) {
    const client = createSandboxSquareClient({ accessToken: env.SQUARE_ACCESS_TOKEN });
    square = createSquareAdapter({ client, locationId: env.SQUARE_LOCATION_ID, environment: env.SQUARE_ENVIRONMENT, now });
    prices = createPriceAdapter({ client, locationId: env.SQUARE_LOCATION_ID, environment: env.SQUARE_ENVIRONMENT });
    squarePaymentStatus = async (paymentId) => (await client.payments.get({ paymentId })).payment?.status ?? undefined;
    const locationId = env.SQUARE_LOCATION_ID;
    probes.square = async () => {
      try {
        const page = await client.payments.list({ locationId, beginTime: new Date(now().getTime() - 60_000).toISOString(), sortOrder: 'DESC', limit: 1 });
        for await (const _ of page) break;
        return fixed(true, 'sandbox reachable');
      } catch { return fixed(false, 'Square sandbox refused the read'); }
    };
    status.square = ok('sandbox');
  } else status.square = missing('SQUARE_ACCESS_TOKEN', 'SQUARE_LOCATION_ID');

  let calendarAdapter: CalendarAdapter | undefined;
  const calendarAuth = googleAuth(env.GOOGLE_SERVICE_ACCOUNT_JSON, ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.freebusy']);
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON || !env.GOOGLE_CALENDAR_ID) status.google_calendar = missing('GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_CALENDAR_ID');
  else if (!calendarAuth) status.google_calendar = invalid('GOOGLE_SERVICE_ACCOUNT_JSON');
  else {
    const client = calendar({ version: 'v3', auth: calendarAuth });
    calendarAdapter = createCalendarAdapter({ client, now });
    const calendarId = env.GOOGLE_CALENDAR_ID;
    probes.google_calendar = async () => {
      try { await client.calendars.get({ calendarId }); return fixed(true, 'calendar shared'); }
      catch { return fixed(false, 'calendar not readable by the service account'); }
    };
    status.google_calendar = ok();
  }

  let sheetsAdapter: ReportingAdapter | undefined;
  const sheetsAuth = googleAuth(env.GOOGLE_SERVICE_ACCOUNT_JSON, ['https://www.googleapis.com/auth/spreadsheets']);
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON || !env.GOOGLE_SHEET_ID) status.google_sheets = missing('GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_SHEET_ID');
  else if (!sheetsAuth) status.google_sheets = invalid('GOOGLE_SERVICE_ACCOUNT_JSON');
  else {
    const client = sheets({ version: 'v4', auth: sheetsAuth });
    sheetsAdapter = createSheetsAdapter({ client });
    const spreadsheetId = env.GOOGLE_SHEET_ID;
    probes.google_sheets = async () => {
      try { await client.spreadsheets.get({ spreadsheetId, fields: 'spreadsheetId' }); return fixed(true, 'sheet shared'); }
      catch { return fixed(false, 'sheet not readable by the service account'); }
    };
    status.google_sheets = ok();
  }

  // The message channel. qr_only needs no key and never sends (SPEC 2.9). Unset means qr_only,
  // the safe choice, but health still reports the setting as missing.
  const messageChannel: MessageChannelSetting = env.MESSAGE_CHANNEL ?? 'qr_only';
  let message: MessageAdapter | undefined;
  const channelKeys: Record<MessageChannelSetting, [string, string | undefined][]> = {
    qr_only: [],
    surge: [['SURGE_API_KEY', env.SURGE_API_KEY], ['SURGE_ACCOUNT_ID', env.SURGE_ACCOUNT_ID]],
    android_gateway: [['ANDROID_GATEWAY_URL', env.ANDROID_GATEWAY_URL], ['ANDROID_GATEWAY_API_KEY', env.ANDROID_GATEWAY_API_KEY]],
    whatsapp_sandbox: [['TWILIO_ACCOUNT_SID', env.TWILIO_ACCOUNT_SID], ['TWILIO_AUTH_TOKEN', env.TWILIO_AUTH_TOKEN]],
  };
  const absent = channelKeys[messageChannel].filter(([, v]) => !v).map(([k]) => k);
  if (!env.MESSAGE_CHANNEL) status.message_channel = missing('MESSAGE_CHANNEL');
  else if (absent.length > 0) status.message_channel = missing(...absent);
  else if (messageChannel === 'qr_only') status.message_channel = { configured: true, detail: 'qr_only sends nothing', noProviderNeeded: true };
  else {
    message = createMessageAdapter({
      channel: messageChannel, fetch: (url, init) => fetch(url, init),
      surge: { apiKey: env.SURGE_API_KEY, accountId: env.SURGE_ACCOUNT_ID },
      androidGateway: { baseUrl: env.ANDROID_GATEWAY_URL, apiKey: env.ANDROID_GATEWAY_API_KEY },
      whatsappSandbox: { accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN },
    });
    status.message_channel = ok(messageChannel);
  }

  let twilioCalls: Providers['twilioCalls'];
  const twilioValidator = env.TWILIO_AUTH_TOKEN ? createTwilioRequestValidator(env.TWILIO_AUTH_TOKEN) : undefined;
  status.twilio = env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER && env.PUBLIC_SERVER_URL ? ok() : missing('TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER', 'PUBLIC_SERVER_URL');
  if (status.twilio.configured && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
    const sid = env.TWILIO_ACCOUNT_SID; const token = env.TWILIO_AUTH_TOKEN;
    twilioCalls = {
      async update({ callSid, twiml, signal }) {
        if (signal.aborted) throw new Error('aborted');
        // The instruction is never logged; only the status decides the outcome.
        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Calls/${encodeURIComponent(callSid)}.json`, {
          method: 'POST', signal, body: new URLSearchParams({ Twiml: twiml }),
          headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' } });
        if (!res.ok) throw new Error('Twilio refused the call update');
      },
    };
    probes.twilio = async () => {
      try {
        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`, { method: 'GET', headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` }, signal: AbortSignal.timeout(5000) });
        return fixed(res.ok, res.ok ? 'account readable' : 'Twilio refused the account read');
      } catch { return fixed(false, 'Twilio unreachable'); }
    };
  }

  const openaiSocketFactory = env.OPENAI_API_KEY ? createWsOpenAISocketFactory({ apiKey: env.OPENAI_API_KEY }) : undefined;
  status.openai = env.OPENAI_API_KEY ? ok() : missing('OPENAI_API_KEY');
  if (env.OPENAI_API_KEY) {
    const key = env.OPENAI_API_KEY;
    probes.openai = async () => {
      try {
        const res = await fetch('https://api.openai.com/v1/models', { method: 'GET', headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) });
        return fixed(res.ok, res.ok ? 'models readable' : 'OpenAI refused the key');
      } catch { return fixed(false, 'OpenAI unreachable'); }
    };
  }

  return {
    square, prices, squareLocationId: env.SQUARE_LOCATION_ID, squarePaymentStatus, calendar: calendarAdapter, calendarId: env.GOOGLE_CALENDAR_ID, sheets: sheetsAdapter, sheetId: env.GOOGLE_SHEET_ID,
    message, messageChannel, twilioValidator, twilioCalls, openaiSocketFactory, status, probes,
    ...overrides,
  };
}
