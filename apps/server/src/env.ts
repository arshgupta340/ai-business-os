import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

// Find .env.local by walking up from the current directory, so the server, the
// scripts and a git worktree nested in the repo all read the same file.
export function findEnvFile(start: string = process.cwd()): string | undefined {
  let dir = start;
  for (;;) {
    const candidate = join(dir, '.env.local');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function loadEnvFile(): void {
  const file = findEnvFile();
  if (file) process.loadEnvFile(file);
}

// Only what the skeleton needs. Each feature task adds its own variables here
// and marks them required once the feature cannot run without them.
// Names are defined in docs/SPEC.md section 3.3.
const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  PUBLIC_SERVER_URL: z.url().optional(),
  // AC-19: this build is sandbox only. Any other value stops the server.
  SQUARE_ENVIRONMENT: z
    .literal('sandbox', {
      error: 'SQUARE_ENVIRONMENT must be "sandbox". This build refuses to run against production Square.',
    })
    .default('sandbox'),
});

export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  return result.data;
}
