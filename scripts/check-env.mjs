#!/usr/bin/env node
// Environment check for AI Business OS. Pure Node, no dependencies.
//
//   npm run check-env                    laptop: every variable in .env.example
//   npm run check-env -- --strict        exit 1 when a MUST feature is blocked
//   npm run check-env -- --for host      only what the deployed server needs;
//                                        exit 1 if DATABASE_ADMIN_URL is set on the host
//
// It reads .env.local (found by walking up from the current directory, the
// same way the server does) and the process environment. A variable already in
// the process environment wins, as with process.loadEnvFile.
//
// It NEVER prints a value. Every note below says only whether a value is set
// and whether its shape is right. Names: docs/SPEC.md section 3.3.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';

// ---------- arguments ----------

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const forIndex = args.indexOf('--for');
const target = forIndex >= 0 ? args[forIndex + 1] : 'local';
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: npm run check-env -- [--strict] [--for host]');
  process.exit(0);
}
if (target !== 'local' && target !== 'host') {
  console.error(`Unknown --for value. Use "--for host".`);
  process.exit(2);
}
const hostMode = target === 'host';

// ---------- load ----------

function findEnvFile(start = process.cwd()) {
  let dir = start;
  for (;;) {
    const candidate = join(dir, '.env.local');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const envFile = findEnvFile();
let fileVars = {};
if (envFile) {
  try {
    fileVars = parseEnv(readFileSync(envFile, 'utf8'));
  } catch {
    console.error('Could not parse .env.local. Check it for a broken line (no value is shown here).');
    process.exit(2);
  }
}

// Where each value came from: 'env' (process environment, as on a host) or 'file'.
const source = {};
const values = {};
for (const [k, v] of Object.entries(fileVars)) {
  if (v !== '') {
    values[k] = v;
    source[k] = 'file';
  }
}
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined && v !== '') {
    values[k] = v;
    source[k] = 'env';
  }
}
const has = (name) => values[name] !== undefined && values[name].trim() !== '';
const get = (name) => (has(name) ? values[name].trim() : undefined);

// ---------- format checks (each returns a problem string or null; never a value) ----------

