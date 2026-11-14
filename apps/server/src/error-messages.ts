import type { ErrorCode } from '@abos/contracts';

/**
 * One plain sentence for each error code, for an error that has no message of its own (issue #127).
 * The web app shows the message to the shop owner, so it never names the code. A code added to the
 * contract fails typecheck here until it has a sentence.
 */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  UNAUTHENTICATED: 'You are signed out. Sign in and try again.',
  FORBIDDEN_BUSINESS: 'Your account does not have access to this business.',
  NOT_FOUND: 'This could not be found. It may have been removed.',
  VALIDATION_FAILED: 'Some details are missing or not valid. Check them and try again.',
  INVALID_STATE: 'This can no longer be done, because its state changed.',
  CONFLICT_UNRESOLVED: 'Two sources disagree about this. Choose which value to keep first.',
  APPROVAL_EXPIRED: 'This request expired before it was decided.',
  APPROVAL_ALREADY_DECIDED: 'This request was already decided.',
  PAYLOAD_HASH_MISMATCH: 'The details changed after you opened this. Reload it and review it again.',
  CAPABILITY_NOT_ALLOWED: 'This action is not allowed here.',
  INTEGRATION_UNAVAILABLE: 'A connected service is not answering right now. Try again in a moment.',
  ENVIRONMENT_MISMATCH: 'This was set up for a different payment environment, so it cannot run here.',
  SIGNATURE_INVALID: 'This request could not be verified.',
  RATE_LIMITED: 'There were too many requests. Wait a moment and try again.',
  INTERNAL: 'Something went wrong on our side. Try again in a moment.',
  QUOTE_EXPIRED: 'The quote expired. Ask for a new one.',
  ITEM_UNAVAILABLE: 'An item is not available right now.',
  SLOT_CONFLICT: 'That time is already taken. Choose another time.',
};

export function errorMessage(code: ErrorCode): string {
  return ERROR_MESSAGES[code];
}
