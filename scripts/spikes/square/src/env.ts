// Loads .env.local by walking up from the current directory and returns the
// Square variables this spike needs. Never prints a secret value.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

export const SQUARE_VARS = [
  "SQUARE_ENVIRONMENT",
  "SQUARE_ACCESS_TOKEN",
  "SQUARE_LOCATION_ID",
  "SQUARE_WEBHOOK_SIGNATURE_KEY",
  "SQUARE_WEBHOOK_URL",
] as const;

export type SquareVar = (typeof SQUARE_VARS)[number];
export type SquareEnv = Record<SquareVar, string>;

/** Returns the path of the nearest .env.local at or above `start`, or null. */
export function findEnvFile(start: string = process.cwd()): string | null {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, ".env.local");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

let loadedFrom: string | null | undefined;

function loadOnce(): string | null {
  if (loadedFrom !== undefined) return loadedFrom;
  loadedFrom = findEnvFile();
  if (loadedFrom) {
    // quiet: true stops dotenv from printing its own banner.
    loadDotenv({ path: loadedFrom, quiet: true });
  }
  return loadedFrom;
}

function fail(message: string): never {
  console.error(`ENV ERROR: ${message}`);
  process.exit(1);
}

/**
 * Returns the requested variables, or exits naming the missing ones.
 * SQUARE_ENVIRONMENT is always required and must be exactly "sandbox".
 */
export function requireSquareEnv<K extends SquareVar>(
  needed: readonly K[],
): Pick<SquareEnv, K | "SQUARE_ENVIRONMENT"> {
  const file = loadOnce();
  const names = Array.from(new Set<SquareVar>(["SQUARE_ENVIRONMENT", ...needed]));
  const missing = names.filter((n) => !process.env[n] || process.env[n]!.trim() === "");
  if (missing.length > 0) {
    const where = file
      ? `Loaded ${file}.`
      : `No .env.local found in ${process.cwd()} or any parent directory.`;
    fail(`missing ${missing.join(", ")}. ${where} See README.md step 3.`);
  }
  if (process.env.SQUARE_ENVIRONMENT !== "sandbox") {
    fail('SQUARE_ENVIRONMENT must be exactly "sandbox". This spike refuses to run against production.');
  }
  const out = {} as Record<SquareVar, string>;
  for (const n of names) out[n] = process.env[n]!.trim();
  return out as Pick<SquareEnv, K | "SQUARE_ENVIRONMENT">;
}