const E164 = /^\+[1-9]\d{6,14}$/;
const CHANNELS = ['surge', 'android_gateway', 'whatsapp_sandbox', 'qr_only', 'agentphone'];
const TELEPHONY = ['twilio', 'agentphone'];
const CHANNEL_KEYS = {
  surge: ['SURGE_API_KEY'],
  android_gateway: ['ANDROID_GATEWAY_URL', 'ANDROID_GATEWAY_API_KEY'],
  whatsapp_sandbox: ['TWILIO_WHATSAPP_FROM', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
  qr_only: [],
  // D-12: outbound SMS to US numbers also needs AgentPhone's A2P 10DLC approval (docs/notes-agentphone.md).
  agentphone: ['AGENTPHONE_API_KEY', 'AGENTPHONE_NUMBER_ID'],
};

function parseUrl(raw) {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function checkPostgres(raw, { restricted }) {
  const u = parseUrl(raw);
  if (!u || !/^postgres(ql)?:$/.test(u.protocol)) return 'not a postgres:// connection string';
  const user = decodeURIComponent(u.username || '');
  if (restricted && !user.startsWith('abos_app')) return 'user name does not start with abos_app (D-10)';
  if (!restricted && user.startsWith('abos_app')) return 'this is the restricted abos_app login, not the owner';
  if (u.port === '6543') return 'port 6543 is the transaction pooler; use the session connection (5432)';
  return null;
}

const checks = {
  DATABASE_URL: (v) => {
    const p = checkPostgres(v, { restricted: true });
    if (p) return p;
    if (has('DATABASE_ADMIN_URL') && v === get('DATABASE_ADMIN_URL')) return 'same string as DATABASE_ADMIN_URL';
    return null;
  },
  DATABASE_ADMIN_URL: (v) => checkPostgres(v, { restricted: false }),
  SUPABASE_URL: (v) => (parseUrl(v)?.protocol === 'https:' ? null : 'not an https URL'),
  SUPABASE_ANON_KEY: (v) => (v.split('.').length === 3 || v.startsWith('sb_') ? null : 'does not look like a Supabase key'),
  SUPABASE_SERVICE_ROLE_KEY: (v) => {
    if (has('SUPABASE_ANON_KEY') && v === get('SUPABASE_ANON_KEY')) return 'same string as SUPABASE_ANON_KEY';
    return v.split('.').length === 3 || v.startsWith('sb_') ? null : 'does not look like a Supabase key';
  },
  OPENAI_API_KEY: (v) => (v.startsWith('sk-') ? null : 'does not start with sk-'),
  SQUARE_ENVIRONMENT: (v) => (v === 'sandbox' ? null : 'must be exactly "sandbox" (AC-19); the server will not start'),
  SQUARE_WEBHOOK_URL: (v) => {
    const u = parseUrl(v);
    if (!u || u.protocol !== 'https:') return 'not an https URL';
    if (!u.pathname.endsWith('/webhooks/square')) return 'path is not /webhooks/square';
    const pub = get('PUBLIC_SERVER_URL');
    if (pub && v !== `${pub.replace(/\/+$/, '')}/webhooks/square`) return 'is not exactly PUBLIC_SERVER_URL + /webhooks/square';
    return null;
  },
  TWILIO_ACCOUNT_SID: (v) => (/^AC[0-9a-fA-F]{32}$/.test(v) ? null : 'not AC followed by 32 hex characters'),
  TWILIO_PHONE_NUMBER: (v) => (E164.test(v) ? null : 'not E.164 (for example +18055550100)'),
  MESSAGE_CHANNEL: (v) => (CHANNELS.includes(v) ? null : `not one of ${CHANNELS.join(', ')}`),
  TELEPHONY_PROVIDER: (v) => (TELEPHONY.includes(v) ? null : `not one of ${TELEPHONY.join(', ')}`),
  AGENTPHONE_PHONE_NUMBER: (v) => (E164.test(v) ? null : 'not E.164 (for example +18055550100)'),
  // Untested guess: the vendor's example response shows "whsec_abc123..."; no page states the prefix as a rule.
  // If a real secret has another shape, this reports a wrong format although the server would accept it.
  AGENTPHONE_WEBHOOK_SECRET: (v) => (v.startsWith('whsec_') ? null : 'does not start with whsec_ (the secret POST /v1/webhooks returns)'),
  ANDROID_GATEWAY_URL: (v) => (/^https?:$/.test(parseUrl(v)?.protocol ?? '') ? null : 'not an http(s) URL'),
  TWILIO_WHATSAPP_FROM: (v) => (E164.test(v.replace(/^whatsapp:/, '')) ? null : 'not whatsapp:+E.164 or +E.164'),
  GOOGLE_SERVICE_ACCOUNT_JSON: (v) => {
    let text = v;
    if (!v.trimStart().startsWith('{')) {
      if (!existsSync(v)) return 'neither JSON nor a path to an existing file';
      try {
        text = readFileSync(v, 'utf8');
      } catch {
        return 'file could not be read';
      }
    }
    try {
      const j = JSON.parse(text);
      if (j.type !== 'service_account') return 'JSON is not a service account key';
      if (!j.client_email || !j.private_key) return 'JSON lacks client_email or private_key';
      return null;
    } catch {
      return 'not valid JSON';
    }
  },
  PUBLIC_SERVER_URL: (v) => {
    const u = parseUrl(v);
    if (!u) return 'not a URL';
    if (u.protocol !== 'https:') return 'not https (Twilio and Square need https)';
    if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(u.hostname)) return 'is a local address; Twilio and Square cannot reach it';
    if (u.pathname !== '/' || v.endsWith('/')) return 'should be the bare origin, with no path or trailing slash';
    return null;
  },
  PORT: (v) => (/^\d+$/.test(v) && Number(v) > 0 && Number(v) < 65536 ? null : 'not a port number'),
  NEXT_PUBLIC_SUPABASE_URL: (v) => {
    if (has('SUPABASE_URL') && v !== get('SUPABASE_URL')) return 'differs from SUPABASE_URL';
    return parseUrl(v)?.protocol === 'https:' ? null : 'not an https URL';
  },
  NEXT_PUBLIC_SUPABASE_ANON_KEY: (v) =>
    has('SUPABASE_ANON_KEY') && v !== get('SUPABASE_ANON_KEY') ? 'differs from SUPABASE_ANON_KEY' : null,
  NEXT_PUBLIC_API_URL: (v) => (parseUrl(v) ? null : 'not a URL'),
  NEXT_PUBLIC_MOCK: (v) => (v === '0' || v === '1' ? null : 'should be 0 or 1'),
};

// ---------- groups for the table ----------

// scope: 'both' (laptop and host), 'local' (laptop only), 'never-host' (must not be on the host)
const GROUPS = [
  ['Database', [['DATABASE_URL', 'both'], ['DATABASE_ADMIN_URL', 'never-host']]],
  ['Auth (Supabase)', [['SUPABASE_URL', 'both'], ['SUPABASE_ANON_KEY', 'both'], ['SUPABASE_SERVICE_ROLE_KEY', 'both']]],
  ['OpenAI', [['OPENAI_API_KEY', 'both'], ['OPENAI_BUILDER_MODEL', 'both'], ['OPENAI_REALTIME_MODEL', 'both']]],
  [
    'Square (sandbox)',
    [
      ['SQUARE_ENVIRONMENT', 'both'],
      ['SQUARE_ACCESS_TOKEN', 'both'],
      ['SQUARE_LOCATION_ID', 'both'],
      ['SQUARE_WEBHOOK_SIGNATURE_KEY', 'both'],
      ['SQUARE_WEBHOOK_URL', 'both'],
    ],
  ],
  ['Twilio voice', [['TWILIO_ACCOUNT_SID', 'both'], ['TWILIO_AUTH_TOKEN', 'both'], ['TWILIO_PHONE_NUMBER', 'both']]],
  [
    'Telephony provider and AgentPhone (D-12)',
    [
      ['TELEPHONY_PROVIDER', 'both'],
      ['AGENTPHONE_API_KEY', 'both'],
      ['AGENTPHONE_WEBHOOK_SECRET', 'both'],
      ['AGENTPHONE_NUMBER_ID', 'both'],
      ['AGENTPHONE_PHONE_NUMBER', 'both'],
    ],
  ],
  [
    'Message channel',
    [
      ['MESSAGE_CHANNEL', 'both'],
      ['SURGE_API_KEY', 'both'],
      ['ANDROID_GATEWAY_URL', 'both'],
      ['ANDROID_GATEWAY_API_KEY', 'both'],
      ['TWILIO_WHATSAPP_FROM', 'both'],
    ],
  ],
  ['Google', [['GOOGLE_SERVICE_ACCOUNT_JSON', 'both'], ['GOOGLE_CALENDAR_ID', 'both'], ['GOOGLE_SHEET_ID', 'both']]],
  ['Public address', [['PUBLIC_SERVER_URL', 'both'], ['PORT', 'both']]],
  [
    'Web app (apps/web, deployed on Vercel)',
    [
      ['NEXT_PUBLIC_SUPABASE_URL', 'local'],
      ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'local'],
      ['NEXT_PUBLIC_API_URL', 'local'],
      ['NEXT_PUBLIC_MOCK', 'local'],
    ],
  ],
];

