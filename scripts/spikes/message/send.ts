// Command line tool for spike B-04. Sends one checkout-link message.
//
//   npm run send -- --channel surge --to +15551234567 --url https://...
//   npm run send -- --channel surge --to +15551234567 --url https://... --dry-run
//   npm run send -- --channel android_gateway --env ANDROID_GATEWAY_KIND=smsgate ... --dry-run
//
// Exit codes: 0 sent (or dry run, or qr_only), 1 send FAILED or UNKNOWN,
// 2 bad input or missing configuration, 3 duplicate key, 4 Surge demo cap reached.

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isE164, last4 } from "./adapter.ts";
import { AndroidGatewayAdapter } from "./android-gateway.ts";
import { checkoutMessage, createAdapter } from "./channels.ts";
import { ConfigError, loadEnv, parseChannel, resolveChannelConfig, type EnvMap } from "./env.ts";
import { maskRequest, type FetchLike } from "./http.ts";
import { appendLog, checkDuplicate, checkSurgeCap, DEFAULT_LOG_PATH, readLog } from "./send-log.ts";
import { SURGE_DEMO_MESSAGE_LIMIT } from "./surge.ts";

export interface RunDeps {
  cwd?: string;
  processEnv?: EnvMap;
  logPath?: string;
  fetchImpl?: FetchLike;
  print?: (line: string) => void;
  now?: () => Date;
}

const USAGE = `Usage: npm run send -- --channel <surge|android_gateway|whatsapp_sandbox|qr_only> --to <+E164> --url <https://...> [--key <idempotency key>] [--dry-run] [--env NAME=value ...]`;

/** Default key: the same command twice gives the same key, so the guard refuses the second send. */
export function defaultIdempotencyKey(channel: string, to: string, url: string): string {
  return createHash("sha256").update(`spike-b04:${channel}:${to}:${url}`).digest("hex");
}

function parseOverrides(pairs: string[]): EnvMap {
  const out: EnvMap = {};
  for (const p of pairs) {
    const i = p.indexOf("=");
    if (i <= 0) throw new ConfigError(`--env needs NAME=value, got "${p.slice(0, 40)}".`);
    out[p.slice(0, i)] = p.slice(i + 1);
  }
  return out;
}

export async function run(argv: string[], deps: RunDeps = {}): Promise<number> {
  const print = deps.print ?? ((l: string) => console.log(l));
  const logPath = deps.logPath ?? DEFAULT_LOG_PATH;

  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        channel: { type: "string" },
        to: { type: "string" },
        url: { type: "string" },
        key: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        env: { type: "string", multiple: true, default: [] },
        help: { type: "boolean", default: false },
      },
      strict: true,
    }).values;
  } catch (err) {
    print(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    print(USAGE);
    return 0;
  }
  const dryRun = args["dry-run"] === true;

  try {
    const overrides = parseOverrides(args.env ?? []);
    const loaded = loadEnv({ cwd: deps.cwd ?? process.cwd(), overrides, processEnv: deps.processEnv ?? process.env });
    print(loaded.file ? `Loaded ${loaded.file}` : "No .env.local found in this folder or any parent folder.");

    const channel = parseChannel(args.channel ?? loaded.env.MESSAGE_CHANNEL);
    if (channel === "qr_only") {
      print("Channel is qr_only: nothing is sent. The dashboard QR code carries the link.");
      return 0;
    }

    const to = args.to ?? "";
    if (!isE164(to)) {
      print(`--to must be an E.164 number such as +15551234567 (no spaces or dashes).\n${USAGE}`);
      return 2;
    }
    let url: URL;
    try {
      url = new URL(args.url ?? "");
    } catch {
      print(`--url must be a full https:// link.\n${USAGE}`);
      return 2;
    }
    if (url.protocol !== "https:") {
      print("--url must start with https://.");
      return 2;
    }

    const config = resolveChannelConfig(loaded.env, channel);
    const adapter = createAdapter(config, deps.fetchImpl);
    const body = checkoutMessage(args.url as string);
    const kind = adapter instanceof AndroidGatewayAdapter ? adapter.kind : undefined;
    // The kind is part of the default key, so trying textbee after SMSGate with the same link is not refused.
    const idempotencyKey = args.key ?? defaultIdempotencyKey(kind ? `${channel}:${kind}` : channel, to, args.url as string);

    const entries = readLog(logPath);
    const dup = checkDuplicate(entries, idempotencyKey);
    if (!dup.ok) {
      if (!dryRun) {
        print(dup.reason);
        return 3;
      }
      print(`Note (dry run): ${dup.reason}`);
    }

    if (channel === "surge") {
      const cap = checkSurgeCap(entries, SURGE_DEMO_MESSAGE_LIMIT);
      print(`Surge demo messages used according to the log: ${cap.used} of ${SURGE_DEMO_MESSAGE_LIMIT}.`);
      if (!cap.ok) {
        print(cap.reason);
        return 4;
      }
    }

    print(`Channel: ${channel}${kind ? ` (${kind})` : ""}. Recipient: ...${last4(to)}. Key: ${idempotencyKey.slice(0, 12)}...`);

    if (dryRun) {
      const req = maskRequest(adapter.buildRequest({ to, body, idempotencyKey }));
      print("DRY RUN. Nothing was sent. This is the exact request:");
      print(`${req.method} ${req.url}`);
      for (const [k, v] of Object.entries(req.headers)) print(`${k}: ${v}`);
      print("");
      print(req.body);
      return 0;
    }

    const started = Date.now();
    const result = await adapter.send({ to, body, idempotencyKey });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    appendLog(
      {
        time: (deps.now?.() ?? new Date()).toISOString(),
        channel,
        ...(kind ? { kind } : {}),
        recipientLast4: last4(to),
        status: result.status,
        ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}),
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        idempotencyKey,
      },
      logPath,
    );

    print(`Status: ${result.status} (API answered in ${seconds} s)`);
    if (result.providerMessageId) print(`Provider message ID: ${result.providerMessageId}`);
    if (result.errorCode) print(`Error code: ${result.errorCode}`);
    if (result.raw !== undefined) print(`Provider response: ${JSON.stringify(result.raw)}`);
    if (result.status === "UNKNOWN") {
      print("UNKNOWN means the message may or may not have gone out. Check the phone. Do not resend with the same key.");
    }
    if (result.status === "SENT") print("SENT means the provider accepted it. Now check the phone: arrival, link intact, link opens.");
    return result.status === "SENT" ? 0 : 1;
  } catch (err) {
    if (err instanceof ConfigError) {
      print(err.message);
      return 2;
    }
    throw err;
  }
}

const samePath = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
if (process.argv[1] && samePath(fileURLToPath(import.meta.url), process.argv[1])) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    },
  );
}
