import { z } from 'zod';

// Owner voice reads its own variables here so it does not touch the shared
// builder env schema. Names are from docs/SPEC.md section 3.3. An empty value
// counts as absent.
//
// The model is fixed by SPEC P-03 and by the contract: RealtimeClientSecret.model
// is the literal "gpt-realtime-2.1" (docs/CONTRACTS.md). Any other value would
// make the response break the contract, so voice is refused instead.

export const REALTIME_MODEL = 'gpt-realtime-2.1' as const;

const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const VoiceEnvSchema = z.object({
  OPENAI_API_KEY: z.preprocess(blankToUndefined, z.string().optional()),
  OPENAI_REALTIME_MODEL: z.preprocess(blankToUndefined, z.string().optional()),
});

export type VoiceEnv =
  | { mode: 'openai'; apiKey: string; model: typeof REALTIME_MODEL }
  // No key: the server runs on recorded responses and cannot mint a secret.
  | { mode: 'recorded' }
  // A key is set but the realtime model is missing or is not the contract value.
  // The reason names the variable only, never a value.
  | { mode: 'misconfigured'; reason: string };

export function parseVoiceEnv(source: Record<string, string | undefined> = process.env): VoiceEnv {
  const { OPENAI_API_KEY, OPENAI_REALTIME_MODEL } = VoiceEnvSchema.parse({
    OPENAI_API_KEY: source.OPENAI_API_KEY,
    OPENAI_REALTIME_MODEL: source.OPENAI_REALTIME_MODEL,
  });
  if (!OPENAI_API_KEY) return { mode: 'recorded' };
  if (!OPENAI_REALTIME_MODEL) {
    return { mode: 'misconfigured', reason: 'OPENAI_REALTIME_MODEL is not set.' };
  }
  if (OPENAI_REALTIME_MODEL !== REALTIME_MODEL) {
    return { mode: 'misconfigured', reason: `OPENAI_REALTIME_MODEL must be "${REALTIME_MODEL}" (docs/CONTRACTS.md RealtimeClientSecret).` };
  }
  return { mode: 'openai', apiKey: OPENAI_API_KEY, model: REALTIME_MODEL };
}
