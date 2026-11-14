// Finds and loads .env.local, then checks that the chosen channel has every
// variable it needs. It reports variable names only, never values.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";

export const CHANNEL_NAMES = ["surge", "android_gateway", "whatsapp_sandbox", "qr_only"] as const;
export type ChannelName = (typeof CHANNEL_NAMES)[number];

export type EnvMap = Record<string, string | undefined>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Walk up from startDir until a file called `name` is found. */
export function findEnvFile(startDir: string = process.cwd(), name = ".env.local"): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface LoadedEnv {
  env: EnvMap;
  /** Path of the .env.local that was read, if one was found. */
  file?: string;
}

/**
 * Precedence, highest first: overrides (from --env on the command line),
 * then the process environment, then .env.local.
 */
export function loadEnv(opts: { cwd?: string; overrides?: EnvMap; processEnv?: EnvMap } = {}): LoadedEnv {
  const file = findEnvFile(opts.cwd ?? process.cwd());
  const fromFile: EnvMap = file ? (parseEnv(readFileSync(file, "utf8")) as EnvMap) : {};
  const env: EnvMap = { ...fromFile, ...(opts.processEnv ?? process.env), ...(opts.overrides ?? {}) };
  return file ? { env, file } : { env };
}

// ---------------------------------------------------------------------------
// Channel configuration
// ---------------------------------------------------------------------------

export const DEFAULT_SURGE_BASE_URL = "https://api.surge.app";
export const DEFAULT_TEXTBEE_BASE_URL = "https://api.textbee.dev/api/v1";

export interface SurgeConfig {
  channel: "surge";
  apiKey: string;
  accountId: string;
  baseUrl: string;
  /** Sent as settings.link_shortening. "omit" leaves the field out. */
  linkShortening: "disabled" | "enabled" | "omit";
  timeoutMs: number;
}

export interface TextbeeConfig {
  channel: "android_gateway";
  kind: "textbee";
  baseUrl: string;
  apiKey: string;
  deviceId?: string;
  timeoutMs: number;
}

export interface SmsGateConfig {
  channel: "android_gateway";
  kind: "smsgate";
  baseUrl: string;
  username: string;
  password: string;
  deviceId?: string;
  timeoutMs: number;
}

export type AndroidGatewayConfig = TextbeeConfig | SmsGateConfig;

export interface WhatsAppSandboxConfig {
  channel: "whatsapp_sandbox";
  accountSid: string;
  authToken: string;
  /** Normalized to whatsapp:+E164. */
  from: string;
  timeoutMs: number;
}

export type ChannelConfig = SurgeConfig | AndroidGatewayConfig | WhatsAppSandboxConfig;

/** Where to find each variable, shown when it is missing. */
const HINTS: Record<string, string> = {
  MESSAGE_CHANNEL: "one of surge, android_gateway, whatsapp_sandbox, qr_only (or pass --channel)",
  SURGE_API_KEY: "Surge dashboard, left sidebar, API Keys",
  SURGE_ACCOUNT_ID: "Surge dashboard, top of the page, starts with acct_",
  ANDROID_GATEWAY_KIND: "textbee or smsgate",
  ANDROID_GATEWAY_URL: "SMSGate local: http://<phone-ip>:8080 (shown in the app). SMSGate cloud: https://api.sms-gate.app/3rdparty/v1",
  ANDROID_GATEWAY_API_KEY: "textbee dashboard, API keys",
  ANDROID_GATEWAY_USERNAME: "SMSGate app, Local Server or Cloud Server section",
  ANDROID_GATEWAY_PASSWORD: "SMSGate app, Local Server or Cloud Server section",
  TWILIO_ACCOUNT_SID: "Twilio Console home page, starts with AC",
  TWILIO_AUTH_TOKEN: "Twilio Console home page, next to the Account SID",
  TWILIO_WHATSAPP_FROM: "whatsapp:+14155238886, the sandbox number shown on the Try WhatsApp page",
};

function missingMessage(channel: string, names: string[]): string {
  const lines = names.map((n) => `  - ${n}: ${HINTS[n] ?? "see README.md"}`);
  return `Channel "${channel}" is missing ${names.length === 1 ? "this variable" : "these variables"}:\n${lines.join("\n")}\nSet ${names.length === 1 ? "it" : "them"} in .env.local or pass --env NAME=value.`;
}

