import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

export interface SpikeEnv {
  OPENAI_API_KEY: string;
  OPENAI_REALTIME_MODEL: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_PHONE_NUMBER: string;
  PUBLIC_SERVER_URL: string;
  PORT: number;
  SKIP_TWILIO_SIGNATURE: boolean;
}

const REQUIRED = [
  'OPENAI_API_KEY',
  'OPENAI_REALTIME_MODEL',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'PUBLIC_SERVER_URL',
] as const;

/** Walk up from `start` and return the first `.env.local` found, or null. */
export function findEnvFile(start: string, name = '.env.local'): string | null {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function fail(message: string): never {
  console.error(`[env] ${message}`);
  process.exit(1);
}

/**
 * Load `.env.local` (values already in the process environment win), check every
 * variable, and exit naming the first missing one. Never prints a value.
 */
export function loadEnv(): SpikeEnv {
  const file = findEnvFile(process.cwd());
  if (file) {
    const parsed = parseEnv(readFileSync(file, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined && value !== undefined) process.env[key] = value;
    }
    console.log(`[env] loaded ${file}`);
  } else {
    console.log('[env] no .env.local found above the current directory; using the process environment only');
  }

  const missing = REQUIRED.filter((k) => !process.env[k]?.trim());
  if (missing.length > 0) {
    fail(`missing required variable ${missing[0]}${missing.length > 1 ? ` (also missing: ${missing.slice(1).join(', ')})` : ''}. Add it to .env.local.`);
  }
  const get = (k: (typeof REQUIRED)[number]) => process.env[k]!.trim();

  let publicUrl: URL;
  try {
    publicUrl = new URL(get('PUBLIC_SERVER_URL'));
  } catch {
    fail('PUBLIC_SERVER_URL is not a valid URL. Use the full https address of your tunnel, for example https://name.ngrok-free.app');
  }
  if (publicUrl.protocol !== 'https:') fail('PUBLIC_SERVER_URL must start with https:// (Twilio connects to wss:// on the same host)');

  const portRaw = process.env.PORT?.trim() || '4020';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) fail(`PORT must be a whole number between 1 and 65535`);

  if (!get('TWILIO_ACCOUNT_SID').startsWith('AC')) fail('TWILIO_ACCOUNT_SID should start with AC');

  return {
    OPENAI_API_KEY: get('OPENAI_API_KEY'),
    OPENAI_REALTIME_MODEL: get('OPENAI_REALTIME_MODEL'),
    TWILIO_ACCOUNT_SID: get('TWILIO_ACCOUNT_SID'),
    TWILIO_AUTH_TOKEN: get('TWILIO_AUTH_TOKEN'),
    TWILIO_PHONE_NUMBER: get('TWILIO_PHONE_NUMBER'),
    PUBLIC_SERVER_URL: publicUrl.origin,
    PORT: port,
    SKIP_TWILIO_SIGNATURE: process.env.SPIKE_SKIP_TWILIO_SIGNATURE === '1',
  };
}
