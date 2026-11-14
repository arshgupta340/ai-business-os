'use client';

import {Button} from '@astryxdesign/core/Button';
import {Grid} from '@astryxdesign/core/Grid';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {LoadingState} from '@/components/LoadingState';
import {StatusBadge} from '@/components/StatusBadge';
import {HEALTH_PROVIDERS, summarizeHealth} from '@/components/shell/ConnectionHealth';
import {useIntegrationsHealth, useRefreshIntegrationsHealth} from '@/lib/api';
import {ProviderCard} from './ProviderCard';
import {SectionError} from './SectionError';

const PROVIDERS = HEALTH_PROVIDERS;

export function HealthPanel({businessId, timeZone}: {businessId: string; timeZone: string}) {
  const health = useIntegrationsHealth(businessId);
  // The refresh result is written into the health query only when the server
  // answers (useRefreshIntegrationsHealth onSuccess). Nothing changes before.
  const refresh = useRefreshIntegrationsHealth(businessId);
  const checkNow = () => refresh.mutate();

  let body;
  if (health.isPending) {
    body = <LoadingState label="Loading integration health" />;
  } else if (health.error) {
    body = (
      <SectionError title="Could not load integration health" error={health.error} onRetry={() => void health.refetch()} />
    );
  } else {
    const summary = summarizeHealth(health.data);
    body = (
      <VStack gap={3}>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <StatusBadge label={summary.status.label} tone={summary.status.tone} />
          <Text type="supporting">{summary.detail}</Text>
        </HStack>
        <Grid columns={{minWidth: 300, max: 3}} gap={4}>
          {PROVIDERS.map((provider) => {
            const entry = health.data[provider];
            return entry ? <ProviderCard key={provider} provider={provider} entry={entry} timeZone={timeZone} /> : null;
          })}
        </Grid>
      </VStack>
    );
  }

  return (
    <VStack gap={3}>
      <HStack gap={2} justify="between" vAlign="center" wrap="wrap">
        <Heading level={2}>Provider health</Heading>
        <Button
          label={refresh.isPending ? 'Checking' : 'Check now'}
          variant="primary"
          isLoading={refresh.isPending}
          isDisabled={refresh.isPending || !health.data}
          tooltip="Runs a live check of every provider now"
          onClick={checkNow}
        />
      </HStack>
      <Text type="supporting">
        These integrations use preconnected test credentials. The page shows the last stored check and refreshes every minute.
      </Text>
      {refresh.error ? (
        <SectionError title="The check did not finish" error={refresh.error} onRetry={checkNow} />
      ) : null}
      {body}
    </VStack>
  );
}
