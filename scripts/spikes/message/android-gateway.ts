// Android phone as the SMS sender. Two kinds, picked by ANDROID_GATEWAY_KIND.
//
// textbee, confirmed 2026-11-13 from https://textbee.dev/docs/sending-sms/sending-sms
// and https://textbee.dev/docs/api-reference:
// - POST https://api.textbee.dev/api/v1/gateway/send-sms
// - Header x-api-key: <API key>
// - Body { recipients: string[], message: string, deviceId?: string }
//   (deviceId is the device's _id from GET /gateway/devices; optional, the
//   default device is used without it)
// - 200 returns { data: { success, message, smsBatchId, recipientCount } }
// - 400 no enabled device / bad device id, 401 bad key, 404 device not found,
//   429 plan limit reached (nothing sent)
// - No idempotency field is documented.
//
// SMSGate (github.com/capcom6/android-sms-gateway), confirmed 2026-11-13 from
// https://docs.sms-gate.app/getting-started/local-server/,
// https://docs.sms-gate.app/getting-started/public-cloud-server/,
// https://docs.sms-gate.app/features/sending-messages/ and the OpenAPI file
// https://capcom6.github.io/android-sms-gateway/swagger.json:
// - Local:  POST http://<phone-ip>:8080/message
// - Cloud:  POST https://api.sms-gate.app/3rdparty/v1/messages
// - HTTP Basic auth with the username and password shown in the app
// - Body { id?, textMessage: { text }, phoneNumbers: string[], deviceId? }
//   id is at most 36 characters; a repeated id returns 409
//   "Message with the same ID already exists"
// - 202 "Message enqueued" returns { id, state, recipients, ... };
//   state is Pending, Processed, Sent, Delivered, Failed and so on
// - 503 "Queue limits exceeded; ensure device is online"

import { assertE164, isE164, type HttpRequest, type InspectableAdapter, type SendInput, type SendResult } from "./adapter.ts";
import type { AndroidGatewayConfig, SmsGateConfig, TextbeeConfig } from "./env.ts";
import { execute, isObject, mapOutcome, nonEmptyString, type FetchLike, type ResponseParsers } from "./http.ts";

// ---------------------------------------------------------------------------
// NOT VERIFIED WITHOUT KEYS. Isolated here so a real run can correct them.
// ---------------------------------------------------------------------------
/** SMSGate local path. The local-server guide uses /message; the OpenAPI file lists /messages for both. */
export const SMSGATE_LOCAL_PATH = "/message";
/** SMSGate cloud path, appended to https://api.sms-gate.app/3rdparty/v1. */
export const SMSGATE_CLOUD_PATH = "/messages";
/** SMSGate caps the client message id at 36 characters (OpenAPI maxLength). */
export const SMSGATE_MAX_ID_LENGTH = 36;
// ---------------------------------------------------------------------------

export function smsGatePath(baseUrl: string): string {
  return /\/3rdparty\/v1$/.test(baseUrl) ? SMSGATE_CLOUD_PATH : SMSGATE_LOCAL_PATH;
}

function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
}

export class AndroidGatewayAdapter implements InspectableAdapter {
  readonly channel = "android_gateway" as const;

  constructor(
    private readonly config: AndroidGatewayConfig,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
  ) {}

  get kind(): AndroidGatewayConfig["kind"] {
    return this.config.kind;
  }

  buildRequest(input: SendInput): HttpRequest {
    assertE164(input.to);
    return this.config.kind === "textbee" ? textbeeRequest(this.config, input) : smsGateRequest(this.config, input);
  }

  async send(input: SendInput): Promise<SendResult> {
    if (!isE164(input.to)) return { status: "FAILED", errorCode: "invalid_recipient" };
    const outcome = await execute(this.buildRequest(input), this.fetchImpl, this.config.timeoutMs);
    return mapOutcome(outcome, this.config.kind === "textbee" ? textbeeParsers : smsGateParsers);
  }
}

function textbeeRequest(config: TextbeeConfig, input: SendInput): HttpRequest {
  const payload: Record<string, unknown> = { recipients: [input.to], message: input.body };
  if (config.deviceId) payload.deviceId = config.deviceId;
  return {
    method: "POST",
    url: `${config.baseUrl}/gateway/send-sms`,
    headers: { "x-api-key": config.apiKey, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  };
}

const textbeeParsers: ResponseParsers = {
  success(json) {
    if (!isObject(json) || !isObject(json.data)) return undefined;
    const batchId = nonEmptyString(json.data.smsBatchId);
    // success: true with a batch id means the phone was told to send. Anything else is ambiguous.
    if (json.data.success === true && batchId) return { status: "SENT", providerMessageId: batchId };
    return undefined;
  },
};

function smsGateRequest(config: SmsGateConfig, input: SendInput): HttpRequest {
  const payload: Record<string, unknown> = {
    id: input.idempotencyKey.slice(0, SMSGATE_MAX_ID_LENGTH),
    textMessage: { text: input.body },
    phoneNumbers: [input.to],
  };
  if (config.deviceId) payload.deviceId = config.deviceId;
  return {
    method: "POST",
    url: `${config.baseUrl}${smsGatePath(config.baseUrl)}`,
    headers: {
      Authorization: basicAuth(config.username, config.password),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  };
}

const smsGateParsers: ResponseParsers = {
  success(json) {
    if (!isObject(json)) return undefined;
    const id = nonEmptyString(json.id);
    if (!id) return undefined;
    if (json.state === "Failed") return { status: "FAILED", providerMessageId: id, errorCode: "failed" };
    return { status: "SENT", providerMessageId: id };
  },
  errorCode(_json, status) {
    // 409 means a message with this id already exists: it was probably sent before. mapOutcome makes it UNKNOWN.
    return status === 409 ? "duplicate_id" : undefined;
  },
};
