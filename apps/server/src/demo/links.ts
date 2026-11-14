// D-13 demo links: unguessable and stateless. A token is `<orderId>.<hmac>`, the HMAC-SHA256 of the order ID
// with DEMO_LINK_SECRET, compared in constant time. A bad or missing signature is answered 404 by the routes.
import { createHmac, timingSafeEqual } from 'node:crypto';

// The full 32-byte HMAC in base64url (43 characters), so a token fits Fastify's 100-character path parameter.
const TOKEN = /^(ord_[A-Za-z0-9_]{1,52})\.([A-Za-z0-9_-]{43})$/;

function mac(orderId: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(orderId).digest();
}

export function signOrderToken(orderId: string, secret: string): string {
  return `${orderId}.${mac(orderId, secret).toString('base64url')}`;
}

/** The order ID of a well-formed token with a valid signature, or undefined. */
export function verifyOrderToken(token: unknown, secret: string): string | undefined {
  if (typeof token !== 'string') return undefined;
  const m = TOKEN.exec(token);
  if (!m) return undefined;
  // Compared as the canonical text, so no other spelling of the same bytes is accepted.
  const expected = Buffer.from(mac(m[1]!, secret).toString('base64url'));
  const given = Buffer.from(m[2]!);
  return given.length === expected.length && timingSafeEqual(given, expected) ? m[1] : undefined;
}

export function payLink(publicUrl: string, orderId: string, secret: string): string {
  return `${publicUrl}/demo/pay/${signOrderToken(orderId, secret)}`;
}

export function trackLink(publicUrl: string, orderId: string, secret: string): string {
  return `${publicUrl}/demo/track/${signOrderToken(orderId, secret)}`;
}
