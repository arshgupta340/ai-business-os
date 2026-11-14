import { describe, expect, it, vi } from "vitest";
import { assertE164, isE164, type InspectableAdapter, type SendInput } from "../adapter.ts";
import { AndroidGatewayAdapter } from "../android-gateway.ts";
import type { SmsGateConfig, SurgeConfig, TextbeeConfig, WhatsAppSandboxConfig } from "../env.ts";
import { maskRequest, type FetchLike } from "../http.ts";
import { SurgeAdapter } from "../surge.ts";
import { WhatsAppSandboxAdapter } from "../whatsapp-sandbox.ts";

const input: SendInput = {
  to: "+15551234567",
  body: "Demo Pizza Co.: pay for your pickup order here: https://sandbox.square.link/u/abc123. Sandbox test payment.",
  idempotencyKey: "a".repeat(64),
};

const surgeConfig: SurgeConfig = {
  channel: "surge",
  apiKey: "sk_test_surge",
  accountId: "acct_01jtest",
  baseUrl: "https://api.surge.app",
  linkShortening: "disabled",
  timeoutMs: 1000,
};
const textbeeConfig: TextbeeConfig = {
  channel: "android_gateway",
  kind: "textbee",
  baseUrl: "https://api.textbee.dev/api/v1",
  apiKey: "tb_key",
  deviceId: "dev123",
  timeoutMs: 1000,
};
const smsGateLocal: SmsGateConfig = {
  channel: "android_gateway",
  kind: "smsgate",
  baseUrl: "http://192.168.1.50:8080",
  username: "sms",
  password: "pw",
  timeoutMs: 1000,
};
const smsGateCloud: SmsGateConfig = { ...smsGateLocal, baseUrl: "https://api.sms-gate.app/3rdparty/v1" };
const waConfig: WhatsAppSandboxConfig = {
  channel: "whatsapp_sandbox",
  accountSid: `AC${"0".repeat(32)}`,
  authToken: "tok",
  from: "whatsapp:+14155238886",
  timeoutMs: 1000,
};

function respond(status: number, body: unknown): FetchLike {
  return vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
}

const timeoutFetch: FetchLike = vi.fn(async () => {
  throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
});

/** A fetch that never answers, so the adapter's own AbortSignal.timeout must fire. */
const hangingFetch: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });

type Case = {
  name: string;
  make: (f?: FetchLike) => InspectableAdapter;
  ok: { status: number; body: unknown; id: string };
  bad: { status: number; body: unknown; code: string };
};

const cases: Case[] = [
  {
    name: "surge",
    make: (f) => new SurgeAdapter(surgeConfig, f),
    ok: { status: 201, body: { id: "msg_01", status: "pending", created_at: "2026-11-13T00:00:00Z" }, id: "msg_01" },
    bad: { status: 403, body: { error: { type: "demo_message_limit", message: "Demo messaging limit has been reached." } }, code: "demo_message_limit" },
  },
  {
    name: "textbee",
    make: (f) => new AndroidGatewayAdapter(textbeeConfig, f),
    ok: { status: 200, body: { data: { success: true, message: "ok", smsBatchId: "batch_1", recipientCount: 1 } }, id: "batch_1" },
    bad: { status: 401, body: { message: "Unauthorized" }, code: "http_401" },
  },
  {
    name: "smsgate",
    make: (f) => new AndroidGatewayAdapter(smsGateLocal, f),
    ok: { status: 202, body: { id: "PyDmBQZZXYmyxMwED8Fzy", state: "Pending", recipients: [] }, id: "PyDmBQZZXYmyxMwED8Fzy" },
    bad: { status: 400, body: { code: 400, message: "Invalid request" }, code: "http_400" },
  },
  {
    name: "whatsapp_sandbox",
    make: (f) => new WhatsAppSandboxAdapter(waConfig, f),
    ok: { status: 201, body: { sid: "SM123", status: "queued" }, id: "SM123" },
    bad: { status: 400, body: { code: 63015, message: "not in sandbox", status: 400 }, code: "twilio_63015" },
  },
];

