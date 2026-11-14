// Surge (surge.app) adapter.
//
// Confirmed 2026-11-13 from https://docs.surge.app/quickstart and
// https://docs.surge.app/api-reference/endpoint/messages/create.md:
// - POST https://api.surge.app/accounts/{account_id}/messages
// - Authorization: Bearer <API key>
// - Body (simple form): { to (E.164), body, from?, metadata?, settings? }.
//   No from is needed: a new account sends from its demo number.
// - settings.link_shortening is "enabled" or "disabled".
// - metadata: up to 50 string pairs, each value up to 500 characters.
// - 201 returns a Message with id (msg_...) and status
//   (pending, received, sent, delivered, failed) and failure_reason.
// - Errors: { error: { type, message, detail? } }. The demo cap returns 403
//   with type demo_message_limit. The cap is 25 outbound messages per account.
// - No idempotency header or field is documented, so the key goes into
//   metadata for tracing only. The local send log is what prevents a resend.

import { assertE164, isE164, type HttpRequest, type InspectableAdapter, type SendInput, type SendResult } from "./adapter.ts";
import type { SurgeConfig } from "./env.ts";
import { execute, isObject, mapOutcome, nonEmptyString, type FetchLike } from "./http.ts";

/** The demo number cap, from the Surge quickstart. */
export const SURGE_DEMO_MESSAGE_LIMIT = 25;

export class SurgeAdapter implements InspectableAdapter {
  readonly channel = "surge" as const;

  constructor(
    private readonly config: SurgeConfig,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
  ) {}

  buildRequest(input: SendInput): HttpRequest {
    assertE164(input.to);
    const payload: Record<string, unknown> = {
      to: input.to,
      body: input.body,
      metadata: { idempotency_key: input.idempotencyKey.slice(0, 500) },
    };
    if (this.config.linkShortening !== "omit") payload.settings = { link_shortening: this.config.linkShortening };
    return {
      method: "POST",
      url: `${this.config.baseUrl}/accounts/${encodeURIComponent(this.config.accountId)}/messages`,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    };
  }

  async send(input: SendInput): Promise<SendResult> {
    if (!isE164(input.to)) return { status: "FAILED", errorCode: "invalid_recipient" };
    const outcome = await execute(this.buildRequest(input), this.fetchImpl, this.config.timeoutMs);
    return mapOutcome(outcome, {
      success(json) {
        if (!isObject(json)) return undefined;
        const id = nonEmptyString(json.id);
        if (!id) return undefined;
        if (json.status === "failed") {
          return { status: "FAILED", providerMessageId: id, errorCode: nonEmptyString(json.failure_reason) ?? "failed" };
        }
        return { status: "SENT", providerMessageId: id };
      },
      errorCode(json) {
        if (isObject(json) && isObject(json.error)) return nonEmptyString(json.error.type);
        return undefined;
      },
    });
  }
}
