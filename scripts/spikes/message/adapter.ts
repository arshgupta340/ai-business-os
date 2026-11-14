// The channel-agnostic message interface (SPEC D-08). Task B-14 can lift this
// file into the server as is.
//
// Status meanings, following the Message dispatch states in SPEC 2.4:
// - SENT: the provider accepted the message. It is not a delivery receipt.
//   DELIVERED is set later from a provider callback, never by send().
// - FAILED: the provider clearly refused the message (a 4xx, or a body that
//   says failed). Nothing was sent.
// - UNKNOWN: a timeout, a network error, a 5xx or an ambiguous response. The
//   message may or may not have gone out. An UNKNOWN send goes to review. It is
//   never retried automatically, because a retry could text the customer twice.
// QUEUED is the dispatch row's state before send() is called, so send() never
// returns it.

export type MessageChannel = "surge" | "android_gateway" | "whatsapp_sandbox";

export type SendStatus = "SENT" | "FAILED" | "UNKNOWN";

export interface SendInput {
  /** Recipient in E.164 form, for example +15551234567. */
  to: string;
  body: string;
  /** Stable key for this send. Never regenerated after a timeout. */
  idempotencyKey: string;
}

export interface SendResult {
  status: SendStatus;
  providerMessageId?: string;
  /** Provider-specific code, for example "demo_message_limit" or "http_401". B-14 maps it to ErrorCode. */
  errorCode?: string;
  /** The parsed provider response, for debugging. Never contains our secrets. */
  raw?: unknown;
}

export interface MessageAdapter {
  readonly channel: MessageChannel;
  send(input: SendInput): Promise<SendResult>;
}

/** A plain description of the one HTTP request an adapter makes. Used by --dry-run and the tests. */
export interface HttpRequest {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Spike-only extension: lets the CLI print the request without sending it. */
export interface InspectableAdapter extends MessageAdapter {
  buildRequest(input: SendInput): HttpRequest;
}

const E164 = /^\+[1-9]\d{6,14}$/;

export function isE164(value: string): boolean {
  return E164.test(value);
}

export class InvalidRecipientError extends Error {
  constructor(value: string) {
    super(`Recipient is not in E.164 form (a plus sign, country code and number, no spaces): ${maskPhone(value)}`);
    this.name = "InvalidRecipientError";
  }
}

export function assertE164(value: string): void {
  if (!isE164(value)) throw new InvalidRecipientError(value);
}

/** Last four digits only, for logs. */
export function last4(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.slice(-4);
}

function maskPhone(value: string): string {
  const d = last4(value);
  return d ? `...${d}` : "(empty)";
}