function get(env: EnvMap, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

function need(env: EnvMap, names: string[], channel: string): Record<string, string> {
  const missing = names.filter((n) => !get(env, n));
  if (missing.length) throw new ConfigError(missingMessage(channel, missing));
  return Object.fromEntries(names.map((n) => [n, get(env, n) as string]));
}

function timeoutFrom(env: EnvMap): number {
  const raw = get(env, "MESSAGE_TIMEOUT_MS");
  if (!raw) return 15_000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1000 || n > 120_000) {
    throw new ConfigError("MESSAGE_TIMEOUT_MS must be a whole number of milliseconds from 1000 to 120000.");
  }
  return n;
}

function httpUrl(name: string, value: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new ConfigError(`${name} is not a valid URL.`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new ConfigError(`${name} must start with http:// or https://.`);
  return value.replace(/\/+$/, "");
}

export function parseChannel(value: string | undefined): ChannelName {
  if (!value) throw new ConfigError(missingMessage("(none chosen)", ["MESSAGE_CHANNEL"]));
  if (!(CHANNEL_NAMES as readonly string[]).includes(value)) {
    throw new ConfigError(`Unknown channel "${value}". Use one of: ${CHANNEL_NAMES.join(", ")}.`);
  }
  return value as ChannelName;
}

export function resolveChannelConfig(env: EnvMap, channel: Exclude<ChannelName, "qr_only">): ChannelConfig {
  const timeoutMs = timeoutFrom(env);

  if (channel === "surge") {
    const v = need(env, ["SURGE_API_KEY", "SURGE_ACCOUNT_ID"], channel);
    const ls = get(env, "SURGE_LINK_SHORTENING") ?? "disabled";
    if (ls !== "disabled" && ls !== "enabled" && ls !== "omit") {
      throw new ConfigError("SURGE_LINK_SHORTENING must be disabled, enabled or omit.");
    }
    return {
      channel,
      apiKey: v.SURGE_API_KEY as string,
      accountId: v.SURGE_ACCOUNT_ID as string,
      baseUrl: httpUrl("SURGE_BASE_URL", get(env, "SURGE_BASE_URL") ?? DEFAULT_SURGE_BASE_URL),
      linkShortening: ls,
      timeoutMs,
    };
  }

  if (channel === "android_gateway") {
    const { ANDROID_GATEWAY_KIND: kind } = need(env, ["ANDROID_GATEWAY_KIND"], channel);
    const deviceId = get(env, "ANDROID_GATEWAY_DEVICE_ID");
    if (kind === "textbee") {
      const v = need(env, ["ANDROID_GATEWAY_API_KEY"], `${channel} (textbee)`);
      return {
        channel,
        kind,
        baseUrl: httpUrl("ANDROID_GATEWAY_URL", get(env, "ANDROID_GATEWAY_URL") ?? DEFAULT_TEXTBEE_BASE_URL),
        apiKey: v.ANDROID_GATEWAY_API_KEY as string,
        ...(deviceId ? { deviceId } : {}),
        timeoutMs,
      };
    }
    if (kind === "smsgate") {
      const v = need(
        env,
        ["ANDROID_GATEWAY_URL", "ANDROID_GATEWAY_USERNAME", "ANDROID_GATEWAY_PASSWORD"],
        `${channel} (smsgate)`,
      );
      return {
        channel,
        kind,
        baseUrl: httpUrl("ANDROID_GATEWAY_URL", v.ANDROID_GATEWAY_URL as string),
        username: v.ANDROID_GATEWAY_USERNAME as string,
        password: v.ANDROID_GATEWAY_PASSWORD as string,
        ...(deviceId ? { deviceId } : {}),
        timeoutMs,
      };
    }
    throw new ConfigError(`ANDROID_GATEWAY_KIND must be textbee or smsgate, not "${kind}".`);
  }

  // whatsapp_sandbox
  const v = need(env, ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_FROM"], channel);
  const sid = v.TWILIO_ACCOUNT_SID as string;
  if (!/^AC[0-9a-fA-F]{32}$/.test(sid)) {
    throw new ConfigError("TWILIO_ACCOUNT_SID must be AC followed by 32 hex characters (it is on the Twilio Console home page).");
  }
  const rawFrom = (v.TWILIO_WHATSAPP_FROM as string).replace(/^whatsapp:/i, "");
  if (!/^\+[1-9]\d{6,14}$/.test(rawFrom)) {
    throw new ConfigError("TWILIO_WHATSAPP_FROM must look like whatsapp:+14155238886.");
  }
  return { channel, accountSid: sid, authToken: v.TWILIO_AUTH_TOKEN as string, from: `whatsapp:${rawFrom}`, timeoutMs };
}
