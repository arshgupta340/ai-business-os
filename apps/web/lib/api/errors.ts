import { ApiErrorSchema, ErrorCodeSchema, type ErrorCode } from "./pending-contracts";

/** HTTP status and retryable flag for each code, from docs/API.md section 2. */
export const ERROR_CODE_INFO: Record<ErrorCode, { status: number; retryable: boolean }> = {
  UNAUTHENTICATED: { status: 401, retryable: false },
  FORBIDDEN_BUSINESS: { status: 403, retryable: false },
  NOT_FOUND: { status: 404, retryable: false },
  VALIDATION_FAILED: { status: 400, retryable: false },
  INVALID_STATE: { status: 409, retryable: false },
  CONFLICT_UNRESOLVED: { status: 409, retryable: false },
  APPROVAL_EXPIRED: { status: 409, retryable: false },
  APPROVAL_ALREADY_DECIDED: { status: 409, retryable: false },
  PAYLOAD_HASH_MISMATCH: { status: 409, retryable: false },
  CAPABILITY_NOT_ALLOWED: { status: 422, retryable: false },
  INTEGRATION_UNAVAILABLE: { status: 503, retryable: true },
  ENVIRONMENT_MISMATCH: { status: 503, retryable: false },
  SIGNATURE_INVALID: { status: 401, retryable: false },
  RATE_LIMITED: { status: 429, retryable: true },
  INTERNAL: { status: 500, retryable: true },
  QUOTE_EXPIRED: { status: 409, retryable: false },
  ITEM_UNAVAILABLE: { status: 409, retryable: false },
  SLOT_CONFLICT: { status: 409, retryable: false },
};

/**
 * Where the failure came from.
 * - "http": the server answered with an error envelope (or at least an error status).
 * - "network": the request never got an answer (offline, DNS, CORS, abort). Show "retry".
 * - "invalid_response": the server answered 2xx but the body did not match the contract.
 */
export type ApiErrorKind = "http" | "network" | "invalid_response";

/**
 * Every failed call from the client throws this. `code` is always a value of
 * ErrorCode from docs/API.md section 2. A network failure uses INTERNAL with
 * kind "network" and retryable true, so the UI can offer a retry without a
 * code that the server does not define.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly correlationId?: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  readonly kind: ApiErrorKind;

  constructor(init: {
    code: ErrorCode;
    message: string;
    status: number;
    correlationId?: string;
    retryable: boolean;
    details?: Record<string, unknown>;
    kind: ApiErrorKind;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.code = init.code;
    this.status = init.status;
    this.correlationId = init.correlationId;
    this.retryable = init.retryable;
    this.details = init.details;
    this.kind = init.kind;
  }

  /** True when showing a "Try again" button makes sense. */
  get canRetry(): boolean {
    return this.retryable;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

function codeFromStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return "VALIDATION_FAILED";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "FORBIDDEN_BUSINESS";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "INVALID_STATE";
    case 422:
      return "CAPABILITY_NOT_ALLOWED";
    case 429:
      return "RATE_LIMITED";
    case 503:
      return "INTEGRATION_UNAVAILABLE";
    default:
      return "INTERNAL";
  }
}

/** Build an ApiError from a non-2xx response body and headers. */
export function errorFromResponse(status: number, body: unknown, headerCorrelationId: string | null): ApiError {
  const parsed = ApiErrorSchema.safeParse(body);
  if (parsed.success) {
    return new ApiError({
      code: parsed.data.code,
      message: parsed.data.message,
      status,
      correlationId: headerCorrelationId ?? parsed.data.correlationId,
      retryable: parsed.data.retryable,
      details: parsed.data.details,
      kind: "http",
    });
  }
  // The body was not a valid envelope. Keep a known code if one is present.
  const maybeCode =
    body && typeof body === "object" && "code" in body ? ErrorCodeSchema.safeParse((body as { code: unknown }).code) : null;
  const code = maybeCode?.success ? maybeCode.data : codeFromStatus(status);
  return new ApiError({
    code,
    message: `The server answered with status ${status}.`,
    status,
    correlationId: headerCorrelationId ?? undefined,
    retryable: ERROR_CODE_INFO[code].retryable,
    kind: "http",
  });
}

export function networkError(cause: unknown): ApiError {
  const err = new ApiError({
    code: "INTERNAL",
    message: "Could not reach the server. Check the connection and try again.",
    status: 0,
    retryable: true,
    kind: "network",
  });
  (err as { cause?: unknown }).cause = cause;
  return err;
}

export function invalidResponseError(path: string, status: number, correlationId: string | null, issues: unknown): ApiError {
  return new ApiError({
    code: "INTERNAL",
    message: `The server response for ${path} did not match the contract.`,
    status,
    correlationId: correlationId ?? undefined,
    retryable: false,
    details: { issues },
    kind: "invalid_response",
  });
}
