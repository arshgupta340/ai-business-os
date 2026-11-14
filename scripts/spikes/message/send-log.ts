// The spike's send log: one JSON line per real send in sends.log.jsonl.
// It is the duplicate-key guard and the Surge demo counter. It never holds a
// full phone number or a secret.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MessageChannel, SendStatus } from "./adapter.ts";

export const DEFAULT_LOG_PATH = join(dirname(fileURLToPath(import.meta.url)), "sends.log.jsonl");

export interface SendLogEntry {
  time: string;
  channel: MessageChannel;
  /** textbee or smsgate, for android_gateway only. */
  kind?: string;
  recipientLast4: string;
  status: SendStatus;
  providerMessageId?: string;
  errorCode?: string;
  idempotencyKey: string;
}

export function readLog(path: string = DEFAULT_LOG_PATH): SendLogEntry[] {
  if (!existsSync(path)) return [];
  const entries: SendLogEntry[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as SendLogEntry);
    } catch {
      // A torn line is skipped, not fatal.
    }
  }
  return entries;
}

export function appendLog(entry: SendLogEntry, path: string = DEFAULT_LOG_PATH): void {
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
}

export function findByKey(entries: SendLogEntry[], key: string): SendLogEntry | undefined {
  return entries.find((e) => e.idempotencyKey === key);
}

/**
 * Surge demo messages the log shows as used. SENT and UNKNOWN both count,
 * because an UNKNOWN send may have gone out. FAILED does not.
 */
export function surgeDemoUsed(entries: SendLogEntry[]): number {
  return entries.filter((e) => e.channel === "surge" && (e.status === "SENT" || e.status === "UNKNOWN")).length;
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

export function checkDuplicate(entries: SendLogEntry[], key: string): GuardResult {
  const prior = findByKey(entries, key);
  if (!prior) return { ok: true };
  return {
    ok: false,
    reason:
      `Refusing to send: idempotency key ${key.slice(0, 12)}... was already used at ${prior.time} ` +
      `(${prior.channel}, status ${prior.status}). A key is never reused. ` +
      `To test again on purpose, pass a new --key.`,
  };
}

export function checkSurgeCap(entries: SendLogEntry[], limit: number): GuardResult & { used: number } {
  const used = surgeDemoUsed(entries);
  if (used >= limit) {
    return { ok: false, used, reason: `Refusing to send: the log shows ${used} of ${limit} Surge demo messages used.` };
  }
  return { ok: true, used };
}
