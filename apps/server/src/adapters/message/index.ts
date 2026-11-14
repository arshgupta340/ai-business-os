import { E164Schema, IdempotencyKeySchema, MessageChannelSettingSchema } from '@abos/contracts';
import type { ErrorCode, MessageChannel } from '@abos/contracts';
import type { DispatchOutcome, DispatchRecord, FetchLike, MessageAdapter, MessageAdapterConfig, MessageStore, SendInput, SendOnceInput, SendOnceResult, SendResult } from './types';

export type * from './types';
export { renderCheckoutMessage, renderBookingConfirmation } from './templates';

// Provider details from B-04. These blocks are the only place to adjust assumptions
// when the team tests real credentials. Fake HTTP tests do not verify delivery.
const SURGE = {
  baseUrl: 'https://api.surge.app',
  accepted: ['pending', 'sent', 'delivered'],
  failed: ['failed'],
  // No documented provider idempotency support. Metadata is tracing only.
  keyMetadataField: 'idempotency_key',
  // The demo number cap returns 403 with this error type. Not confirmed by a real send.
  demoLimitStatus: 403, demoLimitType: 'demo_message_limit',
  // Not confirmed: whether the demo number accepts settings and metadata.
} as const;
const TEXTBEE = {
  baseUrl: 'https://api.textbee.dev/api/v1', path: '/gateway/send-sms',
  // success true plus smsBatchId acknowledges enqueueing, not delivery.
  successField: 'success', idField: 'smsBatchId',
} as const;
const SMSGATE = {
  // The local guide uses /message; OpenAPI lists /messages. Still needs a live test.
  localPath: '/message', cloudPath: '/messages', cloudSuffix: '/3rdparty/v1', maxIdLength: 36,
  accepted: ['Pending', 'Processed', 'Sent', 'Delivered'], failed: ['Failed'],
} as const;
const WHATSAPP = {
  baseUrl: 'https://api.twilio.com/2010-04-01',
  sandboxFrom: '+14155238886',
  accepted: ['accepted', 'scheduled', 'queued', 'sending', 'sent', 'delivered', 'read'],
  failed: ['failed', 'undelivered', 'canceled'],
  // The spike could not confirm Twilio's error body. Never return raw errors.
  errorBodyUnverified: true,
} as const;

// Status mapping for every channel: 2xx with a recognized accepted state and an id is SENT,
// 4xx is FAILED with a contract code, and 408, 409, 5xx, a timeout or an unreadable body is
// UNKNOWN. For the Android gateways (textbee and SMSGate), SENT means the gateway accepted
// the message into its queue, not that the phone sent it. Only a verified callback may mark
// DELIVERED. SMSGate answers 409 to a repeated id: the first send may have gone out, so it is
// UNKNOWN, never SENT.

/** Masks a phone number to its last four digits for log lines and error messages. */
export function maskRecipient(to: string): string {
  const digits = to.replace(/\D/g, '');
  return digits.length >= 4 ? `***${digits.slice(-4)}` : '***';
}

const unavailable = (status: 'FAILED' | 'UNKNOWN'): DispatchOutcome => ({ status, errorCode: 'INTEGRATION_UNAVAILABLE' });
const invalid = (): DispatchOutcome => ({ status: 'FAILED', errorCode: 'VALIDATION_FAILED' });

function required(value: string | undefined, setting: string): string {
  if (!value?.trim()) throw new Error(`Missing setting: ${setting}`);
  return value;
}

function baseUrl(value: string, setting: string): string {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
    return value.replace(/\/+$/, '');
  } catch {
    // Never echo configuration values, which may contain credentials.
    throw new Error(`Invalid setting: ${setting}`);
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function acknowledged(json: unknown, idField: string, stateField: string, accepted: readonly string[], failed: readonly string[]): DispatchOutcome | undefined {
  if (!object(json) || typeof json[idField] !== 'string' || !json[idField].trim()) return;
  const state = json[stateField];
  if (typeof state !== 'string') return;
  if (failed.includes(state)) return unavailable('FAILED');
  if (!accepted.includes(state)) return;
  const id = json[idField];
  return { status: 'SENT', providerMessageId: id };
}

interface Request {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** One bounded request, including response-body reading. No retries at any layer. */
type FailureCode = (status: number, json: unknown) => ErrorCode | undefined;

async function execute(request: Request, fetch: FetchLike, timeoutMs: number, parse: (json: unknown) => DispatchOutcome | undefined, failureCode?: FailureCode): Promise<DispatchOutcome> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<DispatchOutcome>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(unavailable('UNKNOWN')); }, timeoutMs);
  });
  const run = async (): Promise<DispatchOutcome> => {
    try {
      const response = await fetch(request.url, { method: 'POST', headers: request.headers, body: request.body, signal: controller.signal });
      if (response.status === 408 || response.status === 409) return unavailable('UNKNOWN');
      if (response.status >= 400 && response.status < 500) {
        let json: unknown;
        // The error body only refines the code. It is never returned or logged.
        if (failureCode) { try { json = await response.json(); } catch { json = undefined; } }
        const code = failureCode?.(response.status, json);
        return { status: 'FAILED', errorCode: code ?? (response.status === 429 ? 'RATE_LIMITED' : 'INTEGRATION_UNAVAILABLE') };
      }
      if (response.status < 200 || response.status >= 300) return unavailable('UNKNOWN');
      const json: unknown = await response.json();
      return parse(json) ?? unavailable('UNKNOWN');
    } catch {
      // Provider and network errors may contain recipients, bodies and credentials.
      return unavailable('UNKNOWN');
    }
  };
  try { return await Promise.race([run(), timedOut]); }
  finally { clearTimeout(timer); }
}

