import { z } from 'zod';

/** docs/API.md section 2, in table order. This is the one list (SPEC 2.9). */
export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN_BUSINESS',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'INVALID_STATE',
  'CONFLICT_UNRESOLVED',
  'APPROVAL_EXPIRED',
  'APPROVAL_ALREADY_DECIDED',
  'PAYLOAD_HASH_MISMATCH',
  'CAPABILITY_NOT_ALLOWED',
  'INTEGRATION_UNAVAILABLE',
  'ENVIRONMENT_MISMATCH',
  'SIGNATURE_INVALID',
  'RATE_LIMITED',
  'INTERNAL',
  'QUOTE_EXPIRED',
  'ITEM_UNAVAILABLE',
  'SLOT_CONFLICT',
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export type ErrorCodeInfo = { httpStatus: number; retryable: boolean };

/** HTTP status and retryable flag for each code, as in API.md section 2. */
export const ERROR_CODE_INFO: Record<ErrorCode, ErrorCodeInfo> = {
  UNAUTHENTICATED: { httpStatus: 401, retryable: false },
  FORBIDDEN_BUSINESS: { httpStatus: 403, retryable: false },
  NOT_FOUND: { httpStatus: 404, retryable: false },
  VALIDATION_FAILED: { httpStatus: 400, retryable: false },
  INVALID_STATE: { httpStatus: 409, retryable: false },
  CONFLICT_UNRESOLVED: { httpStatus: 409, retryable: false },
  APPROVAL_EXPIRED: { httpStatus: 409, retryable: false },
  APPROVAL_ALREADY_DECIDED: { httpStatus: 409, retryable: false },
  PAYLOAD_HASH_MISMATCH: { httpStatus: 409, retryable: false },
  CAPABILITY_NOT_ALLOWED: { httpStatus: 422, retryable: false },
  INTEGRATION_UNAVAILABLE: { httpStatus: 503, retryable: true },
  ENVIRONMENT_MISMATCH: { httpStatus: 503, retryable: false },
  SIGNATURE_INVALID: { httpStatus: 401, retryable: false },
  RATE_LIMITED: { httpStatus: 429, retryable: true },
  INTERNAL: { httpStatus: 500, retryable: true },
  QUOTE_EXPIRED: { httpStatus: 409, retryable: false },
  ITEM_UNAVAILABLE: { httpStatus: 409, retryable: false },
  SLOT_CONFLICT: { httpStatus: 409, retryable: false },
};

/** API.md: the codes every `/api` endpoint may return. */
export const COMMON_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN_BUSINESS',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
  'INTERNAL',
] as const satisfies readonly ErrorCode[];

/** CONTRACTS 8: the reasons a tool may fail with. A subset of `ErrorCode`. */
export const ToolFailureReasonSchema = ErrorCodeSchema.extract([
  'QUOTE_EXPIRED',
  'ITEM_UNAVAILABLE',
  'SLOT_CONFLICT',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'CAPABILITY_NOT_ALLOWED',
  'INTEGRATION_UNAVAILABLE',
]);
export type ToolFailureReason = z.infer<typeof ToolFailureReasonSchema>;

/** The body of every non-2xx `/api` response. */
export const ApiErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  correlationId: z.string().min(1),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** Builds an `ApiError` with the table's retryable flag. */
export function makeApiError(code: ErrorCode, message: string, correlationId: string, details?: Record<string, unknown>): ApiError {
  const error: ApiError = { code, message, correlationId, retryable: ERROR_CODE_INFO[code].retryable };
  if (details !== undefined) error.details = details;
  return error;
}
