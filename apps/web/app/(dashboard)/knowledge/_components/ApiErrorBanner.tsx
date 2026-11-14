'use client';

import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {isApiError} from '@/lib/api';

/** Owner-facing text for an error from the API layer (screen data map, "Rules every screen follows" 9). */
export function errorText(error: unknown): string {
  if (!isApiError(error)) return error instanceof Error ? error.message : 'Something went wrong.';
  switch (error.code) {
    case 'FORBIDDEN_BUSINESS':
      return 'You do not have access to this business.';
    case 'NOT_FOUND':
      return 'Not found in this business.';
    case 'ENVIRONMENT_MISMATCH':
      return 'Square is not in sandbox. Payment work is refused.';
    case 'INTEGRATION_UNAVAILABLE': {
      const provider = typeof error.details?.provider === 'string' ? error.details.provider : 'A provider';
      return `${provider} is not responding.`;
    }
    case 'VALIDATION_FAILED': {
      const issues = Array.isArray(error.details?.issues) ? error.details.issues : [];
      const text = issues
        .map((issue) => (issue && typeof issue === 'object' && 'message' in issue ? String(issue.message) : ''))
        .filter(Boolean);
      return text.length ? `${error.message} (${text.join('. ')})` : error.message;
    }
    default:
      return error.message;
  }
}

/** An error banner. The correlation ID sits behind the banner's details toggle. Retry only when the error allows it. */
export function ApiErrorBanner({
  error,
  title = 'Something went wrong',
  onRetry,
}: {
  error: unknown;
  title?: string;
  onRetry?: () => void;
}) {
  const retryable = isApiError(error) ? error.retryable : true;
  const correlationId = isApiError(error) ? error.correlationId : undefined;
  return (
    <Banner
      status="error"
      title={title}
      description={errorText(error)}
      container="card"
      endContent={onRetry && retryable ? <Button label="Try again" onClick={() => onRetry()} /> : undefined}>
      {correlationId ? (
        <VStack gap={1}>
          <Text type="supporting">Reference for support: {correlationId}</Text>
        </VStack>
      ) : undefined}
    </Banner>
  );
}