function networkAdapter(channel: MessageChannel, fetch: FetchLike, timeout: number, request: (input: SendInput) => Request, parse: (json: unknown) => DispatchOutcome | undefined, failureCode?: FailureCode): MessageAdapter {
  return {
    channel,
    async send(input) {
      if (!E164Schema.safeParse(input.to).success || !IdempotencyKeySchema.safeParse(input.idempotencyKey).success) return invalid();
      try {
        const result = await execute(request(input), fetch, timeout, parse, failureCode);
        // Suppress a provider response that echoes the recipient as its message id.
        if (result.providerMessageId?.includes(input.to.replace(/^\+/, ''))) return unavailable('UNKNOWN');
        return result;
      }
      catch { return unavailable('UNKNOWN'); }
    },
  };
}

/** Configuration uses the spike's names in missing-setting errors, without reading env. */
export function createMessageAdapter(config: MessageAdapterConfig): MessageAdapter {
  const parsedChannel = MessageChannelSettingSchema.safeParse(config.channel);
  if (!parsedChannel.success) throw new Error('Missing or invalid setting: MESSAGE_CHANNEL');
  const channel = parsedChannel.data;
  if (channel === 'qr_only') return { channel, async send() { return { status: 'SKIPPED' }; } };
  const timeoutMs = config.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error('Invalid setting: MESSAGE_TIMEOUT_MS');
  const jsonHeaders = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const fetch = config.fetch;
  if (typeof fetch !== 'function') throw new Error('Missing setting: fetch');

  if (channel === 'surge') {
    const apiKey = required(config.surge?.apiKey, 'SURGE_API_KEY');
    const accountId = required(config.surge?.accountId, 'SURGE_ACCOUNT_ID');
    const base = baseUrl(config.surge?.baseUrl ?? SURGE.baseUrl, 'SURGE_BASE_URL');
    const linkShortening = config.surge?.linkShortening ?? 'disabled';
    if (!['disabled', 'enabled', 'omit'].includes(linkShortening)) throw new Error('Invalid setting: SURGE_LINK_SHORTENING');
    return networkAdapter(channel, fetch, timeoutMs, (input) => ({
      url: `${base}/accounts/${encodeURIComponent(accountId)}/messages`,
      headers: { ...jsonHeaders, Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ to: input.to, body: input.body, metadata: { [SURGE.keyMetadataField]: input.idempotencyKey }, ...(linkShortening === 'omit' ? {} : { settings: { link_shortening: linkShortening } }) }),
    }), (json) => acknowledged(json, 'id', 'status', SURGE.accepted, SURGE.failed), (status, json) => (
      // The demo cap is a quota limit, so it maps to RATE_LIMITED rather than a generic failure.
      status === SURGE.demoLimitStatus && object(json) && object(json.error) && json.error.type === SURGE.demoLimitType ? 'RATE_LIMITED' : undefined
    ));
  }

  if (channel === 'android_gateway') {
    const cfg = config.androidGateway;
    const kind = cfg?.kind;
    if (kind !== 'textbee' && kind !== 'smsgate') throw new Error('Missing or invalid setting: ANDROID_GATEWAY_KIND');
    const device = cfg?.deviceId ? { deviceId: cfg.deviceId } : {};
    if (kind === 'textbee') {
      const apiKey = required(cfg?.apiKey, 'ANDROID_GATEWAY_API_KEY');
      const base = baseUrl(cfg?.baseUrl ?? TEXTBEE.baseUrl, 'ANDROID_GATEWAY_URL');
      return networkAdapter(channel, fetch, timeoutMs, (input) => ({
        url: `${base}${TEXTBEE.path}`, headers: { ...jsonHeaders, 'x-api-key': apiKey },
        body: JSON.stringify({ recipients: [input.to], message: input.body, ...device }),
      }), (json) => {
        if (!object(json) || !object(json.data)) return;
        if (json.data[TEXTBEE.successField] === false) return unavailable('FAILED');
        if (json.data[TEXTBEE.successField] !== true) return;
        return acknowledged({ ...json.data, status: 'accepted' }, TEXTBEE.idField, 'status', ['accepted'], []);
      });
    }
    const base = baseUrl(required(cfg?.baseUrl, 'ANDROID_GATEWAY_URL'), 'ANDROID_GATEWAY_URL');
    const user = required(cfg?.username, 'ANDROID_GATEWAY_USERNAME');
    const password = required(cfg?.password, 'ANDROID_GATEWAY_PASSWORD');
    return networkAdapter(channel, fetch, timeoutMs, (input) => ({
      url: `${base}${base.endsWith(SMSGATE.cloudSuffix) ? SMSGATE.cloudPath : SMSGATE.localPath}`,
      headers: { ...jsonHeaders, Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` },
      // Preserve the spike's provider cap. Local dedupe uses all 64 characters.
      body: JSON.stringify({ id: input.idempotencyKey.slice(0, SMSGATE.maxIdLength), textMessage: { text: input.body }, phoneNumbers: [input.to], ...device }),
    }), (json) => acknowledged(json, 'id', 'state', SMSGATE.accepted, SMSGATE.failed));
  }

  const accountSid = required(config.whatsappSandbox?.accountSid, 'TWILIO_ACCOUNT_SID');
  const authToken = required(config.whatsappSandbox?.authToken, 'TWILIO_AUTH_TOKEN');
  const from = (config.whatsappSandbox?.from ?? WHATSAPP.sandboxFrom).replace(/^whatsapp:/i, '');
  if (!E164Schema.safeParse(from).success) throw new Error('Invalid setting: TWILIO_WHATSAPP_FROM');
  return networkAdapter(channel, fetch, timeoutMs, (input) => ({
    url: `${WHATSAPP.baseUrl}/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
    headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ To: `whatsapp:${input.to}`, From: `whatsapp:${from}`, Body: input.body }).toString(),
  }), (json) => acknowledged(json, 'sid', 'status', WHATSAPP.accepted, WHATSAPP.failed));
}

