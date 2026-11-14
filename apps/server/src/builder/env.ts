import { z } from 'zod';

// The builder reads its own variables here, not in src/env.ts. Names are from
// docs/SPEC.md section 3.3. An empty value counts as absent.
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const BuilderEnvSchema = z
  .object({
    OPENAI_API_KEY: z.preprocess(blankToUndefined, z.string().optional()),
    OPENAI_BUILDER_MODEL: z.preprocess(blankToUndefined, z.string().optional()),
  })
  .superRefine((env, ctx) => {
    // SPEC 3.2 says to confirm the builder model ID at build time, so there is
    // no default model. A key without a model is a configuration mistake.
    if (env.OPENAI_API_KEY && !env.OPENAI_BUILDER_MODEL) {
      ctx.addIssue({
        code: 'custom',
        path: ['OPENAI_BUILDER_MODEL'],
        message: 'OPENAI_BUILDER_MODEL is required when OPENAI_API_KEY is set.',
      });
    }
  });

// Whether the unverified development auth stand-in may run. It is an explicit
// opt-in: BUILDER_DEV_AUTH must be exactly "1", and it is refused outright
// when NODE_ENV is "production". Any other case means auth is not configured.
export type BuilderAuthMode = 'dev' | 'not_configured' | 'refused_in_production';

export function builderAuthMode(source: Record<string, string | undefined> = process.env): BuilderAuthMode {
  if (source.BUILDER_DEV_AUTH !== '1') return 'not_configured';
  if (source.NODE_ENV === 'production') return 'refused_in_production';
  return 'dev';
}

export type BuilderEnv =
  | { mode: 'recorded' }
  | { mode: 'openai'; apiKey: string; model: string };

export function parseBuilderEnv(source: Record<string, string | undefined> = process.env): BuilderEnv {
  const result = BuilderEnvSchema.safeParse(source);
  if (!result.success) {
    // Only the variable names and our own messages are printed, never a value.
    const lines = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid builder environment:\n${lines.join('\n')}`);
  }
  const { OPENAI_API_KEY, OPENAI_BUILDER_MODEL } = result.data;
  if (OPENAI_API_KEY && OPENAI_BUILDER_MODEL) {
    return { mode: 'openai', apiKey: OPENAI_API_KEY, model: OPENAI_BUILDER_MODEL };
  }
  return { mode: 'recorded' };
}
