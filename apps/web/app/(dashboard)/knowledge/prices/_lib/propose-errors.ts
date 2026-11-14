/**
 * Owner-facing text for each documented error of
 * POST /api/businesses/:id/catalog/prices/propose (API.md 3.1), plus the
 * errors every screen handles (screen data map, rule 9). Any other code reads
 * the shared sentence from errorText. The server message is never shown.
 */
import {isApiError} from '@/lib/api';
import {errorCodeText, errorText} from '@/lib/error-text';
import {providerLabel} from '@/lib/labels';

export type ProposeErrorView = {
  title: string;
  message: string;
  /** A message to show under the price field instead of in the banner. */
  fieldMessage?: string;
  retryable: boolean;
  correlationId?: string;
};

/**
 * True for the server's not-found handler (an unregistered route), which also
 * answers NOT_FOUND, with a message that starts "No route for".
 */
export function isMissingRoute(error: unknown): boolean {
  return isApiError(error) && error.code === 'NOT_FOUND' && error.message.startsWith('No route for');
}

export function proposeErrorView(error: unknown): ProposeErrorView {
  if (!isApiError(error)) {
    return {title: 'The change was not proposed', message: errorText(error), retryable: true};
  }
  const base = {retryable: error.retryable, correlationId: error.correlationId};
  switch (error.code) {
    case 'NOT_FOUND':
      if (isMissingRoute(error)) {
        return {
          ...base,
          retryable: false,
          title: 'The price editor is not available on this server',
          message: 'This server cannot take price changes yet. Nothing was proposed and the price in Square is unchanged.',
        };
      }
      return {
        ...base,
        title: 'This variation is not in the catalog',
        message: 'Square no longer has this variation, or the catalog here is out of date. Run Sync from Square on Business Knowledge, then try again.',
      };
    case 'INTEGRATION_UNAVAILABLE': {
      const provider = typeof error.details?.provider === 'string' ? providerLabel(error.details.provider) : 'Square';
      return {
        ...base,
        title: `${provider} is not responding`,
        message: 'Nothing was proposed and the price in Square is unchanged. Try again in a moment.',
      };
    }
    case 'ENVIRONMENT_MISMATCH':
      return {
        ...base,
        title: 'Square is not in sandbox',
        message: 'Payment work is refused, so this price change was not proposed.',
      };
    case 'VALIDATION_FAILED': {
      // The issue messages are written by the server and can name a field, so they are not shown.
      const message = errorCodeText('VALIDATION_FAILED');
      return {...base, title: 'The server did not accept this price', message, fieldMessage: message};
    }
    case 'FORBIDDEN_BUSINESS':
      return {...base, title: 'No access', message: 'You do not have access to this business.'};
    case 'RATE_LIMITED':
      return {...base, title: 'Too many requests', message: 'Wait a moment, then try again.'};
    default:
      return {...base, title: 'The change was not proposed', message: errorText(error)};
  }
}
