// Points Twilio and the Square sandbox at the server's public address.
// Every side effect goes through the injected ports (fetch, env, .env.local file, clock), so tests use fakes.
//
// Where each provider behavior comes from:
// - Twilio REST paths (/2010-04-01/Accounts/{AccountSid}/IncomingPhoneNumbers.json and .../{Sid}.json),
//   the PhoneNumber list filter, the form field names VoiceUrl, VoiceMethod, StatusCallback and
//   StatusCallbackMethod, the snake_case response fields (sid, phone_number, voice_url, voice_method,
//   status_callback, status_callback_method, voice_application_sid, trunk_sid), the base URL
//   https://api.twilio.com and the rule that voice_application_sid or trunk_sid overrides voice_url:
//   taken from the installed twilio SDK (lib/rest/api/v2010/account/incomingPhoneNumber.d.ts and .js).
//   Basic auth with the account SID and auth token is Twilio's documented scheme and is what the SDK sends.
//   The response envelope key incoming_phone_numbers is not in the .d.ts; it is NOT verified here.
// - Square REST paths (GET and POST /v2/webhooks/subscriptions, GET and PUT /v2/webhooks/subscriptions/{id}),
//   the sandbox base URL https://connect.squareupsandbox.com, the Square-Version 2026-09-16 default and the
//   subscription fields (name, enabled, event_types, notification_url, signature_key) with an idempotency key
//   on create: taken from the installed square SDK (api/resources/webhooks/resources/subscriptions, environments).
//   The SDK serializes to snake_case on the wire; the snake_case names here follow that and are NOT verified live.
// - The Square signature scheme (HMAC-SHA256 over notification URL plus body) comes from spike B-02
//   (scripts/spikes/square/src/verify.ts). The spike created its subscription by hand in the Developer Console,
//   so no subscription API call was tested.
// - NOT verified: whether GET /v2/webhooks/subscriptions/{id} returns signature_key (the SDK type says the
//   subscription carries it, but not on which calls). If it is absent this script fails and says to copy the
//   key from the Developer Console. It never rotates the key, because rotating breaks a server already running.
// - NOT verified: that list and filter behavior hold on a real account. Nothing here was run against a real service.
import { createHash } from 'node:crypto';
import { WEBHOOK_ENDPOINTS } from '@abos/contracts';

// Ports.

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT';
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  text(): Promise<string>;
}

export type FetchPort = (url: string, init: HttpRequest) => Promise<HttpResponse>;

export interface EnvFilePort {
  /** Shown in output so the person knows which file changed. */
  readonly path: string;
  /** Undefined when the file does not exist yet. */
  read(): Promise<string | undefined>;
  write(content: string): Promise<void>;
}

export interface ClockPort {
  now(): Date;
}

export interface Ports {
  fetch: FetchPort;
  env: Readonly<Record<string, string | undefined>>;
  envFile: EnvFilePort;
  clock: ClockPort;
}

// Constants.

export const TWILIO_API_BASE = 'https://api.twilio.com';
export const SQUARE_SANDBOX_BASE = 'https://connect.squareupsandbox.com';
export const SQUARE_VERSION = '2026-09-16';
export const SQUARE_SUBSCRIPTION_NAME = 'AI Business OS sandbox';
/** The event types the server's Square webhook job acts on (apps/server/src/webhooks/square.ts, processSquareEvent). */
export const SQUARE_EVENT_TYPES: readonly string[] = ['payment.created', 'payment.updated'];
export const TWILIO_VOICE_PATH = WEBHOOK_ENDPOINTS.twilioVoice.path;
export const TWILIO_STATUS_PATH = WEBHOOK_ENDPOINTS.twilioStatus.path;
export const SQUARE_WEBHOOK_PATH = WEBHOOK_ENDPOINTS.square.path;

export class RegisterError extends Error {}

// Small helpers.

/** Keep the last four characters; everything else becomes asterisks. */
export function maskTail(value: string, keep = 4): string {
  if (value.length <= keep) return '***';
  return `***${value.slice(-keep)}`;
}

