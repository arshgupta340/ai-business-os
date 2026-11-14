import { randomUUID } from 'node:crypto';
import { ERROR_CODE_INFO, type ErrorCode } from '@abos/contracts';
import type { z } from 'zod';
import { AppError } from '../errors';

// Small helpers shared by the builder routes and services.

// Canonical JSON (CONTRACTS.md section 4), from the package.
export { canonicalJson } from '@abos/contracts';

export function newId(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

// An AppError with the HTTP status and retry flag that API.md section 2 gives
// the code (the package's ERROR_CODE_INFO table).
export function apiError(code: ErrorCode, message: string, details?: Record<string, unknown>): AppError {
  const info = ERROR_CODE_INFO[code];
  return new AppError(code, message, info.httpStatus, info.retryable, details);
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
