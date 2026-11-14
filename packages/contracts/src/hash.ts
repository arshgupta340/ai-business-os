// SPEC 2.9 and CONTRACTS 4 and 5: canonical JSON, payload hash, cart hash and idempotency key.
// Uses the Web Crypto API (globalThis.crypto.subtle, async), not node:crypto, so the server and the
// browser compute byte-identical hashes. Node 20+ and every current browser provide it.
import type { ActionType, BundleType } from './enums';
import type { Cart } from './schemas/catalog';
import {
  BookingApprovalPayloadSchema,
  FactEditApprovalPayloadSchema,
  OrderApprovalPayloadSchema,
  PriceEditApprovalPayloadSchema,
  type ApprovalPayload,
  type BookingApprovalPayload,
  type FactEditApprovalPayload,
  type OrderApprovalPayload,
  type PriceEditApprovalPayload,
} from './schemas/approvals';

/** Compares by Unicode code point, as CONTRACTS 4 requires (plain `sort()` compares UTF-16 code units). */
function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done || y.done) return x.done === y.done ? 0 : x.done ? -1 : 1;
    const cx = x.value.codePointAt(0) ?? 0;
    const cy = y.value.codePointAt(0) ?? 0;
    if (cx !== cy) return cx - cy;
  }
}

/**
 * Canonical JSON: keys sorted by code point at every depth, no whitespace, arrays kept in order,
 * absent (undefined) fields omitted. Throws on values JSON cannot represent exactly.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort(compareCodePoints);
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}

/** Lowercase hex SHA-256 of the UTF-8 bytes of `text`. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let hex = '';
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** `"sha256:" + hex(sha256(canonicalJson(value)))`. */
export async function hashCanonical(value: unknown): Promise<string> {
  return `sha256:${await sha256Hex(canonicalJson(value))}`;
}

/** SPEC 2.9 payload hash. Pass the payload exactly as stored (material fields only; see `pickMaterialFields`). */
export async function payloadHash(payload: ApprovalPayload, explicitBundleType?: BundleType): Promise<string> {
  if (explicitBundleType !== undefined) return hashCanonical(PAYLOAD_SCHEMAS[explicitBundleType].parse(payload));
  const bundleType = 'cartHash' in payload ? 'order_bundle' : 'serviceId' in payload ? 'booking_bundle' : 'squareItemId' in payload ? 'price_edit' : 'fact_edit';
  return approvalPayloadHash(bundleType, payload);
}

/**
 * CONTRACTS 4 cart normalization: `modifierIds` sorted inside each line, then lines sorted by
 * `variationId`, then by the joined `modifierIds` (joined with ","), then by `note` (absent sorts as "").
 */
export function normalizeCart(cart: Cart): Cart {
  const lines = cart.lines.map((line) => ({ ...line, modifierIds: [...line.modifierIds].sort(compareCodePoints) }));
  lines.sort(
    (a, b) =>
      compareCodePoints(a.variationId, b.variationId) ||
      compareCodePoints(a.modifierIds.join(','), b.modifierIds.join(',')) ||
      compareCodePoints(a.note ?? '', b.note ?? ''),
  );
  return { lines };
}

export async function cartHash(cart: Cart): Promise<string> {
  return hashCanonical(normalizeCart(cart));
}

export type IdempotencyKeyParts = { businessId: string; subjectId: string; actionType: ActionType; approvalId: string };

/** SPEC 2.9: `hex(sha256(businessId:subjectId:actionType:approvalId))`, 64 lowercase hex characters, no prefix. */
export async function idempotencyKey(parts: IdempotencyKeyParts): Promise<string> {
  return sha256Hex([parts.businessId, parts.subjectId, parts.actionType, parts.approvalId].join(':'));
}

/** CONTRACTS 4: the hashed material fields of each bundle type, in the table's order. */
export const MATERIAL_FIELDS = {
  order_bundle: ['businessId', 'subjectId', 'agentVersionId', 'cartHash', 'totalMinor', 'currency', 'pickupAt', 'messageRecipient', 'messageChannel', 'actionBundle', 'expiresAt'],
  booking_bundle: ['businessId', 'subjectId', 'agentVersionId', 'serviceId', 'calendarId', 'startUtc', 'endUtc', 'timezone', 'messageRecipient', 'messageChannel', 'actionBundle', 'expiresAt'],
  fact_edit: ['businessId', 'subjectId', 'kind', 'key', 'fromVersion', 'before', 'after', 'actionBundle', 'expiresAt'],
  price_edit: ['businessId', 'subjectId', 'squareItemId', 'variationId', 'fromPriceMinor', 'newPriceMinor', 'currency', 'squareVersion', 'actionBundle', 'expiresAt'],
} as const satisfies { order_bundle: readonly (keyof OrderApprovalPayload)[]; booking_bundle: readonly (keyof BookingApprovalPayload)[]; fact_edit: readonly (keyof FactEditApprovalPayload)[]; price_edit: readonly (keyof PriceEditApprovalPayload)[] };

const PAYLOAD_SCHEMAS = {
  order_bundle: OrderApprovalPayloadSchema,
  booking_bundle: BookingApprovalPayloadSchema,
  fact_edit: FactEditApprovalPayloadSchema,
  price_edit: PriceEditApprovalPayloadSchema,
} as const;

export type PayloadFor<B extends BundleType> = {
  order_bundle: OrderApprovalPayload;
  booking_bundle: BookingApprovalPayload;
  fact_edit: FactEditApprovalPayload;
  price_edit: PriceEditApprovalPayload;
}[B];

/**
 * Picks exactly the material fields of `bundleType` from a wider object (for example a payload plus
 * `callId`, or rows joined by the executor) and validates them with the strict payload schema. The
 * result is a valid stored payload: for a stored payload `p`, `pickMaterialFields(bundleType, p)`
 * deep-equals `p`. Throws a ZodError if a field is missing or malformed.
 */
export function pickMaterialFields<B extends BundleType>(bundleType: B, source: Record<string, unknown>): PayloadFor<B> {
  const picked: Record<string, unknown> = {};
  for (const field of MATERIAL_FIELDS[bundleType]) {
    if (source[field] !== undefined) picked[field] = source[field];
  }
  return PAYLOAD_SCHEMAS[bundleType].parse(picked) as PayloadFor<B>;
}

/** Hash of the material fields of `source` for `bundleType`. For a stored payload this is `sha256(canonicalJson(payload))`. */
export async function approvalPayloadHash(bundleType: BundleType, source: Record<string, unknown>): Promise<string> {
  return hashCanonical(pickMaterialFields(bundleType, source));
}

/** Recomputes the hash and compares it with the stored one (the executor runs this before every step). */
export async function verifyPayloadHash(bundleType: BundleType, source: Record<string, unknown>, expected: string): Promise<boolean> {
  return (await approvalPayloadHash(bundleType, source)) === expected;
}