function show(value: string | undefined): string {
  return value === undefined || value === '' ? '(not set)' : value;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function required(env: Ports['env'], name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') throw new RegisterError(`${name} is not set in .env.local.`);
  return value.trim();
}

async function readJson(res: HttpResponse): Promise<unknown> {
  const text = await res.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

/** Provider error text without echoing request data. */
function twilioError(body: unknown, status: number): string {
  const message = str(record(body)?.message);
  return message ? `Twilio answered ${status}: ${message}` : `Twilio answered ${status}.`;
}

function squareError(body: unknown, status: number): string {
  const first = record(Array.isArray(record(body)?.errors) ? (record(body)?.errors as unknown[])[0] : undefined);
  const code = str(first?.code);
  const detail = str(first?.detail);
  return code || detail ? `Square answered ${status}: ${[code, detail].filter(Boolean).join(', ')}` : `Square answered ${status}.`;
}

// Base URL.

/** Accept only an https origin on a public host, with no path, query or fragment. Returns the origin. */
export function validateBaseUrl(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') throw new RegisterError('No base URL. Set PUBLIC_SERVER_URL in .env.local or pass --base <url>.');
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new RegisterError(`The base URL "${raw}" is not a valid URL.`);
  }
  if (url.protocol !== 'https:') throw new RegisterError(`The base URL must use https. Got "${url.protocol}".`);
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]' || host === '0.0.0.0' || host.startsWith('127.')) {
    throw new RegisterError('The base URL must be a public address, not localhost. Twilio and Square cannot reach your laptop directly.');
  }
  if (url.pathname !== '/' && url.pathname !== '') throw new RegisterError(`The base URL must have no path. Remove "${url.pathname}".`);
  if (url.search || url.hash) throw new RegisterError('The base URL must have no query or fragment.');
  if (url.username || url.password) throw new RegisterError('The base URL must not carry a user name or password.');
  return url.origin;
}

// .env.local rewrite.

/**
 * Replace each KEY=... line in place (every occurrence) and append the keys that are absent.
 * Every other line is kept byte for byte, including its line ending.
 */
export function rewriteEnvContent(content: string, updates: ReadonlyArray<readonly [string, string]>): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const found = new Set<string>();
  const parts = content === '' ? [] : content.split('\n');
  const out = parts.map((part) => {
    const cr = part.endsWith('\r') ? '\r' : '';
    const line = cr ? part.slice(0, -1) : part;
    for (const [key, value] of updates) {
      if (new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(line)) {
        found.add(key);
        return `${key}=${value}${cr}`;
      }
    }
    return part;
  });
  let result = out.join('\n');
  const missing = updates.filter(([key]) => !found.has(key));
  if (missing.length > 0) {
    if (result !== '' && !result.endsWith('\n')) result += eol;
    for (const [key, value] of missing) result += `${key}=${value}${eol}`;
  }
  return result;
}

// Twilio.

export interface TwilioVoiceConfig {
  voiceUrl: string | undefined;
  voiceMethod: string | undefined;
  statusCallback: string | undefined;
  statusCallbackMethod: string | undefined;
}

export interface TwilioResult {
  phoneMasked: string;
  before: TwilioVoiceConfig;
  after: TwilioVoiceConfig;
  changed: boolean;
  applied: boolean;
  /** Set when the number routes calls to a TwiML app or a trunk, which overrides voice_url. */
  overrideWarning: string | undefined;
}

function twilioAuth(env: Ports['env']): { accountSid: string; header: string } {
  const accountSid = required(env, 'TWILIO_ACCOUNT_SID');
  const token = required(env, 'TWILIO_AUTH_TOKEN');
  return { accountSid, header: `Basic ${Buffer.from(`${accountSid}:${token}`).toString('base64')}` };
}

function voiceConfig(item: Record<string, unknown>): TwilioVoiceConfig {
  return {
    voiceUrl: str(item.voice_url),
    voiceMethod: str(item.voice_method),
    statusCallback: str(item.status_callback),
    statusCallbackMethod: str(item.status_callback_method),
  };
}

