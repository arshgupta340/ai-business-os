// AgentPhone webhook signature (D-12). From the vendor's documentation, not tested against a live delivery:
// https://docs.agentphone.ai/documentation/guides/webhooks.md ("Headers and signatures")
//   X-Webhook-Signature: sha256=<hex>, HMAC-SHA256 with the webhook secret over `${X-Webhook-Timestamp}.` + raw body
//   X-Webhook-Timestamp: Unix seconds; reject a delivery more than 5 minutes from now
//   X-Webhook-ID: unique delivery ID, kept across retries (the dedupe key)
// The raw bytes are verified before any JSON parsing, and the compare is constant time.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const AGENTPHONE_HEADERS = {
  signature: 'x-webhook-signature',
  timestamp: 'x-webhook-timestamp',
  id: 'x-webhook-id',
  event: 'x-webhook-event',
} as const;

/** The documented replay window. */
export const AGENTPHONE_MAX_SKEW_SECONDS = 300;
/** X-Webhook-ID is stored as webhook_events.provider_event_id; anything else is refused. */
const DELIVERY_ID = /^[A-Za-z0-9._:-]{1,200}$/;

/**
 * The signature covers the timestamp and the body, not X-Webhook-ID. So the ID alone cannot be the dedupe
 * key: the same signed bytes sent again with another ID would verify and look new. `replayKey` names the
 * signed content itself. It is a digest of the verified signature (keyed by the webhook secret), so it
 * reveals nothing about the body, and its `signature/` prefix cannot collide with a delivery ID (no `/`).
 */
export type SignatureCheck =
  | { ok: true; deliveryId: string; replayKey: string }
  | { ok: false; reason: 'missing' | 'stale' | 'mismatch' };

export function agentPhoneSignature(secret: string, timestamp: string, rawBody: Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex')}`;
}

/** Never throws. A missing secret verifies nothing. */
export function verifyAgentPhoneSignature(input: {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  secret: string | undefined;
  nowMs: number;
}): SignatureCheck {
  const header = (name: string) => { const v = input.headers[name]; return typeof v === 'string' ? v : undefined; };
  const signature = header(AGENTPHONE_HEADERS.signature);
  const timestamp = header(AGENTPHONE_HEADERS.timestamp);
  const deliveryId = header(AGENTPHONE_HEADERS.id);
  if (!input.secret || !signature || !timestamp || !deliveryId || !DELIVERY_ID.test(deliveryId)) return { ok: false, reason: 'missing' };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: 'missing' };
  if (Math.abs(input.nowMs / 1000 - Number(timestamp)) > AGENTPHONE_MAX_SKEW_SECONDS) return { ok: false, reason: 'stale' };
  const expected = Buffer.from(agentPhoneSignature(input.secret, timestamp, input.rawBody), 'utf8');
  const given = Buffer.from(signature.trim(), 'utf8');
  // timingSafeEqual needs equal lengths; comparing against itself keeps the work the same either way.
  const same = given.length === expected.length ? timingSafeEqual(given, expected) : (timingSafeEqual(expected, expected), false);
  if (!same) return { ok: false, reason: 'mismatch' };
  return { ok: true, deliveryId, replayKey: `signature/${createHash('sha256').update(expected).digest('hex')}` };
}