const channel = get('MESSAGE_CHANNEL');
const channelKeys = new Set(CHANNEL_KEYS[channel] ?? []);
const MESSAGE_KEYS = new Set(['SURGE_API_KEY', 'ANDROID_GATEWAY_URL', 'ANDROID_GATEWAY_API_KEY', 'TWILIO_WHATSAPP_FROM']);

// Defaults the server applies itself, so "not set" is fine for these.
const DEFAULTS = { PORT: 'server uses 4000', SQUARE_ENVIRONMENT: 'server defaults to sandbox' };

const problems = {}; // name -> problem string
for (const name of Object.keys(checks)) {
  if (has(name)) {
    const p = checks[name](get(name));
    if (p) problems[name] = p;
  }
}

// In host mode the owner connection must not be present in the process
// environment. On a laptop it is expected in .env.local.
let adminOnHost = false;
if (hostMode && has('DATABASE_ADMIN_URL')) {
  if (source.DATABASE_ADMIN_URL === 'env') adminOnHost = true;
}

function statusOf(name, scope) {
  if (scope === 'never-host' && hostMode) {
    if (adminOnHost) return ['FAIL', 'set on the host. Remove it: owner connection is for migrations only (D-10)'];
    if (has(name)) return ['ok', 'only in .env.local (fine on a laptop; never copy it to the host)'];
    return ['ok', 'not set (correct for the host)'];
  }
  if (MESSAGE_KEYS.has(name) && !channelKeys.has(name)) {
    return [has(name) ? 'set' : '-', has(name) ? 'not used by the selected channel' : 'not needed for the selected channel'];
  }
  if (!has(name)) {
    if (DEFAULTS[name]) return ['default', DEFAULTS[name]];
    return ['MISSING', ''];
  }
  if (problems[name]) return ['BAD', problems[name]];
  return ['ok', ''];
}

// ---------- features: what works and what is blocked ----------

