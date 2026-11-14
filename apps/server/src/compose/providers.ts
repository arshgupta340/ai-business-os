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
import type { Env } from '../env';
import { createTwilioRequestValidator, createWsOpenAISocketFactory, type OpenAISocketFactory, type TwilioRequestValidator } from '../voice/plugin';

export type ProviderKey = 'square' | 'twilio' | 'openai' | 'google_calendar' | 'google_sheets' | 'message_channel';
export type ProviderStatus = { configured: boolean; detail: string };

export interface Providers {
  square?: SquareAdapter | undefined;
  calendar?: CalendarAdapter | undefined;
  /** The one demo calendar shared with the service account (P-15). */
  calendarId?: string | undefined;
  sheets?: ReportingAdapter | undefined;
  sheetId?: string | undefined;
  message?: MessageAdapter | undefined;
  messageChannel: MessageChannelSetting;
  twilioValidator?: TwilioRequestValidator | undefined;
  openaiSocketFactory?: OpenAISocketFactory | undefined;
  /** Why each provider is or is not available. Never holds a value from the environment. */
  status: Record<ProviderKey, ProviderStatus>;
}

const ok = (detail = 'configured'): ProviderStatus => ({ configured: true, detail });
const missing = (...names: string[]): ProviderStatus => ({ configured: false, detail: `missing ${names.join(', ')}` });
const invalid = (name: string): ProviderStatus => ({ configured: false, detail: `${name} is not usable` });

function googleAuth(json: string | undefined, scopes: string[]): JWT | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as { client_email?: unknown; private_key?: unknown };
    if (typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') return undefined;
    return new JWT({ email: parsed.client_email, key: parsed.private_key, scopes });
  } catch {
    return undefined;
  }
}

export function buildProviders(env: Env, now: () => Date, overrides: Partial<Providers> = {}): Providers {
  const status = {} as Record<ProviderKey, ProviderStatus>;

  // Square: sandbox only (AGENTS rule 4). env.ts already refuses any other SQUARE_ENVIRONMENT.
  let square: SquareAdapter | undefined;
  if (env.SQUARE_ACCESS_TOKEN && env.SQUARE_LOCATION_ID) {
    square = createSquareAdapter({
      client: createSandboxSquareClient({ accessToken: env.SQUARE_ACCESS_TOKEN }),
      locationId: env.SQUARE_LOCATION_ID, environment: env.SQUARE_ENVIRONMENT, now,
    });
    status.square = ok('sandbox');
  } else status.square = missing('SQUARE_ACCESS_TOKEN', 'SQUARE_LOCATION_ID');

  let calendarAdapter: CalendarAdapter | undefined;
  const calendarAuth = googleAuth(env.GOOGLE_SERVICE_ACCOUNT_JSON, ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.freebusy']);
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON || !env.GOOGLE_CALENDAR_ID) status.google_calendar = missing('GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_CALENDAR_ID');
  else if (!calendarAuth) status.google_calendar = invalid('GOOGLE_SERVICE_ACCOUNT_JSON');
  else {
    calendarAdapter = createCalendarAdapter({ client: calendar({ version: 'v3', auth: calendarAuth }), now });
    status.google_calendar = ok();
  }

  let sheetsAdapter: ReportingAdapter | undefined;
  const sheetsAuth = googleAuth(env.GOOGLE_SERVICE_ACCOUNT_JSON, ['https://www.googleapis.com/auth/spreadsheets']);
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON || !env.GOOGLE_SHEET_ID) status.google_sheets = missing('GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_SHEET_ID');
  else if (!sheetsAuth) status.google_sheets = invalid('GOOGLE_SERVICE_ACCOUNT_JSON');
  else {
    sheetsAdapter = createSheetsAdapter({ client: sheets({ version: 'v4', auth: sheetsAuth }) });
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
  else {
    message = createMessageAdapter({
      channel: messageChannel, fetch: (url, init) => fetch(url, init),
      surge: { apiKey: env.SURGE_API_KEY, accountId: env.SURGE_ACCOUNT_ID },
      androidGateway: { baseUrl: env.ANDROID_GATEWAY_URL, apiKey: env.ANDROID_GATEWAY_API_KEY },
      whatsappSandbox: { accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN },
    });
    status.message_channel = ok(messageChannel);
  }

  const twilioValidator = env.TWILIO_AUTH_TOKEN ? createTwilioRequestValidator(env.TWILIO_AUTH_TOKEN) : undefined;
  status.twilio = env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER && env.PUBLIC_SERVER_URL ? ok() : missing('TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER', 'PUBLIC_SERVER_URL');

  const openaiSocketFactory = env.OPENAI_API_KEY ? createWsOpenAISocketFactory({ apiKey: env.OPENAI_API_KEY }) : undefined;
  status.openai = env.OPENAI_API_KEY ? ok() : missing('OPENAI_API_KEY');

  return {
    square, calendar: calendarAdapter, calendarId: env.GOOGLE_CALENDAR_ID, sheets: sheetsAdapter, sheetId: env.GOOGLE_SHEET_ID,
    message, messageChannel, twilioValidator, openaiSocketFactory, status,
    ...overrides,
  };
}
