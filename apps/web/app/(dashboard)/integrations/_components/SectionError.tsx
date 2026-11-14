'use client';

import {Collapsible} from '@astryxdesign/core/Collapsible';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {ErrorState} from '@/components/ErrorState';
import {isApiError} from '@/lib/api';
import {canRetry, errorText} from '../_lib/integrations-view';

/**
 * Error state for one block of the Integrations screen. Shows safe text, keeps
 * the correlation ID behind a details toggle, and offers retry only when the
 * error allows it (screen data map, rule 9).
 */
export function SectionError({title, error, onRetry}: {title: string; error: unknown; onRetry: () => void}) {
  const correlationId = isApiError(error) ? error.correlationId : undefined;
  return (
    <VStack gap={2}>
      <ErrorState title={title} message={errorText(error)} onRetry={canRetry(error) ? onRetry : undefined} />
      {correlationId ? (
        <Collapsible trigger={<Text type="supporting">Details</Text>} defaultIsOpen={false}>
          <Text type="supporting">Reference ID: {correlationId}</Text>
        </Collapsible>
      ) : null}
    </VStack>
  );
}
