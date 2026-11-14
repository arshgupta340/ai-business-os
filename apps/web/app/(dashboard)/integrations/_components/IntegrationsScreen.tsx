'use client';

// Adapted from the Astryx page template "detail-page", the closest match from
// `npm run astryx -- build "integrations health panel ..."`: a summary header
// with status and one action (Check now), the main list (one card per
// provider), and the activity list beside it. The template's Layout frame,
// side panel and heroicons are left out: the dashboard shell already provides
// the frame and the app uses Astryx only. Event rows follow the
// ItemWithMetadata block.

import {Grid} from '@astryxdesign/core/Grid';
import {Link} from '@astryxdesign/core/Link';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {EmptyState} from '@/components/EmptyState';
import {PageHeader} from '@/components/PageHeader';
import {useActivityFeed, type ActivityFeedStatus} from '@/lib/api';
import {isMockMode} from '@/lib/env';
import {useBusiness} from '@/lib/session';
import {HealthPanel} from './HealthPanel';
import {IntegrationEventsSection} from './IntegrationEventsSection';
import {PhoneNumberSection} from './PhoneNumberSection';

const FEED_LABEL: Record<ActivityFeedStatus, string> = {
  connecting: 'Connecting to live updates.',
  connected: 'Live updates on. A health change shows here without a reload.',
  disconnected: 'Live updates dropped. Health may be out of date until you reload or press Check now.',
  unavailable: 'Live updates are not set up. Health still refreshes every minute.',
  idle: '',
};

export function IntegrationsScreen() {
  const {business, businessId} = useBusiness();
  // Stay subscribed: webhook.rejected and sync.* events refetch the health
  // query, and every event refetches the activity list below.
  const feed = useActivityFeed(businessId);

  if (!business || !businessId) {
    return <EmptyState title="No business selected" description="Pick a business in the top bar." headingLevel={1} />;
  }

  const timeZone = business.timezone;
  const feedNote = FEED_LABEL[feed.status];
  const mock = isMockMode() || feed.source === 'mock';

  return (
    <VStack gap={6}>
      <PageHeader
        title="Integrations"
        description={`The services the ${business.name.replace(/\.$/, '')} agent depends on, and what happens when one has a problem.`}
        actions={
          <Link href="/telemetry" isStandalone>
            Latency and cost
          </Link>
        }
      />
      {mock || feedNote ? (
        <VStack gap={1}>
          {mock ? (
            <Text type="supporting">Mock mode: everything on this page is mock data, not a live check of the providers.</Text>
          ) : null}
          {feedNote ? <Text type="supporting">{feedNote}</Text> : null}
        </VStack>
      ) : null}

      {/* Keyed so a refresh error or a pending check does not carry over to another business. */}
      <HealthPanel key={businessId} businessId={businessId} timeZone={timeZone} />

      <Grid columns={{minWidth: 320, max: 2}} gap={4}>
        <PhoneNumberSection businessId={businessId} timeZone={timeZone} />
        <IntegrationEventsSection businessId={businessId} timeZone={timeZone} />
      </Grid>
    </VStack>
  );
}
