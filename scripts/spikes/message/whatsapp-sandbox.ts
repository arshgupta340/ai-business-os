// Twilio WhatsApp sandbox adapter, using fetch (no twilio package).
//
// Confirmed 2026-11-13:
// - https://www.twilio.com/docs/whatsapp/sandbox: sandbox number +14155238886;
//   each recipient sends "join <your sandbox code>" first; "The Sandbox
//   session expires three days after joining"; free-form text is allowed
//   inside the 24-hour window that opens when the user messages the sandbox.
// - https://www.twilio.com/docs/whatsapp/quickstart: From and To both carry
//   the whatsapp: prefix, for example From=whatsapp:+14155238886.
// - https://www.twilio.com/docs/messaging/api/message-resource:
//   POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json,
//   form encoded, parameters To, From, Body; the response has sid and status.
// - https://www.twilio.com/docs/usage/requests-to-twilio: HTTP Basic auth with
//   the Account SID as username and the Auth Token as password.
// Not confirmed: the error body shape { code, message, more_info, status }.
// No idempotency parameter is documented for creating a message.

import { assertE164, isE164, type HttpRequest, type InspectableAdapter, type SendInput, type SendResult } from "./adapter.ts";
import type { WhatsAppSandboxConfig } from "./env.ts";
import { execute, isObject, mapOutcome, nonEmptyString, type FetchLike } from "./http.ts";

export const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";
export const TWILIO_WHATSAPP_SANDBOX_NUMBER = "+14155238886";

export class WhatsAppSandboxAdapter implements InspectableAdapter {
  readonly channel = "whatsapp_sandbox" as const;

  constructor(
    private readonly config: WhatsAppSandboxConfig,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
  ) {}

  buildRequest(input: SendInput): HttpRequest {
    assertE164(input.to);
    const form = new URLSearchParams({ To: `whatsapp:${input.to}`, From: this.config.from, Body: input.body });
    const auth = Buffer.from(`${this.config.accountSid}:${this.config.authToken}`, "utf8").toString("base64");
    return {
      method: "POST",
      url: `${TWILIO_API_BASE}/Accounts/${this.config.accountSid}/Messages.json`,
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
    };
  }

  async send(input: SendInput): Promise<SendResult> {
    if (!isE164(input.to)) return { status: "FAILED", errorCode: "invalid_recipient" };
    const outcome = await execute(this.buildRequest(input), this.fetchImpl, this.config.timeoutMs);
    return mapOutcome(outcome, {
      success(json) {
        if (!isObject(json)) return undefined;
        const sid = nonEmptyString(json.sid);
        if (!sid) return undefined;
        if (json.status === "failed" || json.status === "undelivered") {
          const code = json.error_code;
          return { status: "FAILED", providerMessageId: sid, errorCode: code != null ? `twilio_${code}` : String(json.status) };
        }
        return { status: "SENT", providerMessageId: sid };
      },
      errorCode(json) {
        if (isObject(json) && (typeof json.code === "number" || typeof json.code === "string")) return `twilio_${json.code}`;
        return undefined;
      },
    });
  }
}
