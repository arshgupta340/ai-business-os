import { describe, expect, it } from 'vitest';
import {
  RegisterError,
  parseArgs,
  registerSquare,
  registerTwilio,
  rewriteEnvContent,
  run,
  squareCreateKey,
  validateBaseUrl,
  type HttpRequest,
  type Ports,
} from '../../../../scripts/register-webhooks-lib';

// Marker values: if any of these appears in an output line, a secret leaked.
const ACCOUNT_SID = 'ACmarkerSID0000000000000000000001';
const AUTH_TOKEN = 'marker-auth-token-zzz';
const SQUARE_TOKEN = 'marker-square-token-yyy';
const SIGNATURE_KEY = 'marker-signature-key-xxx';
const PHONE = '+18055550100';
const BASE = 'https://abos.example.com';
const PN_SID = 'PNmarker000000000000000000000009';
const SUB_ID = 'wbhk_marker_subscription_4321';

interface Call { url: string; init: HttpRequest }

interface FakeOptions {
  numbers?: Record<string, unknown>[];
  subscriptions?: Record<string, unknown>[];
  getReturnsKey?: boolean;
  env?: Record<string, string | undefined>;
  envContent?: string | undefined;
}

function fake(opts: FakeOptions = {}) {
  const calls: Call[] = [];
  const writes: string[] = [];
  let file = opts.envContent;
  const numbers = opts.numbers ?? [{ sid: PN_SID, phone_number: PHONE, voice_url: 'https://old.example.com/voice', voice_method: 'GET', status_callback: '', status_callback_method: 'POST' }];
  const subs = opts.subscriptions ?? [];
  const respond = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
  const ports: Ports = {
    env: {
      TWILIO_ACCOUNT_SID: ACCOUNT_SID,
      TWILIO_AUTH_TOKEN: AUTH_TOKEN,
      TWILIO_PHONE_NUMBER: PHONE,
      SQUARE_ACCESS_TOKEN: SQUARE_TOKEN,
      SQUARE_ENVIRONMENT: 'sandbox',
      PUBLIC_SERVER_URL: BASE,
      ...opts.env,
    },
    clock: { now: () => new Date('2026-11-14T12:00:00Z') },
    envFile: {
      path: '/repo/.env.local',
      read: async () => file,
      write: async (content) => { writes.push(content); file = content; },
    },
    fetch: async (url, init) => {
      calls.push({ url, init });
      const u = new URL(url);
      if (u.hostname === 'api.twilio.com') {
        if (init.method === 'GET') return respond(200, { incoming_phone_numbers: numbers.filter((n) => n.phone_number === u.searchParams.get('PhoneNumber')) });
        const form = new URLSearchParams(init.body ?? '');
        return respond(200, { sid: PN_SID, phone_number: PHONE, voice_url: form.get('VoiceUrl'), voice_method: form.get('VoiceMethod'), status_callback: form.get('StatusCallback'), status_callback_method: form.get('StatusCallbackMethod') });
      }
      if (u.hostname === 'connect.squareupsandbox.com') {
        if (u.pathname === '/v2/webhooks/subscriptions' && init.method === 'GET') return respond(200, { subscriptions: subs.map(({ signature_key: _k, ...rest }) => rest) });
        if (u.pathname === '/v2/webhooks/subscriptions' && init.method === 'POST') {
          const body = JSON.parse(init.body ?? '{}') as { subscription: Record<string, unknown> };
          return respond(200, { subscription: { ...body.subscription, id: SUB_ID, signature_key: SIGNATURE_KEY } });
        }
        const existing = subs[0] ?? {};
        if (init.method === 'PUT') {
          const body = JSON.parse(init.body ?? '{}') as { subscription: Record<string, unknown> };
          return respond(200, { subscription: { ...existing, ...body.subscription, signature_key: undefined } });
        }
        if (init.method === 'GET') return respond(200, { subscription: { ...existing, signature_key: opts.getReturnsKey === false ? undefined : SIGNATURE_KEY } });
      }
      return respond(404, { errors: [{ code: 'NOT_FOUND', detail: 'no route in fake' }] });
    },
  };
  return { ports, calls, writes, file: () => file };
}

const writesTo = (calls: Call[]) => calls.filter((c) => c.init.method !== 'GET');

async function runCapture(ports: Ports, argv: string[]) {
  const lines: string[] = [];
  const code = await run(ports, argv, (l) => lines.push(l));
  return { code, lines, text: lines.join('\n') };
}

