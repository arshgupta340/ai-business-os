'use client';

import {Card} from '@astryxdesign/core/Card';
import {Grid} from '@astryxdesign/core/Grid';
import {Heading} from '@astryxdesign/core/Heading';
import {List, ListItem} from '@astryxdesign/core/List';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {EmptyState} from '@/components/EmptyState';
import {LoadingState} from '@/components/LoadingState';
import {StatusBadge} from '@/components/StatusBadge';
import {useBookings} from '@/lib/api';
import {formatDateTime} from '@/lib/format';
import {statusView} from '@/lib/status';
import {BlockError} from './BlockError';
import {groupBookings} from './overview-logic';

export function BookingsSection({businessId}: {businessId: string}) {
  const bookings = useBookings(businessId, {limit: 200});

  let body;
  if (bookings.isPending) {
    body = <LoadingState label="Loading bookings" />;
  } else if (!bookings.data) {
    // No data at all: the first load failed. A failed refetch keeps the old data and the page header says so.
    body = <BlockError title="Could not load bookings" error={bookings.error} onRetry={() => void bookings.refetch()} />;
  } else if (bookings.data.items.length === 0) {
    body = (
      <EmptyState
        title="No bookings yet"
        description="Bookings appear here when your agent proposes a time on a call."
        headingLevel={3}
      />
    );
  } else {
    const groups = groupBookings(bookings.data.items);
    const recent = bookings.data.items.slice(0, 5);
    body = (
      <Grid columns={{minWidth: 300, max: 2}} gap={4}>
        <Card>
          <VStack gap={2}>
            <Heading level={3}>By status</Heading>
            <List hasDividers edge="bleed" density="compact">
              {groups.map((group) => {
                const tone = statusView('booking', group.toneState).tone;
                return (
                  <ListItem
                    key={group.key}
                    label={group.title}
                    endContent={<StatusBadge label={String(group.count)} tone={group.count > 0 ? tone : 'neutral'} />}
                  />
                );
              })}
            </List>
          </VStack>
        </Card>
        <Card>
          <VStack gap={2}>
            <Heading level={3}>Latest bookings</Heading>
            <List hasDividers edge="bleed" density="compact">
              {recent.map((booking) => {
                const view = statusView('booking', booking.status);
                return (
                  <ListItem
                    key={booking.id}
                    label={`${booking.serviceName} for ${booking.customer.name}`}
                    description={formatDateTime(booking.startUtc, booking.timezone)}
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
      <Heading level={2}>Bookings</Heading>
      {body}
      {bookings.data?.nextCursor ? <Text type="supporting">Showing the newest 200 bookings.</Text> : null}
    </VStack>
  );
}
