// D-13 DEMO MODE settings. Demo mode sets AGENTS rules 1 and 5 aside for the numbers the owner listed,
// and only while DEMO_PAY_FIRST is on. It must be off for real use. Off is the default: any missing
// setting keeps it off, and the server logs one line naming the missing settings (never their values).
import type { Env } from '../env';

export const DEMO_MAKING_AFTER_MS = 30_000;
export const DEMO_READY_AFTER_DEFAULT_S = 180;
export const DEMO_PICKUP_FAR_DEFAULT_S = 600;

export type DemoConfig = {
  on: true;
  /** The only numbers demo mode may message (E.164). */
  numbers: ReadonlySet<string>;
  secret: string;
  /** PUBLIC_SERVER_URL without a trailing slash. */
  publicUrl: string;
  twilio: { accountSid: string; authToken: string; from?: string | undefined };
  makingAfterMs: number;
  readyAfterMs: number;
  pickupFarMs: number;
};
export type DemoOff = { on: false; reason: string };

export function parseDemoNumbers(raw: string): string[] {
  return [...new Set(raw.split(',').map((n) => n.trim()).filter((n) => /^\+[1-9][0-9]{6,14}$/.test(n)))];
}

export function demoConfig(env: Env): DemoConfig | DemoOff {
  if (env.DEMO_PAY_FIRST !== '1') return { on: false, reason: 'DEMO_PAY_FIRST is not 1' };
  const missing = [
    ...(env.DEMO_TEXT_NUMBERS ? [] : ['DEMO_TEXT_NUMBERS']),
    ...(env.DEMO_LINK_SECRET ? [] : ['DEMO_LINK_SECRET']),
    ...(env.PUBLIC_SERVER_URL ? [] : ['PUBLIC_SERVER_URL']),
    ...(env.TWILIO_ACCOUNT_SID ? [] : ['TWILIO_ACCOUNT_SID']),
    ...(env.TWILIO_AUTH_TOKEN ? [] : ['TWILIO_AUTH_TOKEN']),
  ];
  if (missing.length > 0) return { on: false, reason: `missing ${missing.join(', ')}` };
  const numbers = parseDemoNumbers(env.DEMO_TEXT_NUMBERS!);
  if (numbers.length === 0) return { on: false, reason: 'DEMO_TEXT_NUMBERS lists no number' };
  return {
    on: true,
    numbers: new Set(numbers),
    secret: env.DEMO_LINK_SECRET!,
    publicUrl: env.PUBLIC_SERVER_URL!.replace(/\/+$/, ''),
    twilio: { accountSid: env.TWILIO_ACCOUNT_SID!, authToken: env.TWILIO_AUTH_TOKEN!, ...(env.TWILIO_WHATSAPP_FROM ? { from: env.TWILIO_WHATSAPP_FROM } : {}) },
    makingAfterMs: DEMO_MAKING_AFTER_MS,
    readyAfterMs: (env.DEMO_READY_AFTER_SECONDS ?? DEMO_READY_AFTER_DEFAULT_S) * 1000,
    pickupFarMs: (env.DEMO_PICKUP_FAR_SECONDS ?? DEMO_PICKUP_FAR_DEFAULT_S) * 1000,
  };
}