describe("request building", () => {
  it("surge: POST /accounts/{id}/messages, Bearer auth, to and body", () => {
    const req = new SurgeAdapter(surgeConfig).buildRequest(input);
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://api.surge.app/accounts/acct_01jtest/messages");
    expect(req.headers.Authorization).toBe("Bearer sk_test_surge");
    expect(req.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(req.body)).toEqual({
      to: "+15551234567",
      body: input.body,
      metadata: { idempotency_key: input.idempotencyKey },
      settings: { link_shortening: "disabled" },
    });
  });

  it("surge: link_shortening can be left out", () => {
    const req = new SurgeAdapter({ ...surgeConfig, linkShortening: "omit" }).buildRequest(input);
    expect(JSON.parse(req.body).settings).toBeUndefined();
  });

  it("textbee: POST /gateway/send-sms, x-api-key, recipients and message", () => {
    const req = new AndroidGatewayAdapter(textbeeConfig).buildRequest(input);
    expect(req.url).toBe("https://api.textbee.dev/api/v1/gateway/send-sms");
    expect(req.headers["x-api-key"]).toBe("tb_key");
    expect(JSON.parse(req.body)).toEqual({ recipients: ["+15551234567"], message: input.body, deviceId: "dev123" });
  });

  it("smsgate local: POST :8080/message, basic auth, textMessage and phoneNumbers, id capped at 36", () => {
    const req = new AndroidGatewayAdapter(smsGateLocal).buildRequest(input);
    expect(req.url).toBe("http://192.168.1.50:8080/message");
    expect(req.headers.Authorization).toBe(`Basic ${Buffer.from("sms:pw").toString("base64")}`);
    const body = JSON.parse(req.body);
    expect(body).toEqual({ id: "a".repeat(36), textMessage: { text: input.body }, phoneNumbers: ["+15551234567"] });
  });

  it("smsgate cloud: POST /3rdparty/v1/messages", () => {
    const req = new AndroidGatewayAdapter(smsGateCloud).buildRequest(input);
    expect(req.url).toBe("https://api.sms-gate.app/3rdparty/v1/messages");
  });

  it("whatsapp: form-encoded To and From with whatsapp: prefix, basic auth with SID and token", () => {
    const req = new WhatsAppSandboxAdapter(waConfig).buildRequest(input);
    expect(req.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${waConfig.accountSid}/Messages.json`);
    expect(req.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(req.headers.Authorization).toBe(`Basic ${Buffer.from(`${waConfig.accountSid}:tok`).toString("base64")}`);
    const form = new URLSearchParams(req.body);
    expect(form.get("To")).toBe("whatsapp:+15551234567");
    expect(form.get("From")).toBe("whatsapp:+14155238886");
    expect(form.get("Body")).toBe(input.body);
  });

  it("the URL in the body is passed through unchanged", () => {
    for (const c of cases) {
      const req = c.make().buildRequest(input);
      const text = req.headers["Content-Type"] === "application/json" ? req.body : decodeURIComponent(req.body.replace(/\+/g, " "));
      expect(text).toContain("https://sandbox.square.link/u/abc123");
    }
  });

  it("masking hides every secret header", () => {
    for (const c of cases) {
      const masked = maskRequest(c.make().buildRequest(input));
      const flat = JSON.stringify(masked.headers);
      for (const secret of ["sk_test_surge", "tb_key", Buffer.from("sms:pw").toString("base64"), "tok"]) {
        expect(flat).not.toContain(secret);
      }
    }
  });
});

describe.each(cases)("$name result mapping", (c) => {
  it("2xx maps to SENT with the provider message id", async () => {
    const f = respond(c.ok.status, c.ok.body);
    const r = await c.make(f).send(input);
    expect(r.status).toBe("SENT");
    expect(r.providerMessageId).toBe(c.ok.id);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("4xx maps to FAILED with an error code", async () => {
    const r = await c.make(respond(c.bad.status, c.bad.body)).send(input);
    expect(r.status).toBe("FAILED");
    expect(r.errorCode).toBe(c.bad.code);
  });

  it("a timeout maps to UNKNOWN and is not retried", async () => {
    const r = await c.make(timeoutFetch).send(input);
    expect(r).toMatchObject({ status: "UNKNOWN", errorCode: "timeout" });
  });

  it("a real AbortSignal timeout maps to UNKNOWN", async () => {
    // The test configs use a 1000 ms timeout.
    const r = await c.make(hangingFetch).send(input);
    expect(r.status).toBe("UNKNOWN");
  }, 5000);

  it("a network error maps to UNKNOWN", async () => {
    const f: FetchLike = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const r = await c.make(f).send(input);
    expect(r).toMatchObject({ status: "UNKNOWN", errorCode: "network_error" });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a 5xx maps to UNKNOWN", async () => {
    const r = await c.make(respond(503, { message: "busy" })).send(input);
    expect(r).toMatchObject({ status: "UNKNOWN", errorCode: "http_503" });
  });

  it("a 2xx it cannot read maps to UNKNOWN", async () => {
    const r = await c.make(respond(200, "<html>ok</html>")).send(input);
    expect(r).toMatchObject({ status: "UNKNOWN", errorCode: "ambiguous_response" });
  });

  it("a bad recipient is FAILED and nothing is sent", async () => {
    const f = respond(200, {});
    const r = await c.make(f).send({ ...input, to: "555-123-4567" });
    expect(r).toMatchObject({ status: "FAILED", errorCode: "invalid_recipient" });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("provider-specific mapping", () => {
  it("surge: a 2xx whose status is failed maps to FAILED", async () => {
    const r = await new SurgeAdapter(surgeConfig, respond(201, { id: "msg_2", status: "failed", failure_reason: "carrier_blocked" })).send(input);
    expect(r).toMatchObject({ status: "FAILED", errorCode: "carrier_blocked", providerMessageId: "msg_2" });
  });

  it("smsgate: 409 duplicate id maps to UNKNOWN, not FAILED", async () => {
    const r = await new AndroidGatewayAdapter(smsGateLocal, respond(409, { message: "exists" })).send(input);
    expect(r).toMatchObject({ status: "UNKNOWN", errorCode: "duplicate_id" });
  });

  it("textbee: success false is ambiguous and maps to UNKNOWN", async () => {
    const r = await new AndroidGatewayAdapter(textbeeConfig, respond(200, { data: { success: false } })).send(input);
    expect(r.status).toBe("UNKNOWN");
  });

  it("textbee: 429 plan limit maps to FAILED", async () => {
    const r = await new AndroidGatewayAdapter(textbeeConfig, respond(429, { message: "limit" })).send(input);
    expect(r).toMatchObject({ status: "FAILED", errorCode: "http_429" });
  });
});

describe("E.164 validation", () => {
  it.each(["+15551234567", "+447911123456", "+919876543210"])("accepts %s", (n) => {
    expect(isE164(n)).toBe(true);
  });
  it.each(["5551234567", "+1 555 123 4567", "+1-555-123-4567", "+0123456789", "", "+1555123456789012", "whatsapp:+15551234567"])(
    "rejects %j",
    (n) => {
      expect(isE164(n)).toBe(false);
      expect(() => assertE164(n)).toThrow(/E\.164/);
    },
  );
  it("buildRequest throws on a bad number", () => {
    expect(() => new SurgeAdapter(surgeConfig).buildRequest({ ...input, to: "5551234567" })).toThrow(/E\.164/);
  });
});
