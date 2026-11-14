'use client';

import {Collapsible} from '@astryxdesign/core/Collapsible';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {ErrorState} from '@/components/ErrorState';
import {isApiError} from '@/lib/api';

/**
 * Same pattern as the Overview block error: the safe ApiError message, the
 * correlation ID behind a details toggle, retry only when retryable (data map
 * rule 9).
 */
export function TelemetryError({error, onRetry}: {error: unknown; onRetry: () => void}) {
  const api = isApiError(error) ? error : null;
  const message = api?.message ?? 'Could not load telemetry.';
  const canRetry = api ? api.retryable : true;
  return (
    <VStack gap={2}>
      <ErrorState title="Could not load telemetry" message={message} onRetry={canRetry ? onRetry : undefined} />
      {api?.correlationId ? (
        <Collapsible trigger={<Text type="supporting">Details</Text>} defaultIsOpen={false}>
          <Text type="supporting">Reference ID: {api.correlationId}</Text>
        </Collapsible>
      ) : null}
    </VStack>
  );
}