const OUTCOME_STATUSES: readonly string[] = ['SENT', 'DELIVERED', 'FAILED', 'UNKNOWN'];

function existingResult(record: DispatchRecord): SendOnceResult {
  return { status: record.status, providerMessageId: record.providerMessageId, errorCode: record.errorCode, needsReview: record.status === 'UNKNOWN' || record.status === 'QUEUED' };
}

/** A durable insert is the gate, so this works across processes as well as races.
 * A FAILED key is also consumed. Any authorized recovery requires a new execution.
 */
export async function sendOnce(store: MessageStore, adapter: MessageAdapter, input: SendOnceInput): Promise<SendOnceResult> {
  if (adapter.channel === 'qr_only') return { status: 'SKIPPED', needsReview: false };
  if (!E164Schema.safeParse(input.to).success || !IdempotencyKeySchema.safeParse(input.dispatchKey).success) return { ...invalid(), needsReview: false };
  const unknown = (): SendOnceResult => ({ ...unavailable('UNKNOWN'), needsReview: true });
  let recorded = false;
  try {
    const existing = await store.findByKey(input.dispatchKey);
    if (existing) return existingResult(existing);
    let inserted: boolean;
    try {
      inserted = await store.recordAttempt({ to: input.to, body: input.body, idempotencyKey: input.dispatchKey, channel: adapter.channel, status: 'QUEUED' });
    } catch {
      // A unique-key violation and an uncertain database result both forbid sending.
      const winner = await store.findByKey(input.dispatchKey);
      return winner ? existingResult(winner) : unknown();
    }
    if (!inserted) {
      const winner = await store.findByKey(input.dispatchKey);
      return winner ? existingResult(winner) : unknown();
    }
    recorded = true;
    let result: SendResult;
    try { result = await adapter.send({ to: input.to, body: input.body, idempotencyKey: input.dispatchKey }); }
    catch { result = unavailable('UNKNOWN'); }
    // A network adapter must not claim it skipped after the dispatch was recorded, and a status outside
    // the contract is an unknown send (FLOWS 4), never stored as given.
    const outcome: DispatchOutcome = result.status === 'SKIPPED' || !OUTCOME_STATUSES.includes(result.status) ? unavailable('UNKNOWN') : result;
    if (outcome.status === 'SENT' && !outcome.providerMessageId) {
      await store.recordOutcome(input.dispatchKey, unavailable('UNKNOWN'));
      return unknown();
    }
    await store.recordOutcome(input.dispatchKey, outcome);
    return { ...outcome, needsReview: outcome.status === 'UNKNOWN' };
  } catch {
    // Preserve the consumed attempt if storing the outcome fails. Never resend it. A recorded dispatch
    // whose outcome could not be stored is marked UNKNOWN (FLOWS 4) when the store still allows it,
    // so it is not left QUEUED.
    if (recorded) { try { await store.recordOutcome(input.dispatchKey, unavailable('UNKNOWN')); } catch { /* left for review */ } }
    return unknown();
  }
}
