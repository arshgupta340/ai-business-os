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

// Integration variables stay optional at startup. Routes report unavailable
// integrations when needed. Names are defined in docs/SPEC.md section 3.3.
const EnvSchema = z.object({
  DATABASE_URL: z.url().optional(),
  SUPABASE_URL: z.url().optional(),
  SUPABASE_ANON_KEY: z.string().min(1).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  WEB_ORIGIN: z.url().optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_BUILDER_MODEL: z.string().min(1).optional(),
  OPENAI_REALTIME_MODEL: z.string().min(1).optional(),
  SQUARE_ACCESS_TOKEN: z.string().min(1).optional(),
  SQUARE_LOCATION_ID: z.string().min(1).optional(),
  SQUARE_WEBHOOK_SIGNATURE_KEY: z.string().min(1).optional(),
  SQUARE_WEBHOOK_URL: z.url().optional(),
  TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  TWILIO_PHONE_NUMBER: z.string().regex(/^\+[1-9][0-9]{6,14}$/).optional(),
  MESSAGE_CHANNEL: z.enum(['surge', 'android_gateway', 'whatsapp_sandbox', 'qr_only', 'agentphone']).optional(),
  // D-12: which provider answers calls. Twilio is the default, so an unset value changes nothing.
  TELEPHONY_PROVIDER: z.enum(['twilio', 'agentphone']).default('twilio'),
  // AgentPhone (D-12, docs/notes-agentphone.md). The webhook secret is the one POST /v1/webhooks returned last.
  AGENTPHONE_API_KEY: z.string().min(1).optional(),
  AGENTPHONE_WEBHOOK_SECRET: z.string().min(1).optional(),
  AGENTPHONE_NUMBER_ID: z.string().min(1).optional(),
  AGENTPHONE_PHONE_NUMBER: z.string().regex(/^\+[1-9][0-9]{6,14}$/).optional(),
  // The AgentPhone voice path's turn engine (docs/notes-agentphone.md, "The turn engine"): `realtime`, one
  // OpenAI Realtime text session per call, or `builder`, the slower shared sim-call runner.
  AGENTPHONE_TURN_ENGINE: z.enum(['realtime', 'builder']).default('realtime'),
  // The opening line. Used only when it says "AI assistant"; otherwise the default greeting is used.
  AGENTPHONE_GREETING: z.string().min(1).max(300).optional(),
  // first_reply (default): the server speaks the greeting on the call's first event. begin_message: AgentPhone is
  // trusted to speak the agent's beginMessage (its schema calls that field hosted mode only).
  AGENTPHONE_GREETING_MODE: z.enum(['first_reply', 'begin_message']).default('first_reply'),
  // Read by scripts/register-webhooks.ts --agentphone-only, not by the server: the agent's barge-in setting
  // (default 0.3) and which agent to update (default: the agent on AGENTPHONE_NUMBER_ID).
  AGENTPHONE_INTERRUPTION_SENSITIVITY: z.coerce.number().min(0).max(1).optional(),
  AGENTPHONE_AGENT_ID: z.string().min(1).optional(),
  SURGE_API_KEY: z.string().min(1).optional(),
  SURGE_ACCOUNT_ID: z.string().min(1).optional(),
  ANDROID_GATEWAY_URL: z.url().optional(),
  ANDROID_GATEWAY_API_KEY: z.string().min(1).optional(),
  // Issue #94 item 2: which gateway app, and the SMSGate login. TextBee uses the API key.
  ANDROID_GATEWAY_KIND: z.enum(['textbee', 'smsgate']).optional(),
  ANDROID_GATEWAY_USERNAME: z.string().min(1).optional(),
  ANDROID_GATEWAY_PASSWORD: z.string().min(1).optional(),
  ANDROID_GATEWAY_DEVICE_ID: z.string().min(1).optional(),
  // The WhatsApp sandbox sender (E.164, with or without the whatsapp: prefix). Defaults to Twilio's sandbox number.
  TWILIO_WHATSAPP_FROM: z.string().min(1).optional(),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().min(1).optional(),
  GOOGLE_CALENDAR_ID: z.string().min(1).optional(),
  GOOGLE_SHEET_ID: z.string().min(1).optional(),
  // Phone voice tuning (apps/server/src/voice/NOTES.md "Tune on a real call"). Unset: the defaults in
  // voice/constants.ts DEFAULT_VOICE_TUNING. A change needs a restart, not a code deploy.
  VOICE_VAD_THRESHOLD: z.coerce.number().min(0).max(1).optional(),
  VOICE_VAD_PREFIX_PADDING_MS: z.coerce.number().int().min(0).max(1000).optional(),
  VOICE_VAD_SILENCE_MS: z.coerce.number().int().min(200).max(2000).optional(),
  VOICE_NOISE_REDUCTION: z.enum(['near_field', 'far_field', 'off']).optional(),
  VOICE_BARGE_IN_MIN_MS: z.coerce.number().int().min(0).max(2000).optional(),
  VOICE_GREETING_BARGE_IN_MIN_MS: z.coerce.number().int().min(0).max(3000).optional(),
  VOICE_SHORT_REPLY_GRACE_MS: z.coerce.number().int().min(0).max(3000).optional(),
  VOICE_BARGE_IN_TAIL_MS: z.coerce.number().int().min(0).max(150).optional(),
  PORT: z.coerce.number().int().positive().default(4000),
  PUBLIC_SERVER_URL: z.url().optional(),
  // D-13 DEMO MODE (docs/SPEC.md): off unless DEMO_PAY_FIRST is "1" and the settings below are all present,
  // with Twilio credentials (apps/server/src/demo/config.ts decides). It must be off for real use.
  DEMO_PAY_FIRST: z.enum(['0', '1'], { error: 'DEMO_PAY_FIRST must be "1" (on) or "0" (off).' }).optional(),
  // The only numbers demo mode may message: comma-separated E.164 numbers.
  DEMO_TEXT_NUMBERS: z.string().regex(/^\s*\+[1-9][0-9]{6,14}\s*(,\s*\+[1-9][0-9]{6,14}\s*)*$/, { error: 'DEMO_TEXT_NUMBERS must be comma-separated E.164 numbers.' }).optional(),
  // Signs the demo pay and track links (HMAC-SHA256).
  DEMO_LINK_SECRET: z.string().min(32, { error: 'DEMO_LINK_SECRET must be at least 32 characters.' }).optional(),
  // The demo tracker: "Ready for pickup" this long after the confirmation when the pickup time is further away than DEMO_PICKUP_FAR_SECONDS.
  DEMO_READY_AFTER_SECONDS: z.coerce.number().int().min(10).max(86_400).optional(),
  DEMO_PICKUP_FAR_SECONDS: z.coerce.number().int().min(60).max(86_400).optional(),
  // AC-19: this build is sandbox only. Any other value stops the server.
  SQUARE_ENVIRONMENT: z
    .literal('sandbox', {
      error: 'SQUARE_ENVIRONMENT must be "sandbox". This build refuses to run against production Square.',
    })
    .default('sandbox'),
});

export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  // An empty value (`KEY=` in .env.local) counts as absent, so an unset optional key never stops the server.
  const present = Object.fromEntries(Object.entries(source).filter(([, v]) => typeof v === 'string' && v.trim() !== ''));
  const result = EnvSchema.safeParse(present);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  return result.data;
}
