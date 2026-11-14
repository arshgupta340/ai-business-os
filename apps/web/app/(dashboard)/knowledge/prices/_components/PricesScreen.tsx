'use client';

import {useMemo, useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {List} from '@astryxdesign/core/List';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {EmptyState} from '@/components/EmptyState';
import {ErrorState} from '@/components/ErrorState';
import {LoadingState} from '@/components/LoadingState';
import {PageHeader} from '@/components/PageHeader';
import {SandboxBadge} from '@/components/SandboxBadge';
import {isApiError, useActivity, useActivityFeed, useApprovals, useCatalog, useFacts, type ApprovalRequest} from '@/lib/api';
import {formatDateTime} from '@/lib/format';
import {ApprovalDecisionDialog} from '../../../approvals/_components/ApprovalDecisionDialog';
import {approvalByVariation, mergeExecutionEvents, priceConflictFor} from '../_lib/price-row';
import {PriceEditorDialog, type PriceEditorTarget} from './PriceEditorDialog';
import {PriceRow} from './PriceRow';

export type PricesScreenProps = {businessId: string; businessName: string; timezone: string};

const EXECUTION_EVENT_TYPES = ['execution.started', 'execution.succeeded', 'execution.failed'];

/**
 * Price edit (U-13). Mount with key={businessId} so the changes proposed here
 * reset when the business changes. A price reaches Square only through the
 * approval the owner confirms in the decision dialog.
 */
export function PricesScreen({businessId, businessName, timezone}: PricesScreenProps) {
  const feed = useActivityFeed(businessId);
  const catalog = useCatalog(businessId);
  const facts = useFacts(businessId);
  const pending = useApprovals(businessId, {bundleType: 'price_edit', state: 'PENDING'});
  // Step history over REST, so a change approved before a reload still resolves. The feed refetches it on every event.
  const history = useActivity(businessId, {types: EXECUTION_EVENT_TYPES, limit: 200});

  const [sessionApprovals, setSessionApprovals] = useState<Record<string, string>>({});
  const [editor, setEditor] = useState<PriceEditorTarget | null>(null);
  const [dialogApprovalId, setDialogApprovalId] = useState<string | null>(null);

  const events = useMemo(() => mergeExecutionEvents(history.data?.items ?? [], feed.events), [history.data, feed.events]);
  const byVariation = approvalByVariation(sessionApprovals, pending.data?.items ?? []);
  const conflicts = facts.data?.conflicts ?? [];
  const factItems = facts.data?.items ?? [];

  const onProposed = (approval: ApprovalRequest, variationId: string) => {
    setSessionApprovals((prev) => ({...prev, [variationId]: approval.id}));
    setEditor(null);
    setDialogApprovalId(approval.id);
  };

  const items = catalog.data?.items ?? [];
  const variationCount = items.reduce((n, i) => n + i.variations.length, 0);

  return (
    <VStack gap={6}>
      <PageHeader
        title="Change a price"
        description={`Prices come from the Square catalog (sandbox). A change goes to Square only after you confirm it. Business: ${businessName}`}
        actions={<Button label="Back to Business Knowledge" variant="secondary" href="/knowledge" />}
      />

      {feed.status === 'disconnected' ? (
        <Text type="supporting">Live updates are paused. Reload the page to see the latest state.</Text>
      ) : null}

      {catalog.isPending ? (
        <LoadingState label="Loading the catalog" />
      ) : catalog.error ? (
        <ErrorState
          title="The catalog could not be loaded"
          message={isApiError(catalog.error) && catalog.error.code === 'FORBIDDEN_BUSINESS' ? 'You do not have access to this business.' : catalog.error.message}
          onRetry={isApiError(catalog.error) && !catalog.error.retryable ? undefined : () => void catalog.refetch()}
        />
      ) : variationCount === 0 ? (
        <EmptyState
          title="No Square catalog for this business"
          description={`${businessName} has no items in a Square catalog, so there are no prices to change here. Services and their details live in Business Knowledge.`}
          actions={<Button label="Open Business Knowledge" href="/knowledge" />}
        />
      ) : (
        <VStack gap={4}>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Text type="supporting">
              Last synced from Square {formatDateTime(catalog.data!.syncedAt, timezone)}. Quotes always come from Square.
            </Text>
            <SandboxBadge />
          </HStack>
          {facts.error ? (
            <Text type="supporting">Conflicts with your uploaded menu could not be loaded. Check them on Business Knowledge.</Text>
          ) : null}
          {items.map((item) => (
            <Card key={item.squareItemId}>
              <VStack gap={2}>
                <HStack gap={2} vAlign="center" wrap="wrap">
                  <Heading level={2}>{item.name}</Heading>
                  {item.available ? null : <Text type="supporting">Not available</Text>}
                </HStack>
                {item.description ? <Text type="supporting">{item.description}</Text> : null}
                <List hasDividers>
                  {item.variations.map((v) => (
                    <PriceRow
                      key={v.id}
                      businessId={businessId}
                      itemName={item.name}
                      variation={v}
                      approvalId={byVariation[v.id]}
                      events={events}
                      conflict={priceConflictFor(item, v, conflicts, factItems)}
                      isCatalogFetching={catalog.isFetching}
                      onChange={setEditor}
                      onReview={setDialogApprovalId}
                      onRefreshCatalog={() => void catalog.refetch()}
                    />
                  ))}
                </List>
              </VStack>
            </Card>
          ))}
        </VStack>
      )}

      <PriceEditorDialog businessId={businessId} target={editor} onClose={() => setEditor(null)} onProposed={onProposed} />
      <ApprovalDecisionDialog
        isOpen={dialogApprovalId !== null}
        businessId={businessId}
        approvalId={dialogApprovalId ?? ''}
        onClose={() => setDialogApprovalId(null)}
      />
    </VStack>
  );
}
