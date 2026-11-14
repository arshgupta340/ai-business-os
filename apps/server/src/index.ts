import { buildApp } from './app';
import { loadEnvFile, parseEnv, type Env } from './env';

loadEnvFile();

let env: Env;
try {
  env = parseEnv();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const app = await buildApp(env, { logger: true });
await app.listen({ host: '0.0.0.0', port: env.PORT });
