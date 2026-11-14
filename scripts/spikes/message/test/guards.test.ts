import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, findEnvFile, loadEnv, parseChannel, resolveChannelConfig } from "../env.ts";
import type { FetchLike } from "../http.ts";
import { appendLog, checkDuplicate, checkSurgeCap, readLog, surgeDemoUsed, type SendLogEntry } from "../send-log.ts";
import { defaultIdempotencyKey, run } from "../send.ts";

let dir: string;
let logPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "b04-"));
  logPath = join(dir, "sends.log.jsonl");
});

function entry(over: Partial<SendLogEntry> = {}): SendLogEntry {
  return {
    time: "2026-11-13T00:00:00.000Z",
    channel: "surge",
    recipientLast4: "4567",
    status: "SENT",
    idempotencyKey: `k${Math.random()}`,
    ...over,
  };
}

const SURGE_ENV = ["--env", "SURGE_API_KEY=sk_dummy", "--env", "SURGE_ACCOUNT_ID=acct_dummy"];
const BASE = ["--channel", "surge", "--to", "+15551234567", "--url", "https://sandbox.square.link/u/abc123"];

function okFetch(): FetchLike {
  return vi.fn(async () => new Response(JSON.stringify({ id: "msg_ok", status: "pending" }), { status: 201 }));
}

describe("duplicate-key guard", () => {
  it("allows a new key and refuses a used one", () => {
    const entries = [entry({ idempotencyKey: "abc" })];
    expect(checkDuplicate(entries, "def").ok).toBe(true);
    const r = checkDuplicate(entries, "abc");
    expect(r.ok).toBe(false);
  });

  it("refuses a used key even when the first send FAILED or was UNKNOWN", () => {
    expect(checkDuplicate([entry({ idempotencyKey: "x", status: "UNKNOWN" })], "x").ok).toBe(false);
    expect(checkDuplicate([entry({ idempotencyKey: "y", status: "FAILED" })], "y").ok).toBe(false);
  });

  it("the CLI sends once, then refuses the same command, without calling the provider", async () => {
    const f = okFetch();
    const lines: string[] = [];
    const deps = { cwd: dir, processEnv: {}, logPath, fetchImpl: f, print: (l: string) => lines.push(l) };
    expect(await run([...BASE, ...SURGE_ENV], deps)).toBe(0);
    expect(await run([...BASE, ...SURGE_ENV], deps)).toBe(3);
    expect(f).toHaveBeenCalledTimes(1);
    expect(lines.join("\n")).toMatch(/already used/);
    const log = readLog(logPath);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ channel: "surge", recipientLast4: "4567", status: "SENT", providerMessageId: "msg_ok" });
    // The log never holds the full number.
    expect(readFileSync(logPath, "utf8")).not.toContain("5551234567");
  });

  it("default key is stable for the same channel, number and URL", () => {
    expect(defaultIdempotencyKey("surge", "+1", "u")).toBe(defaultIdempotencyKey("surge", "+1", "u"));
    expect(defaultIdempotencyKey("surge", "+1", "u")).not.toBe(defaultIdempotencyKey("surge", "+1", "v"));
  });
});

describe("Surge demo counter", () => {
  it("counts SENT and UNKNOWN Surge sends, not FAILED or other channels", () => {
    const entries = [
      entry({ status: "SENT" }),
      entry({ status: "UNKNOWN" }),
      entry({ status: "FAILED" }),
      entry({ channel: "whatsapp_sandbox", status: "SENT" }),
    ];
    expect(surgeDemoUsed(entries)).toBe(2);
  });

  it("allows at 24 and refuses at 25", () => {
    const entries = Array.from({ length: 24 }, () => entry());
    expect(checkSurgeCap(entries, 25)).toMatchObject({ ok: true, used: 24 });
    entries.push(entry());
    expect(checkSurgeCap(entries, 25)).toMatchObject({ ok: false, used: 25 });
  });

  it("the CLI refuses a Surge send at 25 without calling the provider", async () => {
    for (let i = 0; i < 25; i++) appendLog(entry(), logPath);
    const f = okFetch();
    const lines: string[] = [];
    const code = await run([...BASE, ...SURGE_ENV], { cwd: dir, processEnv: {}, logPath, fetchImpl: f, print: (l) => lines.push(l) });
    expect(code).toBe(4);
    expect(f).not.toHaveBeenCalled();
    expect(lines.join("\n")).toMatch(/25 of 25/);
  });
});

