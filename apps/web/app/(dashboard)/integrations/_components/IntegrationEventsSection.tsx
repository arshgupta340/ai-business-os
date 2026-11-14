'use client';

import {Card} from '@astryxdesign/core/Card';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {Link} from '@astryxdesign/core/Link';
import {List, ListItem} from '@astryxdesign/core/List';
import {VStack} from '@astryxdesign/core/VStack';
import {EmptyState} from '@/components/EmptyState';
import {LoadingState} from '@/components/LoadingState';
import {SandboxBadge} from '@/components/SandboxBadge';
import {useActivity} from '@/lib/api';
import {formatRelative} from '@/lib/format';
import {INTEGRATION_EVENT_TYPES, describeIntegrationEvent} from '../_lib/integrations-view';
import {SectionError} from './SectionError';

const LIMIT = 10;

export function IntegrationEventsSection({businessId, timeZone}: {businessId: string; timeZone: string}) {
  // useActivityFeed (mounted by the screen) invalidates every activity query
  // for this business on each event, so this list refreshes without a reload.
  const activity = useActivity(businessId, {types: [...INTEGRATION_EVENT_TYPES], limit: LIMIT});

  let body;
  if (activity.isPending) {
    body = <LoadingState label="Loading integration events" />;
  } else if (activity.error) {
    body = (
      <SectionError title="Could not load integration events" error={activity.error} onRetry={() => void activity.refetch()} />
    );
  } else if (activity.data.items.length === 0) {
    body = (
      <EmptyState
        title="No integration problems recorded"
        description="Rejected webhooks, failed syncs, failed messages and failed steps show up here."
        headingLevel={3}
      />
    );
  } else {
    body = (
      <List hasDividers edge="bleed" density="compact">
        {activity.data.items.slice(0, LIMIT).map((event) => {
          const line = describeIntegrationEvent(event);
          return (
            <ListItem
              key={event.id}
              href="/activity"
              label={line.title}
              description={formatRelative(event.occurredAt, timeZone)}
              endContent={line.payment ? <SandboxBadge /> : undefined}
            />
          );
        })}
      </List>
    );
  }

  return (
    <Card>
      <VStack gap={3}>
        <HStack gap={2} justify="between" vAlign="center" wrap="wrap">
          <Heading level={2}>Recent integration events</Heading>
          <Link href="/activity" isStandalone>
            All activity
          </Link>
        </HStack>
        {body}
      </VStack>
    </Card>
  );
}
