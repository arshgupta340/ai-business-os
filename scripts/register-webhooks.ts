// npm run register-webhooks                       dry run (the default): shows what would change, changes nothing.
// npm run register-webhooks -- --apply            points Twilio and the Square sandbox at PUBLIC_SERVER_URL.
// npm run register-webhooks -- --twilio-only      only the Twilio number (add --apply to change it).
// npm run register-webhooks -- --square-only      only the Square sandbox subscription (add --apply to change it).
// npm run register-webhooks -- --base https://x   use this address instead of PUBLIC_SERVER_URL.
// The logic lives in scripts/register-webhooks-lib.ts.
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findEnvFile, loadEnvFile } from '../apps/server/src/env';
import { run, type EnvFilePort, type FetchPort } from './register-webhooks-lib';

loadEnvFile();

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = findEnvFile() ?? join(repoRoot, '.env.local');

const envFile: EnvFilePort = {
  path: envPath,
  read: async () => (existsSync(envPath) ? readFile(envPath, 'utf8') : undefined),
  write: async (content) => { await writeFile(envPath, content, 'utf8'); },
};

const fetchPort: FetchPort = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: AbortSignal.timeout(15_000) });
  return { status: res.status, text: () => res.text() };
};

const code = await run(
  { fetch: fetchPort, env: process.env, envFile, clock: { now: () => new Date() } },
  process.argv.slice(2),
  (line) => { console.log(line); },
);
process.exitCode = code;