export async function registerTwilio(ports: Ports, opts: { base: string; apply: boolean }): Promise<TwilioResult> {
  const phone = required(ports.env, 'TWILIO_PHONE_NUMBER');
  const { accountSid, header } = twilioAuth(ports.env);
  const accountPath = `${TWILIO_API_BASE}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}`;
  const listUrl = `${accountPath}/IncomingPhoneNumbers.json?${new URLSearchParams({ PhoneNumber: phone }).toString()}`;
  const listRes = await ports.fetch(listUrl, { method: 'GET', headers: { Authorization: header, Accept: 'application/json' } });
  const listBody = await readJson(listRes);
  if (listRes.status !== 200) throw new RegisterError(twilioError(listBody, listRes.status));
  const items = Array.isArray(record(listBody)?.incoming_phone_numbers) ? (record(listBody)?.incoming_phone_numbers as unknown[]) : [];
  const match = items.map(record).find((item) => item !== undefined && str(item.phone_number) === phone);
  const phoneMasked = maskTail(phone);
  if (!match) throw new RegisterError(`The number ending ${phoneMasked} is not an incoming phone number on this Twilio account. Check TWILIO_PHONE_NUMBER and TWILIO_ACCOUNT_SID.`);
  const sid = str(match.sid);
  if (!sid) throw new RegisterError('Twilio returned the number without a resource ID.');

  const before = voiceConfig(match);
  const after: TwilioVoiceConfig = {
    voiceUrl: `${opts.base}${TWILIO_VOICE_PATH}`,
    voiceMethod: 'POST',
    statusCallback: `${opts.base}${TWILIO_STATUS_PATH}`,
    statusCallbackMethod: 'POST',
  };
  const changed = before.voiceUrl !== after.voiceUrl || before.voiceMethod !== after.voiceMethod
    || before.statusCallback !== after.statusCallback || before.statusCallbackMethod !== after.statusCallbackMethod;
  const override = str(match.voice_application_sid) ? 'a TwiML app (voice_application_sid)' : str(match.trunk_sid) ? 'a SIP trunk (trunk_sid)' : undefined;
  const overrideWarning = override ? `This number sends calls to ${override}, which Twilio uses instead of the voice URL. Remove it in the Twilio Console.` : undefined;

  if (!opts.apply || !changed) return { phoneMasked, before, after, changed, applied: false, overrideWarning };

  const form = new URLSearchParams({
    VoiceUrl: after.voiceUrl ?? '',
    VoiceMethod: 'POST',
    StatusCallback: after.statusCallback ?? '',
    StatusCallbackMethod: 'POST',
  });
  const updRes = await ports.fetch(`${accountPath}/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`, {
    method: 'POST',
    headers: { Authorization: header, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const updBody = await readJson(updRes);
  if (updRes.status !== 200) throw new RegisterError(twilioError(updBody, updRes.status));
  // Report what Twilio says is now set, not what was sent.
  const now = record(updBody);
  const confirmed = now ? voiceConfig(now) : after;
  if (confirmed.voiceUrl !== after.voiceUrl || confirmed.statusCallback !== after.statusCallback) {
    throw new RegisterError('Twilio accepted the update but did not return the new URLs. Check the number in the Twilio Console.');
  }
  return { phoneMasked, before, after: confirmed, changed, applied: true, overrideWarning };
}

// Square.

export interface SquareSubscriptionView {
  idMasked: string | undefined;
  notificationUrl: string | undefined;
  eventTypes: string[];
  enabled: boolean | undefined;
}

export interface SquareResult {
  action: 'create' | 'update' | 'unchanged';
  before: SquareSubscriptionView | undefined;
  after: SquareSubscriptionView;
  applied: boolean;
  /** True when SQUARE_WEBHOOK_SIGNATURE_KEY and SQUARE_WEBHOOK_URL were written to .env.local. */
  envWritten: boolean;
  envPath: string;
}

function squareHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Square-Version': SQUARE_VERSION, 'Content-Type': 'application/json', Accept: 'application/json' };
}

function view(sub: Record<string, unknown>): SquareSubscriptionView {
  const id = str(sub.id);
  const enabled = sub.enabled;
  return { idMasked: id ? maskTail(id) : undefined, notificationUrl: str(sub.notification_url), eventTypes: strings(sub.event_types), enabled: typeof enabled === 'boolean' ? enabled : undefined };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
}

/** Stable for one notification URL on one UTC day, so a retry after a timeout reuses the same key. */
export function squareCreateKey(notificationUrl: string, now: Date): string {
  const day = now.toISOString().slice(0, 10);
  return `abos-webhook-${createHash('sha256').update(`${notificationUrl}|${day}`).digest('hex').slice(0, 32)}`;
}

async function listSubscriptions(ports: Ports, token: string): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const params = new URLSearchParams({ include_disabled: 'true' });
    if (cursor) params.set('cursor', cursor);
    const res = await ports.fetch(`${SQUARE_SANDBOX_BASE}/v2/webhooks/subscriptions?${params.toString()}`, { method: 'GET', headers: squareHeaders(token) });
    const body = await readJson(res);
    if (res.status !== 200) throw new RegisterError(squareError(body, res.status));
    const subs = record(body)?.subscriptions;
    if (Array.isArray(subs)) for (const s of subs) { const r = record(s); if (r) all.push(r); }
    cursor = str(record(body)?.cursor);
    if (!cursor) break;
  }
  return all;
}

