'use client';

import {useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {Table, proportional} from '@astryxdesign/core/Table';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {LoadingState} from '@/components/LoadingState';
import {SandboxBadge} from '@/components/SandboxBadge';
import {StatusBadge} from '@/components/StatusBadge';
import {useCatalog, useSyncCatalog, type ActivityEvent} from '@/lib/api';
import {formatDateTime, formatMoney} from '@/lib/format';
import {statusView} from '@/lib/status';
import {ApiErrorBanner} from './ApiErrorBanner';
import {CATALOG_SYNC_LABELS, catalogSyncState} from './knowledge-model';

interface VariationRow extends Record<string, unknown> {
  id: string;
  item: string;
  variation: string;
  price: string;
  available: boolean;
}

type Props = {businessId: string; timezone: string; events: readonly ActivityEvent[]};

/** The Square catalog cache: display prices only. Quotes always come from Square. */
export function CatalogSection({businessId, timezone, events}: Props) {
  const catalog = useCatalog(businessId);
  const sync = useSyncCatalog(businessId);
  const [jobId, setJobId] = useState<string | null>(null);

  const syncState = jobId ? catalogSyncState(events, jobId) : null;
  // The sync job reuses the shared sync tones. Only the labels name the catalog.
  const syncView = syncState ? {label: CATALOG_SYNC_LABELS[syncState], tone: statusView('syncJob', syncState).tone} : null;
  const syncing = sync.isPending || syncState === 'PENDING' || syncState === 'RUNNING' || syncState === 'RETRYING';

  const startSync = () => {
    setJobId(null);
    sync.mutate(undefined, {onSuccess: ({jobId: id}) => setJobId(id)});
  };

  const rows: VariationRow[] = (catalog.data?.items ?? []).flatMap((item) =>
    item.variations.map((v) => ({
      id: v.id,
      item: item.name,
      variation: v.name,
      price: formatMoney(v.priceMinor, v.currency),
      available: item.available,
    })),
  );

  return (
    <Card>
      <VStack gap={3}>
        <HStack gap={2} vAlign="center" justify="between" wrap="wrap">
          <VStack gap={0.5}>
            <HStack gap={2} vAlign="center">
              <Heading level={3}>Catalog from Square</Heading>
              <SandboxBadge />
            </HStack>
            <Text type="supporting">
              {catalog.data
                ? `Last synced ${formatDateTime(catalog.data.syncedAt, timezone)}. Prices here are for display. Quotes always come from Square.`
                : 'Prices here are for display. Quotes always come from Square.'}
            </Text>
          </VStack>
          <Button label="Sync from Square" isLoading={syncing} onClick={startSync} />
        </HStack>

        {syncView ? (
          <HStack gap={2} vAlign="center" wrap="wrap">
            <StatusBadge label={syncView.label} tone={syncView.tone} />
            {syncState === 'FAILED' ? <Text type="supporting">The catalog was not changed. Try the sync again.</Text> : null}
          </HStack>
        ) : null}
        {syncing && syncState !== null ? <ProgressBar label="Syncing the catalog from Square" isIndeterminate /> : null}
        {sync.error ? <ApiErrorBanner title="The sync did not start" error={sync.error} onRetry={startSync} /> : null}

        {catalog.isPending ? (
          <LoadingState label="Loading the catalog" />
        ) : catalog.error ? (
          <ApiErrorBanner title="The catalog could not be loaded" error={catalog.error} onRetry={() => void catalog.refetch()} />
        ) : rows.length === 0 ? (
          <Text type="supporting">No catalog items yet. Run Sync from Square to load them.</Text>
        ) : (
          <VStack gap={3}>
            <Table<VariationRow>
              data={rows}
              idKey="id"
              density="compact"
              columns={[
                {key: 'item', header: 'Item', width: proportional(1, {minWidth: 100})},
                {key: 'variation', header: 'Variation', width: proportional(1, {minWidth: 90})},
                {
                  key: 'price',
                  header: 'Price (sandbox)',
                  width: proportional(1, {minWidth: 110}),
                  renderCell: (r) => <Text hasTabularNumbers>{r.price}</Text>,
                },
                {
                  key: 'available',
                  header: 'Available',
                  width: proportional(1, {minWidth: 80}),
                  renderCell: (r) => <Text type="supporting">{r.available ? 'Yes' : 'No'}</Text>,
                },
              ]}
            />
            {catalog.data!.items.map((item) =>
              item.modifierLists.map((list) => (
                <Text key={`${item.squareItemId}:${list.id}`} type="supporting">
                  {item.name}, {list.name} ({list.selectionType === 'MULTIPLE' ? 'choose any' : 'choose one'}):{' '}
                  {list.modifiers.map((m) => `${m.name} ${formatMoney(m.priceMinor)}`).join(', ')} (sandbox)
                </Text>
              )),
            )}
          </VStack>
        )}
      </VStack>
    </Card>
  );
}
