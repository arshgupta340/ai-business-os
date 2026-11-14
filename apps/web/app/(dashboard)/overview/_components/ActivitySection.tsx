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
import {useActivity, useAgents} from '@/lib/api';
import {formatRelative} from '@/lib/format';
import {BlockError} from './BlockError';
import {describeEvent} from './overview-logic';

const RECENT_LIMIT = 8;

export function ActivitySection({businessId, timeZone}: {businessId: string; timeZone: string}) {
  const activity = useActivity(businessId, {limit: 20});
  // Shares the cache entry with the agent cards, so this is not a second request.
  const agents = useAgents(businessId);
  const agentName = (id: string) => agents.data?.items.find((a) => a.id === id)?.name;

  let body;
  if (activity.isPending) {
    body = <LoadingState label="Loading activity" />;
  } else if (activity.error) {
    body = (
      <BlockError title="Could not load activity" error={activity.error} onRetry={() => void activity.refetch()} />
    );
  } else if (activity.data.items.length === 0) {
    body = <EmptyState title="No activity yet" description="Calls, approvals and payments show up here." headingLevel={3} />;
  } else {
    body = (
      <List hasDividers edge="bleed" density="compact">
        {activity.data.items.slice(0, RECENT_LIMIT).map((event) => {
          const line = describeEvent(event, {timeZone, agentName});
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
        <HStack gap={2} justify="between" vAlign="center">
          <Heading level={2}>Recent activity</Heading>
          <Link href="/activity" isStandalone>
            All activity
          </Link>
        </HStack>
        {body}
      </VStack>
    </Card>
  );
}
