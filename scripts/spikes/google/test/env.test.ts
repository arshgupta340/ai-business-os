import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  findEnvFile,
  GOOGLE_VARS,
  loadGoogleConfig,
  parseServiceAccount,
} from "../src/env.js";

// A fake key. It is shaped like a PEM block but is not a real key.
const FAKE_PEM = "-----BEGIN PRIVATE KEY-----\nFAKEFAKEFAKEFAKE\nNOTAREALKEY0000\n-----END PRIVATE KEY-----\n";
const FAKE_KEY = {
  type: "service_account",
  project_id: "spike-test",
  private_key_id: "0000",
  private_key: FAKE_PEM,
  client_email: "spike@spike-test.iam.gserviceaccount.com",
  client_id: "1",
};
// What the downloaded file looks like: JSON with "\n" escapes in private_key.
const FAKE_JSON_ONE_LINE = JSON.stringify(FAKE_KEY);

let dir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "spike-google-"));
  for (const k of GOOGLE_VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of GOOGLE_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("parseServiceAccount", () => {
  it("reads inline JSON and turns escaped newlines into real ones", () => {
    expect(FAKE_JSON_ONE_LINE).toContain("\\n");
    const sa = parseServiceAccount(FAKE_JSON_ONE_LINE);
    expect(sa.clientEmail).toBe(FAKE_KEY.client_email);
    expect(sa.privateKey).toBe(FAKE_PEM);
    expect(sa.privateKey).not.toContain("\\n");
    expect(sa.source).toBe("inline JSON");
    expect(sa.projectId).toBe("spike-test");
  });

  it("reads inline JSON whose newlines a dotenv parser already expanded", () => {
    const expanded = FAKE_JSON_ONE_LINE.replace(/\\n/g, "\n");
    expect(() => JSON.parse(expanded)).toThrow(); // raw newlines inside a string
    expect(parseServiceAccount(expanded).privateKey).toBe(FAKE_PEM);
  });

  it("reads a pretty-printed key and a twice-escaped key", () => {
    expect(parseServiceAccount(JSON.stringify(FAKE_KEY, null, 2)).privateKey).toBe(FAKE_PEM);
    const twice = JSON.stringify({ ...FAKE_KEY, private_key: FAKE_PEM.replace(/\n/g, "\\n") });
    expect(parseServiceAccount(twice).privateKey).toBe(FAKE_PEM);
  });

  it("strips one layer of surrounding quotes", () => {
    expect(parseServiceAccount(`'${FAKE_JSON_ONE_LINE}'`).clientEmail).toBe(FAKE_KEY.client_email);
  });

  it("reads a key file by absolute path and by path relative to the env file folder", () => {
    const file = join(dir, "key.json");
    writeFileSync(file, JSON.stringify(FAKE_KEY, null, 2));
    const abs = parseServiceAccount(file);
    expect(abs.privateKey).toBe(FAKE_PEM);
    expect(abs.source).toBe(file);
    const rel = parseServiceAccount("key.json", dir);
    expect(rel.clientEmail).toBe(FAKE_KEY.client_email);
  });

  it("names the path when the key file is missing", () => {
    expect(() => parseServiceAccount("missing.json", dir)).toThrow(ConfigError);
    expect(() => parseServiceAccount("missing.json", dir)).toThrow(/no file exists at .*missing\.json/);
  });

  it("never echoes key text when the JSON is broken", () => {
    const broken = FAKE_JSON_ONE_LINE.replace('"type":', '"type" ');
    try {
      parseServiceAccount(broken);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const msg = (err as Error).message;
      expect(msg).toMatch(/not valid JSON/);
      expect(msg).not.toContain("FAKEFAKE");
      expect(msg).not.toContain("PRIVATE KEY");
    }
  });

  it("rejects a key that is not a service account or lacks fields", () => {
    expect(() => parseServiceAccount(JSON.stringify({ ...FAKE_KEY, type: "authorized_user" }))).toThrow(/service_account/);
    expect(() => parseServiceAccount(JSON.stringify({ ...FAKE_KEY, client_email: undefined }))).toThrow(/client_email/);
    expect(() => parseServiceAccount(JSON.stringify({ ...FAKE_KEY, private_key: "abc" }))).toThrow(/PEM/);
  });
});

describe("env loading", () => {
  it("finds .env.local by walking up parent folders", () => {
    const child = join(dir, "a", "b", "c");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(dir, ".env.local"), "X=1\n");
    expect(findEnvFile(child)).toBe(join(dir, ".env.local"));
  });

  it("names every missing variable", () => {
    const child = join(dir, "empty");
    mkdirSync(child);
    // tmpdir may sit under a folder with its own .env.local; only check names.
    expect(() => loadGoogleConfig({ calendar: true, sheet: true }, child)).toThrow(
      /Missing environment variables: GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_CALENDAR_ID, GOOGLE_SHEET_ID/,
    );
  });

  it("names only the one missing variable", () => {
    writeFileSync(
      join(dir, ".env.local"),
      `GOOGLE_SERVICE_ACCOUNT_JSON='${FAKE_JSON_ONE_LINE}'\nGOOGLE_CALENDAR_ID=cal@example.com\n`,
    );
    expect(() => loadGoogleConfig({ calendar: true, sheet: true }, dir)).toThrow(
      /Missing environment variable: GOOGLE_SHEET_ID\. Loaded .*\.env\.local/,
    );
  });

  it("explains the double-quote mistake instead of failing vaguely", () => {
    writeFileSync(join(dir, ".env.local"), `GOOGLE_SERVICE_ACCOUNT_JSON="${FAKE_JSON_ONE_LINE}"\n`);
    expect(() => loadGoogleConfig({}, dir)).toThrow(/looks cut off.*single quotes/);
  });

  it("loads inline JSON in single quotes, multi-line in single quotes, and unquoted from .env.local", () => {
    const pretty = JSON.stringify(FAKE_KEY, null, 2);
    for (const value of [`'${FAKE_JSON_ONE_LINE}'`, `'${pretty}'`, FAKE_JSON_ONE_LINE]) {
      for (const k of GOOGLE_VARS) delete process.env[k];
      writeFileSync(
        join(dir, ".env.local"),
        `GOOGLE_SERVICE_ACCOUNT_JSON=${value}\n` +
          `GOOGLE_CALENDAR_ID=cal@group.calendar.google.com\nGOOGLE_SHEET_ID=sheet123\n`,
      );
      const cfg = loadGoogleConfig({ calendar: true, sheet: true }, dir);
      expect(cfg.serviceAccount.privateKey).toBe(FAKE_PEM);
      expect(cfg.calendarId).toBe("cal@group.calendar.google.com");
      expect(cfg.sheetId).toBe("sheet123");
    }
  });

  it("loads a key path relative to the .env.local folder", () => {
    writeFileSync(join(dir, "key.json"), FAKE_JSON_ONE_LINE);
    writeFileSync(join(dir, ".env.local"), "GOOGLE_SERVICE_ACCOUNT_JSON=key.json\n");
    const child = join(dir, "sub");
    mkdirSync(child);
    const cfg = loadGoogleConfig({}, child);
    expect(cfg.serviceAccount.source).toBe(join(dir, "key.json"));
  });
});
