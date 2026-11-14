import { buildApp } from './app';
import { loadEnvFile, parseEnv, type Env } from './env';

loadEnvFile();

let env: Env;
try {
  env = parseEnv();
} catch (error) {
  // parseEnv prints variable names and its own messages only, never a value.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const app = await buildApp(env, { logger: true });
await app.listen({ host: '0.0.0.0', port: env.PORT });
app.composed.startJobs();

// Hosts send SIGTERM before they replace an instance. Close the server (which stops the jobs and
// the database pool through onClose hooks), then exit.
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    app.close().then(() => process.exit(0), () => process.exit(1));
  });
}