export async function registerSquare(ports: Ports, opts: { base: string; apply: boolean }): Promise<SquareResult> {
  if (ports.env.SQUARE_ENVIRONMENT !== 'sandbox') {
    throw new RegisterError('SQUARE_ENVIRONMENT must be exactly "sandbox". This script only talks to the Square sandbox.');
  }
  const token = required(ports.env, 'SQUARE_ACCESS_TOKEN');
  const notificationUrl = `${opts.base}${SQUARE_WEBHOOK_PATH}`;
  const wanted = [...SQUARE_EVENT_TYPES];
  const subs = await listSubscriptions(ports, token);
  const existing = subs.find((s) => str(s.notification_url) === notificationUrl);
  const envPath = ports.envFile.path;

  if (!existing) {
    const after: SquareSubscriptionView = { idMasked: undefined, notificationUrl, eventTypes: wanted, enabled: true };
    if (!opts.apply) return { action: 'create', before: undefined, after, applied: false, envWritten: false, envPath };
    const res = await ports.fetch(`${SQUARE_SANDBOX_BASE}/v2/webhooks/subscriptions`, {
      method: 'POST',
      headers: squareHeaders(token),
      body: JSON.stringify({
        idempotency_key: squareCreateKey(notificationUrl, ports.clock.now()),
        subscription: { name: SQUARE_SUBSCRIPTION_NAME, enabled: true, event_types: wanted, notification_url: notificationUrl },
      }),
    });
    const body = await readJson(res);
    if (res.status !== 200) throw new RegisterError(squareError(body, res.status));
    const created = record(record(body)?.subscription);
    if (!created || str(created.notification_url) !== notificationUrl) throw new RegisterError('Square did not return the new subscription.');
    const key = str(created.signature_key);
    if (!key) throw new RegisterError('Square created the subscription but returned no signature key. Copy it from the Developer Console (Sandbox, Webhooks, Subscriptions).');
    await writeSquareEnv(ports, key, notificationUrl);
    return { action: 'create', before: undefined, after: view(created), applied: true, envWritten: true, envPath };
  }

  const before = view(existing);
  const id = str(existing.id);
  if (!id) throw new RegisterError('Square listed the subscription without an ID.');
  const needsUpdate = !sameSet(before.eventTypes, wanted) || before.enabled === false;
  const action: SquareResult['action'] = needsUpdate ? 'update' : 'unchanged';
  const plannedAfter: SquareSubscriptionView = { ...before, eventTypes: wanted, enabled: true };
  if (!opts.apply) return { action, before, after: needsUpdate ? plannedAfter : before, applied: false, envWritten: false, envPath };

  let after = before;
  const subPath = `${SQUARE_SANDBOX_BASE}/v2/webhooks/subscriptions/${encodeURIComponent(id)}`;
  if (needsUpdate) {
    const res = await ports.fetch(subPath, { method: 'PUT', headers: squareHeaders(token), body: JSON.stringify({ subscription: { enabled: true, event_types: wanted } }) });
    const body = await readJson(res);
    if (res.status !== 200) throw new RegisterError(squareError(body, res.status));
    const updated = record(record(body)?.subscription);
    if (!updated) throw new RegisterError('Square did not return the updated subscription.');
    after = view(updated);
    if (!sameSet(after.eventTypes, wanted)) throw new RegisterError('Square accepted the update but the event types did not change. Check the subscription in the Developer Console.');
  }
  // Read the key without rotating it, so a server already using it keeps working.
  const getRes = await ports.fetch(subPath, { method: 'GET', headers: squareHeaders(token) });
  const getBody = await readJson(getRes);
  if (getRes.status !== 200) throw new RegisterError(squareError(getBody, getRes.status));
  const key = str(record(record(getBody)?.subscription)?.signature_key);
  if (!key) throw new RegisterError('Square did not return the signature key for the existing subscription. Copy it from the Developer Console (Sandbox, Webhooks, Subscriptions) into SQUARE_WEBHOOK_SIGNATURE_KEY.');
  await writeSquareEnv(ports, key, notificationUrl);
  return { action, before, after, applied: needsUpdate, envWritten: true, envPath };
}

