'use client';

import {useEffect, useRef} from 'react';
import {Card} from '@astryxdesign/core/Card';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {LoadingState} from '@/components/LoadingState';
import {StatusBadge} from '@/components/StatusBadge';
import {useFile, type BusinessFact, type FactConflict} from '@/lib/api';
import {formatDateTime} from '@/lib/format';
import {statusView} from '@/lib/status';
import {ApiErrorBanner} from './ApiErrorBanner';
import {DraftFactRow} from './DraftFactRow';
import {UploadField} from './UploadField';
import {draftsForFile, formatBytes} from './knowledge-model';

type Props = {
  businessId: string;
  timezone: string;
  fileId: string;
  facts: readonly BusinessFact[];
  conflictsByFact: Map<string, FactConflict>;
  onUploaded: (fileId: string) => void;
  onRefetchFacts: () => void;
};

/** One uploaded file: its extraction progress, then the draft facts read from it. */
export function FileCard({businessId, timezone, fileId, facts, conflictsByFact, onUploaded, onRefetchFacts}: Props) {
  const file = useFile(businessId, fileId);
  const extractionState = file.data?.extractionState;
  const seenState = useRef(extractionState);

  // The file poll can see the end of extraction before (or without) the
  // extraction.completed event, for example when live updates are off.
  // Refetch the facts once when this card sees the state move to EXTRACTED.
  useEffect(() => {
    const before = seenState.current;
    seenState.current = extractionState;
    if (extractionState === 'EXTRACTED' && before && before !== 'EXTRACTED') onRefetchFacts();
  }, [extractionState, onRefetchFacts]);

  if (file.isPending) {
    return (
      <Card>
        <LoadingState label="Loading the file" />
      </Card>
    );
  }
  if (file.error) {
    return <ApiErrorBanner title="This file could not be loaded" error={file.error} onRetry={() => void file.refetch()} />;
  }

  const record = file.data;
  const state = record.extractionState;
  const view = statusView('fileExtraction', state);
  const drafts = draftsForFile(facts, record.id);
  const working = state === 'PENDING' || state === 'EXTRACTING';

  return (
    <Card>
      <VStack gap={3}>
        <HStack gap={2} vAlign="center" justify="between" wrap="wrap">
          <VStack gap={0.5}>
            <Heading level={3}>{record.name}</Heading>
            <Text type="supporting">
              {formatBytes(record.sizeBytes)}, uploaded {formatDateTime(record.createdAt, timezone)}
            </Text>
          </VStack>
          <StatusBadge label={view.label} tone={view.tone} />
        </HStack>

        {working ? (
          <ProgressBar
            label={state === 'PENDING' ? 'Waiting to read the file' : 'Reading the file'}
            isIndeterminate
          />
        ) : null}

        {state === 'FAILED' ? (
          <VStack gap={2}>
            <Text>The file could not be read. No facts were saved from it. Upload it again, or try another file.</Text>
            <UploadField businessId={businessId} onUploaded={onUploaded} label="Upload again" mode="input" />
          </VStack>
        ) : null}

        {state === 'EXTRACTED' ? (
          drafts.length ? (
            <VStack gap={2}>
              <Text type="supporting">
                These are drafts. The agent does not use them until you confirm each one.
              </Text>
              {drafts.map((fact) => (
                <DraftFactRow
                  key={fact.id}
                  businessId={businessId}
                  fact={fact}
                  fileName={record.name}
                  conflict={conflictsByFact.get(fact.id)}
                  onRefetch={onRefetchFacts}
                />
              ))}
            </VStack>
          ) : (
            <Text type="supporting">No draft facts from this file are waiting for review.</Text>
          )
        ) : null}
      </VStack>
    </Card>
  );
}
