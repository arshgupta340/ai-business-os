'use client';

import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {isApiError} from '@/lib/api';
import {errorText} from '@/lib/error-text';
import {providerLabel} from '@/lib/labels';

/**
 * The real server's answer to POST /api/conflicts/:id/resolve for a conflict
 * that lives only in the database: INTEGRATION_UNAVAILABLE with
 * details.use naming facts/propose with resolvesConflictId
 * (apps/server/src/app.ts on origin/arsh/integration). It is not an outage,
 * so a retry would get the same answer.
 */
export function isResolveOnFactsList(error: unknown): boolean {
  return (
    isApiError(error) &&
    error.code === 'INTEGRATION_UNAVAILABLE' &&
    typeof error.details?.use === 'string' &&
    error.details.use.includes('resolvesConflictId')
  );
}

/**
 * Owner-facing text for an error from the API layer (screen data map, "Rules
 * every screen follows" 9). This screen keeps its own sentence for the two
 * codes it handles in a special way. Every other code reads the shared
 * sentence from errorText. The server message is never shown.
 */
export function knowledgeErrorText(error: unknown): string {
  if (!isApiError(error)) return errorText(error);
  switch (error.code) {
    case 'ENVIRONMENT_MISMATCH':
      return 'Square is not in sandbox. Payment work is refused.';
    case 'INTEGRATION_UNAVAILABLE': {
      if (isResolveOnFactsList(error)) {
        return 'This server resolves this conflict with a change that you confirm in Approvals. Nothing changed yet.';
      }
      if (typeof error.details?.provider === 'string') return `${providerLabel(error.details.provider)} is not responding.`;
      return errorText(error);
    }
    default:
      return errorText(error);
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
  // A conflict resolved from the facts list gets the same answer on every retry.
  const retryable = isApiError(error) ? error.retryable && !isResolveOnFactsList(error) : true;
  const correlationId = isApiError(error) ? error.correlationId : undefined;
  return (
    <Banner
      status="error"
      title={title}
      description={knowledgeErrorText(error)}
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
