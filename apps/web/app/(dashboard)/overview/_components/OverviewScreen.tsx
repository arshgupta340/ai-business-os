'use client';

// Adapted from the Astryx page template "dashboard" (npm run astryx -- build
// "business overview dashboard ..."): headline tiles first, then sections of
// cards and rows, each band in a VStack gap={6}. The charts, Layout frame and
// heroicons were left out: the dashboard shell already provides the frame and
// the app uses Astryx only.

import {Grid} from '@astryxdesign/core/Grid';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {EmptyState} from '@/components/EmptyState';
import {PageHeader} from '@/components/PageHeader';
import {RefreshFailedNotice} from '@/components/RefreshFailedNotice';
import {useActivityFeed, type ActivityFeedStatus} from '@/lib/api';
import {useBusiness} from '@/lib/session';
import {ActivitySection} from './ActivitySection';
import {AgentsSection} from './AgentsSection';
import {BookingsSection} from './BookingsSection';
import {HealthSection} from './HealthSection';
import {MockControlsPanel} from './MockControlsPanel';
import {OrdersSection} from './OrdersSection';
import {TodaySection} from './TodaySection';
import {businessFlow} from './overview-logic';

const FEED_LABEL: Record<ActivityFeedStatus, string> = {
  connecting: 'Connecting to live updates.',
  connected: 'Live updates on. Counts refresh when something happens.',
  disconnected: 'Live updates dropped. Numbers may be out of date until you reload.',
  unavailable: 'Live updates are not set up. Reload to see new numbers.',
  idle: '',
};

export function OverviewScreen() {
  const {business, businessId} = useBusiness();
  // Stay subscribed while the overview is open: each event refetches the
  // queries it affects, so every block below re-renders with fresh REST data.
  const feed = useActivityFeed(businessId);

  if (!business || !businessId) {
    return <EmptyState title="No business selected" description="Pick a business in the top bar." headingLevel={1} />;
  }

  const flow = businessFlow(business.category);
  const timeZone = business.timezone;
  const feedNote = FEED_LABEL[feed.status];

  return (
    <VStack gap={6}>
      <PageHeader title="Overview" description={`${business.name}, times in ${timeZone}`} />
      <RefreshFailedNotice businessId={businessId} />
      {feedNote ? <Text type="supporting">{feed.source === 'mock' ? `${feedNote} Mock data.` : feedNote}</Text> : null}

      <TodaySection businessId={businessId} timeZone={timeZone} />
      <AgentsSection businessId={businessId} />
      {flow !== 'bookings' ? <OrdersSection businessId={businessId} timeZone={timeZone} /> : null}
      {flow !== 'orders' ? <BookingsSection businessId={businessId} /> : null}

      <Grid columns={{minWidth: 320, max: 2}} gap={4}>
        <ActivitySection businessId={businessId} timeZone={timeZone} />
        <HealthSection businessId={businessId} timeZone={timeZone} />
      </Grid>

      {/* Keyed so a note about one business does not stay after a switch. */}
      <MockControlsPanel key={businessId} flow={flow} />
    </VStack>
  );
}
