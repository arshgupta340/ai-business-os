/**
 * One owner-facing sentence per error code, and the text to show for a failed
 * request.
 *
 * Rule: the owner never reads an error code or the message the server sent.
 * A server message is written for whoever reads the API and can carry a code
 * or a field name, for example "Operation failed: INVALID_STATE.". It can go
 * in a detail for support, next to the correlation ID, never in the main text.
 *
 * ERROR_TEXT is typed on the contract, so a new error code fails the
 * typecheck, and error-text.test.ts fails as well. Screens may keep their own
 * sentence for a code they handle in a special way. For every other code they
 * must use errorText and must not keep their own map.
 */

import type {ErrorCode} from '@abos/contracts';

/** Short and calm. Each says what the owner can do when there is something to do. */
export const ERROR_TEXT: Record<ErrorCode, string> = {
  UNAUTHENTICATED: 'You are signed out. Sign in again to continue.',
  FORBIDDEN_BUSINESS: 'You do not have access to this business.',
  NOT_FOUND: 'We could not find this in your business. It may have been removed.',
  VALIDATION_FAILED: 'Some details are missing or not valid. Check them and try again.',
  INVALID_STATE: 'This has changed since the page loaded, so it cannot be done now. Refresh to see where it stands.',
  CONFLICT_UNRESOLVED: 'Some business facts disagree. Resolve them first, then try again.',
  APPROVAL_EXPIRED: 'This request expired before it was approved. Nothing was done.',
  APPROVAL_ALREADY_DECIDED: 'This request was already approved or rejected. Refresh to see the decision.',
  PAYLOAD_HASH_MISMATCH: 'This request changed after you opened it, so nothing was done. Review it again before you decide.',
  CAPABILITY_NOT_ALLOWED: 'Your agent is not allowed to do this.',
  INTEGRATION_UNAVAILABLE: 'A connected service is not responding. Try again in a few minutes.',
  ENVIRONMENT_MISMATCH: 'Payments are not set up for the sandbox, so nothing was charged. Ask the person who runs the server to check its settings.',
  SIGNATURE_INVALID: 'A message from a connected service could not be verified, so it was ignored. Nothing changed.',
  RATE_LIMITED: 'Too many requests at once. Wait a moment and try again.',
  INTERNAL: 'Something went wrong on our side. Try again.',
  QUOTE_EXPIRED: 'The price quote expired. A new quote is needed.',
  ITEM_UNAVAILABLE: 'An item in the order is not available.',
  SLOT_CONFLICT: 'That time is no longer free.',
};

/** The text for an error with no code, or with a code this app does not know. */
export const GENERIC_ERROR_TEXT = 'Something went wrong. Try again.';

/** The text when the request never got an answer (ApiError kind "network"). */
export const NETWORK_ERROR_TEXT = 'Could not reach the server. Check the connection and try again.';

/** Anything shaped like ApiError from lib/api/errors.ts. Every field is optional, as an untyped error may lack it. */
export type ErrorLike = {code?: unknown; message?: unknown; kind?: unknown};

/** The sentence for a code. A code this app does not know, or no code, reads GENERIC_ERROR_TEXT. */
export function errorCodeText(code: unknown): string {
  if (typeof code !== 'string' || !Object.hasOwn(ERROR_TEXT, code)) return GENERIC_ERROR_TEXT;
  return ERROR_TEXT[code as ErrorCode];
}

/**
 * The text to show for a failed request: the sentence for its code, or a
 * generic sentence. A network failure says the server could not be reached.
 * The server message is never returned.
 */
export function errorText(error: unknown): string {
  if (!error || typeof error !== 'object') return GENERIC_ERROR_TEXT;
  const {code, kind} = error as ErrorLike;
  if (kind === 'network') return NETWORK_ERROR_TEXT;
  return errorCodeText(code);
}
