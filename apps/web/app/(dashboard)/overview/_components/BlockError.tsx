'use client';

import {Collapsible} from '@astryxdesign/core/Collapsible';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {ErrorState} from '@/components/ErrorState';
import {isApiError} from '@/lib/api';
import {errorText} from '@/lib/error-text';

/**
 * Error state for one Overview block. Shows the safe ApiError message, keeps
 * the correlation ID behind a details toggle, and offers retry only when the
 * error is retryable (data map rule 9).
 */
export function BlockError({title, error, onRetry}: {title: string; error: unknown; onRetry: () => void}) {
  const api = isApiError(error) ? error : null;
  // The server message can carry an error code. The owner reads the sentence for the code.
  const message = api ? errorText(api) : 'Could not load this part of the overview.';
  const canRetry = api ? api.retryable : true;
  return (
    <VStack gap={2}>
      <ErrorState title={title} message={message} onRetry={canRetry ? onRetry : undefined} />
      {api?.correlationId ? (
        <Collapsible trigger={<Text type="supporting">Details</Text>} defaultIsOpen={false}>
          <Text type="supporting">Reference ID: {api.correlationId}</Text>
        </Collapsible>
      ) : null}
    </VStack>
  );
}
