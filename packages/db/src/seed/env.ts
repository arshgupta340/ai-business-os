// Environment handling for the operator scripts. Values are read from a plain record so tests can
// pass their own; nothing here prints a value.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export type SeedEnv = Readonly<Record<string, string | undefined>>;

export class MissingEnvError extends Error {
  constructor(readonly missing: string[], hint: string) {
    super(`Missing required environment variable${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}. ${hint}`);
    this.name = 'MissingEnvError';
  }
}

/** The trimmed value, or undefined when the variable is unset or blank. */
export function envValue(env: SeedEnv, name: string): string | undefined {
  const v = env[name];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

/** Throws one error that names every missing variable. */
export function requireEnv(env: SeedEnv, names: readonly string[], hint: string): Record<string, string> {
  const missing = names.filter((n) => envValue(env, n) === undefined);
  if (missing.length > 0) throw new MissingEnvError(missing, hint);
  const out: Record<string, string> = {};
  for (const n of names) out[n] = envValue(env, n)!;
  return out;
}

/** A strong random password: 24 random bytes, base64url, 32 characters. */
export function generatePassword(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Writes KEY=value lines into an env file. A line that already sets the key (often an empty
 * placeholder) is replaced in place; any other key is appended at the end. Creates the file if needed.
 */
export function writeEnvVars(path: string, vars: Record<string, string>): void {
  const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = original === '' ? [] : original.replace(/\r?\n$/, '').split(/\r?\n/);
  for (const [key, value] of Object.entries(vars)) {
    const at = lines.findIndex((l) => new RegExp(`^\\s*(export\\s+)?${key}\\s*=`).test(l));
    const line = `${key}=${value}`;
    if (at >= 0) lines[at] = line;
    else lines.push(line);
  }
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}