function expectNoSecrets(text: string) {
  for (const marker of [ACCOUNT_SID, AUTH_TOKEN, SQUARE_TOKEN, SIGNATURE_KEY, PHONE, PN_SID, SUB_ID]) expect(text).not.toContain(marker);
}

describe('register-webhooks', () => {
  it('dry run is the default and changes nothing for both providers', async () => {
    const f = fake({ envContent: 'A=1\n' });
    const { code, text } = await runCapture(f.ports, []);
    expect(code).toBe(0);
    expect(writesTo(f.calls)).toHaveLength(0);
    expect(f.writes).toHaveLength(0);
    expect(text).toContain('dry run');
    expect(text).toContain(`${BASE}/webhooks/twilio/voice`);
    expect(text).toContain(`Would create subscription "AI Business OS sandbox"`);
    expectNoSecrets(text);
  });

  it('apply sets the Twilio URLs and returns the previous values', async () => {
    const f = fake();
    const r = await registerTwilio(f.ports, { base: BASE, apply: true });
    expect(r.applied).toBe(true);
    expect(r.before).toEqual({ voiceUrl: 'https://old.example.com/voice', voiceMethod: 'GET', statusCallback: '', statusCallbackMethod: 'POST' });
    expect(r.after).toEqual({ voiceUrl: `${BASE}/webhooks/twilio/voice`, voiceMethod: 'POST', statusCallback: `${BASE}/webhooks/twilio/status`, statusCallbackMethod: 'POST' });
    const post = writesTo(f.calls);
    expect(post).toHaveLength(1);
    expect(post[0]?.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/IncomingPhoneNumbers/${PN_SID}.json`);
    const form = new URLSearchParams(post[0]?.init.body ?? '');
    expect(form.get('VoiceUrl')).toBe(`${BASE}/webhooks/twilio/voice`);
    expect(form.get('StatusCallback')).toBe(`${BASE}/webhooks/twilio/status`);
    expect(post[0]?.init.headers.Authorization).toBe(`Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64')}`);
  });

  it('apply prints the previous Twilio values for undo, masked number, no secrets', async () => {
    const f = fake();
    const { code, text } = await runCapture(f.ports, ['--apply', '--twilio-only']);
    expect(code).toBe(0);
    expect(text).toContain('***0100');
    expect(text).toContain('To undo');
    expect(text).toContain('https://old.example.com/voice');
    expect(f.calls.some((c) => c.url.includes('squareup'))).toBe(false);
    expectNoSecrets(text);
  });

  it('fails clearly when the number is not on the account', async () => {
    const f = fake({ numbers: [] });
    await expect(registerTwilio(f.ports, { base: BASE, apply: true })).rejects.toThrow(/not an incoming phone number on this Twilio account/);
    const { code, text } = await runCapture(f.ports, ['--apply', '--twilio-only']);
    expect(code).toBe(1);
    expect(text).toContain('***0100');
    expect(writesTo(f.calls)).toHaveLength(0);
    expectNoSecrets(text);
  });

  it('Square create path creates the subscription and writes both lines', async () => {
    const f = fake({ envContent: 'X=1\n' });
    const r = await registerSquare(f.ports, { base: BASE, apply: true });
    expect(r.action).toBe('create');
    const post = writesTo(f.calls);
    expect(post).toHaveLength(1);
    expect(post[0]?.url).toBe('https://connect.squareupsandbox.com/v2/webhooks/subscriptions');
    const body = JSON.parse(post[0]?.init.body ?? '{}') as { idempotency_key: string; subscription: { name: string; event_types: string[]; notification_url: string } };
    expect(body.subscription.name).toBe('AI Business OS sandbox');
    expect(body.subscription.event_types).toEqual(['payment.created', 'payment.updated']);
    expect(body.subscription.notification_url).toBe(`${BASE}/webhooks/square`);
    expect(body.idempotency_key).toBe(squareCreateKey(`${BASE}/webhooks/square`, new Date('2026-11-14T12:00:00Z')));
    expect(f.file()).toBe(`X=1\nSQUARE_WEBHOOK_SIGNATURE_KEY=${SIGNATURE_KEY}\nSQUARE_WEBHOOK_URL=${BASE}/webhooks/square\n`);
  });

  it('Square update path updates the subscription for the same URL', async () => {
    const f = fake({ subscriptions: [{ id: SUB_ID, name: 'old', enabled: true, event_types: ['payment.created'], notification_url: `${BASE}/webhooks/square` }], envContent: '' });
    const r = await registerSquare(f.ports, { base: BASE, apply: true });
    expect(r.action).toBe('update');
    const writes = writesTo(f.calls);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.init.method).toBe('PUT');
    expect(writes[0]?.url).toBe(`https://connect.squareupsandbox.com/v2/webhooks/subscriptions/${SUB_ID}`);
    expect(r.after.eventTypes).toEqual(['payment.created', 'payment.updated']);
    expect(f.file()).toContain(`SQUARE_WEBHOOK_SIGNATURE_KEY=${SIGNATURE_KEY}`);
  });

  it('Square update path fails when the key cannot be read, and never rotates it', async () => {
    const f = fake({ subscriptions: [{ id: SUB_ID, enabled: true, event_types: ['payment.created', 'payment.updated'], notification_url: `${BASE}/webhooks/square` }], getReturnsKey: false });
    await expect(registerSquare(f.ports, { base: BASE, apply: true })).rejects.toThrow(/Developer Console/);
    expect(f.calls.some((c) => c.url.endsWith('/signature-key'))).toBe(false);
    expect(f.writes).toHaveLength(0);
  });

  it('Square is refused outside sandbox', async () => {
    for (const value of ['production', undefined, 'Sandbox']) {
      const f = fake({ env: { SQUARE_ENVIRONMENT: value } });
      await expect(registerSquare(f.ports, { base: BASE, apply: true })).rejects.toBeInstanceOf(RegisterError);
      expect(f.calls).toHaveLength(0);
    }
  });

  it('.env.local rewrite keeps every other line byte for byte and never logs the key', async () => {
    const original = '# comment\r\nSQUARE_WEBHOOK_SIGNATURE_KEY=old\r\n  KEEP = spaced \r\nSQUARE_WEBHOOK_URL=https://old/webhooks/square\r\nLAST=no-newline';
    const f = fake({ envContent: original });
    const { code, text } = await runCapture(f.ports, ['--apply', '--square-only']);
    expect(code).toBe(0);
    expect(f.file()).toBe(`# comment\r\nSQUARE_WEBHOOK_SIGNATURE_KEY=${SIGNATURE_KEY}\r\n  KEEP = spaced \r\nSQUARE_WEBHOOK_URL=${BASE}/webhooks/square\r\nLAST=no-newline`);
    expect(text).toContain('value hidden');
    expect(text).toContain("host's environment settings");
    expectNoSecrets(text);
  });

  it('rewriteEnvContent appends absent keys after a file without a trailing newline', () => {
    expect(rewriteEnvContent('A=1', [['B', '2']])).toBe('A=1\nB=2\n');
    expect(rewriteEnvContent('', [['B', '2']])).toBe('B=2\n');
    expect(rewriteEnvContent('#B=0\nB=1\n', [['B', '2']])).toBe('#B=0\nB=2\n');
  });

  it('refuses bad base URLs', async () => {
    for (const bad of ['http://abos.example.com', 'https://localhost:4000', 'https://127.0.0.1', 'https://abos.example.com/api', 'https://abos.example.com/?x=1', 'not a url', '']) {
      expect(() => validateBaseUrl(bad)).toThrow(RegisterError);
    }
    expect(validateBaseUrl('https://abos.example.com/')).toBe(BASE);
    const f = fake();
    const { code } = await runCapture(f.ports, ['--base', 'http://abos.example.com']);
    expect(code).toBe(1);
    expect(f.calls).toHaveLength(0);
  });

  it('parses flags and rejects conflicting ones', () => {
    expect(parseArgs([])).toEqual({ apply: false, twilio: true, square: true, base: undefined });
    expect(parseArgs(['--apply', '--square-only', '--base', BASE])).toEqual({ apply: true, twilio: false, square: true, base: BASE });
    expect(() => parseArgs(['--apply', '--dry-run'])).toThrow(RegisterError);
    expect(() => parseArgs(['--twilio-only', '--square-only'])).toThrow(RegisterError);
    expect(() => parseArgs(['--bogus'])).toThrow(RegisterError);
  });

  it('no secret appears in any output line on a full apply, including provider errors', async () => {
    const f = fake({ envContent: '' });
    const full = await runCapture(f.ports, ['--apply']);
    expect(full.code).toBe(0);
    expectNoSecrets(full.text);
    const broken = fake();
    const ports: Ports = { ...broken.ports, fetch: async () => ({ status: 401, text: async () => JSON.stringify({ message: `bad token ${AUTH_TOKEN}`, errors: [{ code: 'UNAUTHORIZED', detail: `token ${SQUARE_TOKEN}` }] }) }) };
    const failed = await runCapture(ports, ['--apply']);
    expect(failed.code).toBe(1);
    expectNoSecrets(failed.text);
  });
});