describe("env", () => {
  it("finds .env.local in a parent folder", () => {
    const child = join(dir, "a", "b");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(dir, ".env.local"), "MESSAGE_CHANNEL=surge\nSURGE_API_KEY=from_file\n");
    expect(findEnvFile(child)).toBe(join(dir, ".env.local"));
    const { env } = loadEnv({ cwd: child, processEnv: {}, overrides: { SURGE_API_KEY: "from_flag" } });
    expect(env.MESSAGE_CHANNEL).toBe("surge");
    expect(env.SURGE_API_KEY).toBe("from_flag");
  });

  it("names exactly the missing variable and never a value", () => {
    try {
      resolveChannelConfig({ SURGE_API_KEY: "secret_value_123" }, "surge");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const msg = (err as Error).message;
      expect(msg).toContain("SURGE_ACCOUNT_ID");
      expect(msg).not.toContain("SURGE_API_KEY:");
      expect(msg).not.toContain("secret_value_123");
    }
  });

  it("android_gateway needs the kind first, then that kind's variables", () => {
    expect(() => resolveChannelConfig({}, "android_gateway")).toThrow(/ANDROID_GATEWAY_KIND/);
    expect(() => resolveChannelConfig({ ANDROID_GATEWAY_KIND: "textbee" }, "android_gateway")).toThrow(/ANDROID_GATEWAY_API_KEY/);
    expect(() => resolveChannelConfig({ ANDROID_GATEWAY_KIND: "smsgate" }, "android_gateway")).toThrow(
      /ANDROID_GATEWAY_URL[\s\S]*ANDROID_GATEWAY_USERNAME[\s\S]*ANDROID_GATEWAY_PASSWORD/,
    );
    expect(() => resolveChannelConfig({ ANDROID_GATEWAY_KIND: "other" }, "android_gateway")).toThrow(/textbee or smsgate/);
  });

  it("whatsapp needs SID, token and from, and normalizes from", () => {
    expect(() => resolveChannelConfig({}, "whatsapp_sandbox")).toThrow(/TWILIO_ACCOUNT_SID[\s\S]*TWILIO_AUTH_TOKEN[\s\S]*TWILIO_WHATSAPP_FROM/);
    const c = resolveChannelConfig(
      { TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`, TWILIO_AUTH_TOKEN: "t", TWILIO_WHATSAPP_FROM: "+14155238886" },
      "whatsapp_sandbox",
    );
    expect(c).toMatchObject({ from: "whatsapp:+14155238886" });
  });

  it("rejects an unknown channel", () => {
    expect(() => parseChannel("sms")).toThrow(/Unknown channel/);
    expect(() => parseChannel(undefined)).toThrow(/MESSAGE_CHANNEL/);
  });

  it("the CLI reports a missing variable with exit code 2 and sends nothing", async () => {
    const f = okFetch();
    const lines: string[] = [];
    const code = await run(BASE, { cwd: dir, processEnv: {}, logPath, fetchImpl: f, print: (l) => lines.push(l) });
    expect(code).toBe(2);
    expect(lines.join("\n")).toMatch(/SURGE_API_KEY[\s\S]*SURGE_ACCOUNT_ID/);
    expect(f).not.toHaveBeenCalled();
  });

  it("the CLI rejects a bad --to with exit code 2", async () => {
    const code = await run(["--channel", "surge", "--to", "5551234567", "--url", "https://x.test", ...SURGE_ENV], {
      cwd: dir,
      processEnv: {},
      logPath,
      print: () => {},
    });
    expect(code).toBe(2);
  });

  it("dry run prints the request with secrets masked and writes no log", async () => {
    const f = okFetch();
    const lines: string[] = [];
    const code = await run([...BASE, ...SURGE_ENV, "--dry-run"], { cwd: dir, processEnv: {}, logPath, fetchImpl: f, print: (l) => lines.push(l) });
    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("POST https://api.surge.app/accounts/acct_dummy/messages");
    expect(out).toContain("Authorization: Bearer ****");
    expect(out).not.toContain("sk_dummy");
    expect(f).not.toHaveBeenCalled();
    expect(readLog(logPath)).toHaveLength(0);
  });
});
