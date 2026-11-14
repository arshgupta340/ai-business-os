// Loads .env.local and the Google service account key. Never prints the key.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseEnv } from "node:util";

export class ConfigError extends Error {
  override name = "ConfigError";
}

export const GOOGLE_VARS = [
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "GOOGLE_CALENDAR_ID",
  "GOOGLE_SHEET_ID",
] as const;
export type GoogleVar = (typeof GOOGLE_VARS)[number];

/** Walks up from `startDir` and returns the first `.env.local` found, or undefined. */
export function findEnvFile(startDir: string, fileName = ".env.local"): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, fileName);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Loads the nearest `.env.local` above `startDir` into process.env.
 * Variables already set in the environment win over the file.
 * Returns the path that was loaded, or undefined.
 */
export function loadEnvLocal(startDir: string = process.cwd()): string | undefined {
  const path = findEnvFile(startDir);
  if (!path) return undefined;
  const parsed = parseEnv(readFileSync(path, "utf8"));
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined || process.env[k] === "") process.env[k] = v;
  }
  return path;
}

export interface ServiceAccount {
  clientEmail: string;
  privateKey: string;
  projectId?: string;
  /** Where the key came from, safe to print: "inline JSON" or the file path. */
  source: string;
}

/**
 * JSON forbids raw newlines inside strings. A dotenv parser that expands "\n"
 * inside double quotes turns the key's escaped newlines into raw ones, so we
 * escape raw control characters again, but only inside string literals.
 */
export function escapeControlCharsInStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
      } else if (ch === "\\") {
        escaped = true;
        out += ch;
      } else if (ch === '"') {
        inString = false;
        out += ch;
      } else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else out += ch;
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return out;
}

/**
 * Accepts either the key file's JSON text or a path to the key file.
 * A relative path is resolved against `baseDir` (the folder holding .env.local).
 * Error messages never include the key text.
 */
export function parseServiceAccount(raw: string, baseDir: string = process.cwd()): ServiceAccount {
  let text = raw.trim();
  // Strip one layer of matching quotes left by a hand-edited env file.
  if (text.length >= 2 && (text[0] === "'" || text[0] === '"') && text.at(-1) === text[0]) {
    text = text.slice(1, -1).trim();
  }
  let source = "inline JSON";
  if (!text.startsWith("{")) {
    const path = isAbsolute(text) ? text : resolve(baseDir, text);
    if (!existsSync(path)) {
      throw new ConfigError(
        `GOOGLE_SERVICE_ACCOUNT_JSON does not start with "{", so it was read as a file path, ` +
          `but no file exists at ${path}. Set it to the key file's path or paste the JSON text.`,
      );
    }
    text = readFileSync(path, "utf8").trim();
    source = path;
  }

  if (!text.endsWith("}")) {
    throw new ConfigError(
      `GOOGLE_SERVICE_ACCOUNT_JSON (${source}) looks cut off: it does not end with "}". ` +
        `In .env.local this happens when the JSON is wrapped in double quotes, because the first " inside ` +
        `the JSON ends the value. Wrap it in single quotes, or set the variable to the key file's path.`,
    );
  }
  let obj: unknown;
  try {
    obj = JSON.parse(escapeControlCharsInStrings(text));
  } catch {
    // Do not attach the parser message: recent V8 versions quote the input.
    throw new ConfigError(
      `GOOGLE_SERVICE_ACCOUNT_JSON (${source}) is not valid JSON. ` +
        `Paste the whole key file on one line inside single quotes, or set the variable to the file path.`,
    );
  }
  if (typeof obj !== "object" || obj === null) {
    throw new ConfigError(`GOOGLE_SERVICE_ACCOUNT_JSON (${source}) is not a JSON object.`);
  }
  const o = obj as Record<string, unknown>;
  if (o.type !== "service_account") {
    throw new ConfigError(
      `GOOGLE_SERVICE_ACCOUNT_JSON (${source}) has type "${String(o.type)}", expected "service_account". ` +
        `Download a key for a service account, not an OAuth client.`,
    );
  }
  if (typeof o.client_email !== "string" || !o.client_email.includes("@")) {
    throw new ConfigError(`GOOGLE_SERVICE_ACCOUNT_JSON (${source}) has no client_email.`);
  }
  if (typeof o.private_key !== "string" || o.private_key.length === 0) {
    throw new ConfigError(`GOOGLE_SERVICE_ACCOUNT_JSON (${source}) has no private_key.`);
  }
  // If the key was escaped twice, its newlines arrive as the two characters \ and n.
  const privateKey = o.private_key.replace(/\\r\\n|\\n/g, "\n").replace(/\r\n/g, "\n");
  if (!/^-----BEGIN (RSA )?PRIVATE KEY-----\n/.test(privateKey) || !/-----END (RSA )?PRIVATE KEY-----\s*$/.test(privateKey)) {
    throw new ConfigError(
      `GOOGLE_SERVICE_ACCOUNT_JSON (${source}): private_key is not a PEM block with line breaks. ` +
        `Check that the key was pasted whole.`,
    );
  }
  return {
    clientEmail: o.client_email,
    privateKey,
    projectId: typeof o.project_id === "string" ? o.project_id : undefined,
    source,
  };
}

export interface GoogleConfig {
  envFile: string | undefined;
  serviceAccount: ServiceAccount;
  calendarId: string;
  sheetId: string;
}

/**
 * Loads .env.local and checks the named variables. Throws a ConfigError that
 * names every missing variable. The service account is always required.
 */
export function loadGoogleConfig(
  need: { calendar?: boolean; sheet?: boolean } = { calendar: true, sheet: true },
  startDir: string = process.cwd(),
): GoogleConfig {
  const envFile = loadEnvLocal(startDir);
  const required: GoogleVar[] = ["GOOGLE_SERVICE_ACCOUNT_JSON"];
  if (need.calendar) required.push("GOOGLE_CALENDAR_ID");
  if (need.sheet) required.push("GOOGLE_SHEET_ID");
  const missing = required.filter((k) => !process.env[k]?.trim());
  if (missing.length) {
    const where = envFile
      ? `Loaded ${envFile}, but it does not set them.`
      : `No .env.local was found in ${resolve(startDir)} or any folder above it.`;
    throw new ConfigError(
      `Missing environment variable${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. ${where} ` +
        `See scripts/spikes/google/README.md, step 9.`,
    );
  }
  const baseDir = envFile ? dirname(envFile) : process.cwd();
  return {
    envFile,
    serviceAccount: parseServiceAccount(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!, baseDir),
    calendarId: process.env.GOOGLE_CALENDAR_ID?.trim() ?? "",
    sheetId: process.env.GOOGLE_SHEET_ID?.trim() ?? "",
  };
}
