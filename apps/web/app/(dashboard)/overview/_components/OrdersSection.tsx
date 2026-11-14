'use client';

import {Card} from '@astryxdesign/core/Card';
import {Grid} from '@astryxdesign/core/Grid';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {List, ListItem} from '@astryxdesign/core/List';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {EmptyState} from '@/components/EmptyState';
import {LoadingState} from '@/components/LoadingState';
import {SandboxBadge} from '@/components/SandboxBadge';
import {StatusBadge} from '@/components/StatusBadge';
import {useOrders} from '@/lib/api';
import {formatMoney, formatTime} from '@/lib/format';
import {statusView} from '@/lib/status';
import {BlockError} from './BlockError';
import {groupOrders} from './overview-logic';

export function OrdersSection({businessId, timeZone}: {businessId: string; timeZone: string}) {
  const orders = useOrders(businessId, {limit: 200});

  let body;
  if (orders.isPending) {
    body = <LoadingState label="Loading orders" />;
  } else if (!orders.data) {
    // No data at all: the first load failed. A failed refetch keeps the old data and the page header says so.
    body = <BlockError title="Could not load orders" error={orders.error} onRetry={() => void orders.refetch()} />;
  } else if (orders.data.items.length === 0) {
    body = (
      <EmptyState
        title="No orders yet"
        description="Orders appear here when your agent proposes one on a call."
        headingLevel={3}
      />
    );
  } else {
    const groups = groupOrders(orders.data.items);
    const recent = orders.data.items.slice(0, 5);
    body = (
      <Grid columns={{minWidth: 300, max: 2}} gap={4}>
        <Card>
          <VStack gap={2}>
            <Heading level={3}>By status</Heading>
            <List hasDividers edge="bleed" density="compact">
              {groups.map((group) => {
                const tone = statusView('order', group.toneState).tone;
                const showTotal = group.key === 'paid' && group.count > 0;
                return (
                  <ListItem
                    key={group.key}
                    label={group.title}
                    description={showTotal ? `${formatMoney(group.totalMinor, group.currency)} total` : undefined}
                    endContent={
                      <HStack gap={2} vAlign="center">
                        {group.payment && group.count > 0 ? <SandboxBadge /> : null}
                        <StatusBadge label={String(group.count)} tone={group.count > 0 ? tone : 'neutral'} />
                      </HStack>
                    }
                  />
                );
              })}
            </List>
          </VStack>
        </Card>
        <Card>
          <VStack gap={2}>
            <Heading level={3}>Latest orders</Heading>
            <List hasDividers edge="bleed" density="compact">
              {recent.map((order) => {
                const view = statusView('order', order.status);
                return (
                  <ListItem
                    key={order.id}
                    label={`${order.contact.name}, pickup ${formatTime(order.fulfillment.pickupAt, timeZone)}`}
                    description={`${formatMoney(order.totalMinor, order.currency)} (sandbox)`}
                    endContent={<StatusBadge label={view.label} tone={view.tone} />}
                  />
                );
              })}
            </List>
          </VStack>
        </Card>
      </Grid>
    );
  }

  return (
    <VStack gap={3}>
      <HStack gap={2} vAlign="center">
        <Heading level={2}>Orders</Heading>
        <SandboxBadge label="Sandbox payments" />
      </HStack>
      {body}
    </VStack>
  );
}
