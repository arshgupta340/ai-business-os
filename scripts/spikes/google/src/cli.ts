// Shared CLI plumbing: config loading, argument parsing and error exits.

import { ConfigError, loadGoogleConfig, type GoogleConfig } from "./env.js";
import { explainGoogleError } from "./google.js";
import { FreeBusyError } from "./calendar.js";

export function parseArgs(argv: string[] = process.argv.slice(2)): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new ConfigError(`Unexpected argument "${a}". Use --name value.`);
    const eq = a.indexOf("=");
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[a.slice(2)] = "true";
      else {
        out[a.slice(2)] = next;
        i++;
      }
    }
  }
  return out;
}

let loaded: GoogleConfig | undefined;

/** Run a CLI entry point. Prints a clear one-line reason and exits 1 on failure. */
export function run(
  need: { calendar?: boolean; sheet?: boolean },
  main: (cfg: GoogleConfig) => Promise<void>,
): void {
  (async () => {
    loaded = loadGoogleConfig(need);
    await main(loaded);
  })().catch((err: unknown) => {
    console.error(describeError(err, loaded));
    process.exit(1);
  });
}

export function describeError(err: unknown, cfg?: GoogleConfig): string {
  if (err instanceof ConfigError) return `Config error: ${err.message}`;
  if (err instanceof FreeBusyError) return `Free/busy error: ${err.message}`;
  const e = err as { response?: unknown; status?: unknown; code?: unknown };
  if (e && (e.response || typeof e.status === "number" || typeof e.code === "number")) {
    return explainGoogleError(err, cfg?.serviceAccount);
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/DECODER routines|PEM|asn1|bad base64/i.test(message)) {
    return (
      `Key error: the private_key in GOOGLE_SERVICE_ACCOUNT_JSON could not be read as an RSA key (${message}). ` +
      `The key text is damaged or incomplete. Download a fresh JSON key (README step 4).`
    );
  }
  return `Error: ${message}`;
}
