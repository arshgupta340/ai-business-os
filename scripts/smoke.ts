import { loadEnvFile } from '../apps/server/src/env';
import { formatSmokeOutput, runSmoke } from './smoke-lib';

async function main(): Promise<void> {
  loadEnvFile();
  const args = process.argv.slice(2);
  let baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
  if (args.length > 0) {
    if (args.length !== 2 || args[0] !== '--base' || !args[1]) {
      console.error('Usage: npm run smoke -- [--base URL]');
      process.exitCode = 1;
      return;
    }
    baseUrl = args[1];
  }
  const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SEED_OWNER_EMAIL', 'SEED_OWNER_PASSWORD'] as const;
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    for (const name of missing) console.error(name);
    process.exitCode = 1;
    return;
  }
  const results = await runSmoke({
    baseUrl, supabaseUrl: process.env.SUPABASE_URL!, anonKey: process.env.SUPABASE_ANON_KEY!,
    email: process.env.SEED_OWNER_EMAIL!, password: process.env.SEED_OWNER_PASSWORD!,
    fetch: globalThis.fetch, now: Date.now,
  });
  for (const line of formatSmokeOutput(results)) console.log(line);
  process.exitCode = results.every((result) => result.ok === true) ? 0 : 1;
}

main().catch(() => {
  // Environment errors and URLs can contain credentials. Never print the exception.
  console.error('Smoke checks could not run. Check configuration.');
  process.exitCode = 1;
});
