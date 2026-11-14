'use client';

import {useState} from 'react';
import {Card} from '@astryxdesign/core/Card';
import {Heading} from '@astryxdesign/core/Heading';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {EmptyState} from '@/components/EmptyState';
import {LoadingState} from '@/components/LoadingState';
import {PageHeader} from '@/components/PageHeader';
import {
  useActivityFeed,
  useApprovals,
  useBusiness as useBusinessProfile,
  useCatalog,
  useFacts,
  type FactConflict,
} from '@/lib/api';
import {ApiErrorBanner} from './ApiErrorBanner';
import {CatalogSection} from './CatalogSection';
import {ConflictBanner, ConflictCard} from './Conflicts';
import {FileCard} from './FileCard';
import {KnowledgeGroups} from './KnowledgeGroups';
import {UploadField} from './UploadField';
import {conflictByFactId, knownFileIds} from './knowledge-model';

export type KnowledgeScreenProps = {
  businessId: string;
  businessName: string;
  category: string;
  timezone: string;
};

/**
 * Knowledge review (U-08). Mount it with key={businessId} so all local state
 * (files uploaded here, proposals sent here) resets when the business changes.
 */
export function KnowledgeScreen({businessId, businessName, category, timezone}: KnowledgeScreenProps) {
  const feed = useActivityFeed(businessId);
  const facts = useFacts(businessId);
  const profile = useBusinessProfile(businessId);
  const approvals = useApprovals(businessId, {bundleType: 'fact_edit', state: 'PENDING'});
  const hasCatalog = category === 'restaurant';
  const catalog = useCatalog(hasCatalog ? businessId : null);

  const [sessionUploads, setSessionUploads] = useState<string[]>([]);
  // Conflicts the server answered as resolved. They hide before the facts refetch lands.
  const [resolvedIds, setResolvedIds] = useState<string[]>([]);

  const items = facts.data?.items ?? [];
  const openConflicts: FactConflict[] = (facts.data?.conflicts ?? []).filter(
    (c) => c.state === 'open' && !resolvedIds.includes(c.id),
  );
  const conflictsByFact = conflictByFactId(openConflicts);
  const fileIds = knownFileIds(sessionUploads, feed.events, items);

  const onUploaded = (fileId: string) => setSessionUploads((prev) => [fileId, ...prev.filter((id) => id !== fileId)]);
  const onResolved = (conflict: FactConflict) => {
    if (conflict.state === 'resolved') setResolvedIds((prev) => [...prev, conflict.id]);
  };
  const refetchFacts = () => void facts.refetch();

  return (
    <VStack gap={6}>
      <PageHeader
        title="Business Knowledge"
        description={`Upload a document, check what was read from it, and settle conflicts before you publish. Business: ${businessName}`}
      />

      {facts.data ? <ConflictBanner conflicts={openConflicts} /> : null}
      {feed.status === 'disconnected' ? (
        <Text type="supporting">Live updates are paused. Reload the page to see the latest state.</Text>
      ) : null}

      <Card>
        <VStack gap={3}>
          <Heading level={2}>Upload a document</Heading>
          <Text type="supporting">
            A menu, a price list or a services sheet. What is read from it is saved as drafts. Nothing the agent uses
            changes until you confirm it.
          </Text>
          <UploadField businessId={businessId} onUploaded={onUploaded} />
        </VStack>
      </Card>

      <VStack gap={3}>
        <Heading level={2}>From your uploads</Heading>
        {facts.isPending ? (
          <LoadingState label="Loading your documents" />
        ) : facts.error ? (
          <ApiErrorBanner title="Your documents could not be loaded" error={facts.error} onRetry={refetchFacts} />
        ) : fileIds.length === 0 ? (
          <EmptyState title="No documents yet. Upload a menu or a price list." headingLevel={3} />
        ) : (
          <VStack gap={3}>
            <Text type="supporting">
              This list shows files uploaded on this page and files that still have drafts to review.
            </Text>
            {fileIds.map((fileId) => (
              <FileCard
                key={fileId}
                businessId={businessId}
                timezone={timezone}
                fileId={fileId}
                facts={items}
                conflictsByFact={conflictsByFact}
                onUploaded={onUploaded}
                onRefetchFacts={refetchFacts}
              />
            ))}
          </VStack>
        )}
      </VStack>

      {openConflicts.length ? (
        <VStack gap={3}>
          <Heading level={2}>Conflicts</Heading>
          {openConflicts.map((conflict) => (
            <ConflictCard
              key={conflict.id}
              businessId={businessId}
              conflict={conflict}
              facts={items}
              catalog={catalog.data?.items}
              onResolved={onResolved}
              onRefetch={refetchFacts}
            />
          ))}
        </VStack>
      ) : null}

      <VStack gap={3}>
        <Heading level={2}>Knowledge the agent uses</Heading>
        {facts.isPending ? (
          <LoadingState label="Loading business knowledge" />
        ) : facts.error ? (
          <ApiErrorBanner title="Business knowledge could not be loaded" error={facts.error} onRetry={refetchFacts} />
        ) : (
          <KnowledgeGroups
            facts={items}
            timezone={timezone}
            profile={profile.data}
            pendingApprovals={approvals.data?.items ?? []}
          />
        )}
      </VStack>

      {hasCatalog ? (
        <VStack gap={3}>
          <Heading level={2}>Catalog</Heading>
          <CatalogSection businessId={businessId} timezone={timezone} events={feed.events} />
        </VStack>
      ) : null}
    </VStack>
  );
}