async function writeSquareEnv(ports: Ports, key: string, url: string): Promise<void> {
  const current = (await ports.envFile.read()) ?? '';
  await ports.envFile.write(rewriteEnvContent(current, [['SQUARE_WEBHOOK_SIGNATURE_KEY', key], ['SQUARE_WEBHOOK_URL', url]]));
}

// Command line.

export interface Options {
  apply: boolean;
  twilio: boolean;
  square: boolean;
  base: string | undefined;
}

export function parseArgs(argv: readonly string[]): Options {
  let apply = false;
  let dry = false;
  let twilioOnly = false;
  let squareOnly = false;
  let base: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') dry = true;
    else if (arg === '--twilio-only') twilioOnly = true;
    else if (arg === '--square-only') squareOnly = true;
    else if (arg === '--base') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new RegisterError('--base needs a URL, for example --base https://abos-server.onrender.com');
      base = next;
      i += 1;
    } else if (arg !== undefined && arg.startsWith('--base=')) base = arg.slice('--base='.length);
    else throw new RegisterError(`Unknown option "${arg ?? ''}". Use --dry-run, --apply, --twilio-only, --square-only or --base <url>.`);
  }
  if (apply && dry) throw new RegisterError('Use --dry-run or --apply, not both.');
  if (twilioOnly && squareOnly) throw new RegisterError('Use --twilio-only or --square-only, not both.');
  return { apply, twilio: !squareOnly, square: !twilioOnly, base };
}

/** Replace any secret value that slipped into a line. A last guard; the lines are built without secrets. */
export function redact(line: string, secrets: readonly string[]): string {
  let out = line;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join('[hidden]');
  return out;
}

const SECRET_NAMES = ['TWILIO_AUTH_TOKEN', 'TWILIO_ACCOUNT_SID', 'SQUARE_ACCESS_TOKEN', 'SQUARE_WEBHOOK_SIGNATURE_KEY'];

