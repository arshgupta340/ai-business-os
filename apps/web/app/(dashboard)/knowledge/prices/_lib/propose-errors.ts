/**
 * Owner-facing text for each documented error of
 * POST /api/businesses/:id/catalog/prices/propose (API.md 3.1), plus the
 * errors every screen handles (screen data map, rule 9).
 */
import {isApiError} from '@/lib/api';

export type ProposeErrorView = {
  title: string;
  message: string;
  /** A message to show under the price field instead of in the banner. */
  fieldMessage?: string;
  retryable: boolean;
  correlationId?: string;
};

export function proposeErrorView(error: unknown): ProposeErrorView {
  if (!isApiError(error)) {
    return {title: 'The change was not proposed', message: error instanceof Error ? error.message : 'Something went wrong.', retryable: true};
  }
  const base = {retryable: error.retryable, correlationId: error.correlationId};
  switch (error.code) {
    case 'NOT_FOUND':
      return {
        ...base,
        title: 'This variation is not in the catalog',
        message: 'Square no longer has this variation, or the catalog here is out of date. Run Sync from Square on Business Knowledge, then try again.',
      };
    case 'INTEGRATION_UNAVAILABLE': {
      const provider = typeof error.details?.provider === 'string' ? error.details.provider : 'Square';
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
      const issues = Array.isArray(error.details?.issues) ? error.details.issues : [];
      const text = issues
        .map((i) => (i && typeof i === 'object' && 'message' in i ? String((i as {message: unknown}).message) : ''))
        .filter(Boolean)
        .join('. ');
      return {...base, title: 'The server did not accept this price', message: error.message, fieldMessage: text || error.message};
    }
    case 'FORBIDDEN_BUSINESS':
      return {...base, title: 'No access', message: 'You do not have access to this business.'};
    case 'RATE_LIMITED':
      return {...base, title: 'Too many requests', message: 'Wait a moment, then try again.'};
    default:
      return {...base, title: 'The change was not proposed', message: error.message};
  }
}
