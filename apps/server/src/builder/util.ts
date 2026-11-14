import { createHash, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { AppError } from '../errors';
import type { ErrorCode } from './pending-contracts';

// Small helpers shared by the builder routes and services.

export function newId(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN_BUSINESS: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  INVALID_STATE: 409,
  CONFLICT_UNRESOLVED: 409,
  APPROVAL_EXPIRED: 409,
  APPROVAL_ALREADY_DECIDED: 409,
  PAYLOAD_HASH_MISMATCH: 409,
  CAPABILITY_NOT_ALLOWED: 422,
  INTEGRATION_UNAVAILABLE: 503,
  ENVIRONMENT_MISMATCH: 503,
  SIGNATURE_INVALID: 401,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  QUOTE_EXPIRED: 409,
  ITEM_UNAVAILABLE: 409,
  SLOT_CONFLICT: 409,
};
const RETRYABLE = new Set<ErrorCode>(['INTEGRATION_UNAVAILABLE', 'RATE_LIMITED', 'INTERNAL']);

// An AppError with the HTTP status and retry flag that API.md section 2 gives the code.
export function apiError(code: ErrorCode, message: string, details?: Record<string, unknown>): AppError {
  return new AppError(code, message, STATUS[code], RETRYABLE.has(code), details);
}

export function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw apiError('VALIDATION_FAILED', 'The request did not pass validation.', {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

// Canonical JSON (CONTRACTS.md section 4): keys sorted by code point at every
// depth, no whitespace, arrays in order, undefined fields omitted.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