// tier: MUST features make --strict fail when blocked.
const FEATURES = [
  { name: 'Server start', tier: 'MUST', needs: [], formats: ['SQUARE_ENVIRONMENT', 'PORT'] },
  { name: 'Database', tier: 'MUST', needs: ['DATABASE_URL'] },
  { name: 'Migrations and reset', tier: 'local', needs: ['DATABASE_ADMIN_URL'], localOnly: true },
  { name: 'Owner login', tier: 'MUST', needs: ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] },
  { name: 'Builder', tier: 'MUST', needs: ['OPENAI_API_KEY', 'OPENAI_BUILDER_MODEL'] },
  { name: 'Browser voice', tier: 'MUST', needs: ['OPENAI_API_KEY', 'OPENAI_REALTIME_MODEL'] },
  { name: 'Square checkout', tier: 'MUST', needs: ['SQUARE_ACCESS_TOKEN', 'SQUARE_LOCATION_ID'], formats: ['SQUARE_ENVIRONMENT'] },
  {
    name: 'Square payment webhooks',
    tier: 'MUST',
    needs: ['SQUARE_WEBHOOK_SIGNATURE_KEY', 'SQUARE_WEBHOOK_URL', 'PUBLIC_SERVER_URL'],
  },
  {
    name: 'Phone calls',
    tier: 'MUST',
    // D-12: TELEPHONY_PROVIDER=agentphone needs the AgentPhone keys and the text model instead of Twilio and Realtime.
    needs: get('TELEPHONY_PROVIDER') === 'agentphone'
      ? ['AGENTPHONE_API_KEY', 'AGENTPHONE_WEBHOOK_SECRET', 'AGENTPHONE_NUMBER_ID', 'AGENTPHONE_PHONE_NUMBER', 'PUBLIC_SERVER_URL', 'OPENAI_API_KEY', 'OPENAI_BUILDER_MODEL']
      : ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER', 'PUBLIC_SERVER_URL', 'OPENAI_API_KEY', 'OPENAI_REALTIME_MODEL'],
  },
  { name: 'Checkout message', tier: 'MUST', needs: ['MESSAGE_CHANNEL', ...(CHANNEL_KEYS[channel] ?? [])] },
  { name: 'Calendar booking', tier: 'MUST', needs: ['GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_CALENDAR_ID'] },
  { name: 'Sheets mirror', tier: 'MUST', needs: ['GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_SHEET_ID'] },
  {
    name: 'Web app on the live server',
    tier: 'local',
    needs: ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_API_URL'],
    localOnly: true,
  },
];

function evaluate(f) {
  const missing = f.needs.filter((n) => !has(n));
  const bad = [...new Set([...f.needs, ...(f.formats ?? [])])].filter((n) => has(n) && problems[n]);
  return { missing, bad, ok: missing.length === 0 && bad.length === 0 };
}

// ---------- print ----------

const out = [];
const where = envFile ? '.env.local found by walking up from the current directory' : 'no .env.local found';
out.push(`check-env (${hostMode ? 'for host: only what the deployed server needs' : 'local'}). ${where}.`);
out.push('No values are printed. "ok" means set and the shape looks right; it does not prove a key works.');
out.push('');

const W1 = 30;
const W2 = 8;
for (const [group, vars] of GROUPS) {
  const shown = vars.filter(([, scope]) => !(hostMode && scope === 'local'));
  if (shown.length === 0) continue;
  out.push(group);
  for (const [name, scope] of shown) {
    const [status, note] = statusOf(name, scope);
    out.push(`  ${name.padEnd(W1)}${status.padEnd(W2)}${note}`);
  }
  out.push('');
}

out.push('What works now');
let mustBlocked = 0;
for (const f of FEATURES) {
  if (hostMode && f.localOnly) continue;
  const { missing, bad, ok } = evaluate(f);
  const label = `${f.name}:`.padEnd(28);
  if (ok) {
    out.push(`  ${label}works. ${f.needs.length ? 'All its variables are set.' : 'Settings are valid.'}`);
  } else {
    if (f.tier === 'MUST') mustBlocked += 1;
    const parts = [];
    if (missing.length) parts.push(`Missing ${missing.join(', ')}.`);
    if (bad.length) parts.push(`Wrong format: ${bad.join(', ')}.`);
    out.push(`  ${label}blocked. ${parts.join(' ')}`);
  }
}
if (!channel) out.push('  (MESSAGE_CHANNEL is not set. Set it to qr_only if no channel is ready; the QR code always works.)');
out.push('');

let exitCode = 0;
if (adminOnHost) {
  out.push('FAIL: DATABASE_ADMIN_URL is set in this environment. Remove it from the host (D-10).');
  exitCode = 1;
}
if (strict && mustBlocked > 0) {
  out.push(`FAIL (--strict): ${mustBlocked} MUST feature(s) blocked.`);
  exitCode = 1;
}
if (exitCode === 0) out.push(mustBlocked > 0 ? `${mustBlocked} MUST feature(s) blocked. Run with --strict to fail on this.` : 'All MUST features have their variables.');

console.log(out.join('\n'));
process.exit(exitCode);