/** Runs the whole command. Returns the exit code. Every output line goes through `log`. */
export async function run(ports: Ports, argv: readonly string[], log: (line: string) => void): Promise<number> {
  const secrets: string[] = SECRET_NAMES.map((n) => ports.env[n]).filter((v): v is string => typeof v === 'string' && v !== '');
  // The signature key Square returns may be new; read it back from the file writes to redact it too.
  const guardedPorts: Ports = {
    ...ports,
    envFile: {
      path: ports.envFile.path,
      read: () => ports.envFile.read(),
      write: async (content) => {
        const m = /^SQUARE_WEBHOOK_SIGNATURE_KEY=(.*)$/m.exec(content);
        const key = m?.[1]?.replace(/\r$/, '');
        if (key) secrets.push(key);
        await ports.envFile.write(content);
      },
    },
  };
  const say = (line: string): void => log(redact(line, secrets));

  let opts: Options;
  let base: string;
  try {
    opts = parseArgs(argv);
    base = validateBaseUrl(opts.base ?? ports.env.PUBLIC_SERVER_URL);
  } catch (err) {
    say(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  say(`Base URL: ${base}`);
  say(opts.apply ? 'Mode: apply. Changes will be made.' : 'Mode: dry run. Nothing will change. Add --apply to make the changes.');
  let failed = false;
  let squareWritten = false;
  let squarePath = ports.envFile.path;

  if (opts.twilio) {
    say('');
    say('Twilio');
    try {
      const r = await registerTwilio(guardedPorts, { base, apply: opts.apply });
      say(`  Number:                 ${r.phoneMasked}`);
      say(`  Voice URL:              ${show(r.before.voiceUrl)} -> ${show(r.after.voiceUrl)}`);
      say(`  Voice method:           ${show(r.before.voiceMethod)} -> ${show(r.after.voiceMethod)}`);
      say(`  Status callback:        ${show(r.before.statusCallback)} -> ${show(r.after.statusCallback)}`);
      say(`  Status callback method: ${show(r.before.statusCallbackMethod)} -> ${show(r.after.statusCallbackMethod)}`);
      if (!r.changed) say('  Already set. No change.');
      else if (r.applied) {
        say('  Updated.');
        say(`  To undo: in the Twilio Console set "A call comes in" to ${show(r.before.voiceUrl)} (${show(r.before.voiceMethod)}) and "Call status changes" to ${show(r.before.statusCallback)}.`);
      } else say('  Would update (dry run).');
      if (r.overrideWarning) say(`  Warning: ${r.overrideWarning}`);
    } catch (err) {
      failed = true;
      say(`  Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (opts.square) {
    say('');
    say('Square (sandbox)');
    try {
      const r = await registerSquare(guardedPorts, { base, apply: opts.apply });
      squarePath = r.envPath;
      const verb = r.action === 'create'
        ? (r.applied ? `Created subscription "${SQUARE_SUBSCRIPTION_NAME}".` : `Would create subscription "${SQUARE_SUBSCRIPTION_NAME}" (dry run).`)
        : r.action === 'update'
          ? (r.applied ? `Updated subscription ${r.before?.idMasked ?? ''}.` : `Would update subscription ${r.before?.idMasked ?? ''} (dry run).`)
          : `Subscription ${r.before?.idMasked ?? ''} already set. No change.`;
      say(`  Notification URL: ${show(r.before?.notificationUrl)} -> ${show(r.after.notificationUrl)}`);
      say(`  Event types:      ${r.before ? r.before.eventTypes.join(', ') || '(none)' : '(not set)'} -> ${r.after.eventTypes.join(', ')}`);
      say(`  Enabled:          ${r.before?.enabled === undefined ? '(not set)' : String(r.before.enabled)} -> ${String(r.after.enabled ?? true)}`);
      say(`  ${verb}`);
      if (r.envWritten) {
        squareWritten = true;
        say(`  Wrote SQUARE_WEBHOOK_SIGNATURE_KEY (value hidden) and SQUARE_WEBHOOK_URL to ${r.envPath}.`);
      } else say(`  Would write SQUARE_WEBHOOK_SIGNATURE_KEY and SQUARE_WEBHOOK_URL to ${r.envPath} (dry run).`);
    } catch (err) {
      failed = true;
      say(`  Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  say('');
  if (squareWritten) say(`Next: copy SQUARE_WEBHOOK_SIGNATURE_KEY and SQUARE_WEBHOOK_URL from ${squarePath} into the host's environment settings, then redeploy.`);
  else if (opts.square) say(`Next: after --apply, copy SQUARE_WEBHOOK_SIGNATURE_KEY and SQUARE_WEBHOOK_URL from ${squarePath} into the host's environment settings, then redeploy.`);
  else say('Next: nothing to copy to the host for Twilio.');
  if (failed) say('One or more steps failed. See above.');
  return failed ? 1 : 0;
}
