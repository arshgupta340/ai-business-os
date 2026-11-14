'use client';

// Built from Astryx parts suggested by `npm run astryx -- build "latency
// telemetry panel ..."`: the dashboard templates it named are chart-based, so
// only their frame idea was kept (header, window control, one card of rows).
// The bars are the ProgressBar from the ProgressBarCustomFormat block. No
// charting library.

import {useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Divider} from '@astryxdesign/core/Divider';
import {HStack} from '@astryxdesign/core/HStack';
import {Link} from '@astryxdesign/core/Link';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {EmptyState} from '@/components/EmptyState';
import {LoadingState} from '@/components/LoadingState';
import {PageHeader} from '@/components/PageHeader';
import {isMockMode, useTelemetry} from '@/lib/api';
import {formatDateTime} from '@/lib/format';
import {useBusiness} from '@/lib/session';
import {
  DEFAULT_WINDOW,
  isTelemetryWindow,
  metricView,
  sinceFor,
  sortMetrics,
  WINDOW_OPTIONS,
  type TelemetryWindow,
} from '../_lib/telemetry';
import {MetricRow} from './MetricRow';
import {TelemetryError} from './TelemetryError';

export function TelemetryScreen() {
  const {business, businessId} = useBusiness();
  const [range, setRange] = useState<TelemetryWindow>(DEFAULT_WINDOW);
  // The window end is fixed when the window is chosen or refreshed, so the
  // query key stays stable between renders.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const timeZone = business?.timezone ?? 'UTC';
  const since = sinceFor(range, timeZone, nowMs);
  const telemetry = useTelemetry(businessId, {since});

  if (!business || !businessId) {
    return <EmptyState title="No business selected" description="Pick a business in the top bar." headingLevel={1} />;
  }

  const refresh = () => {
    setNowMs(Date.now());
    void telemetry.refetch();
  };

  let body;
  if (telemetry.isPending) {
    body = <LoadingState label="Loading telemetry" />;
  } else if (telemetry.error) {
    body = <TelemetryError error={telemetry.error} onRetry={refresh} />;
  } else {
    const views = sortMetrics(telemetry.data.metrics).map(metricView);
    if (views.length === 0 || views.every((v) => !v.hasData)) {
      body = (
        <EmptyState
          title="No measurements yet"
          description="Nothing was measured for this business in this window. Numbers appear after calls, approvals and payments happen."
          actions={<Button label="Refresh" onClick={refresh} />}
        />
      );
    } else {
      body = (
        <Card>
          <VStack gap={4}>
            {views.map((view, i) => (
              <VStack key={`${view.name}-${i}`} gap={4}>
                {i > 0 ? <Divider /> : null}
                <MetricRow view={view} />
              </VStack>
            ))}
          </VStack>
        </Card>
      );
    }
  }

  return (
    <VStack gap={6}>
      <Link href="/integrations" isStandalone>
        Back to integrations
      </Link>
      <PageHeader
        title="Telemetry"
        description={`${business.name}, times in ${timeZone}. Measured response times, not promises.`}
        actions={<Button label="Refresh" onClick={refresh} isLoading={telemetry.isFetching} />}
      />
      {isMockMode() ? (
        <Text type="supporting">Mock data. The mock returns the same numbers for every window and business.</Text>
      ) : null}

      <VStack gap={2}>
        <SegmentedControl
          label="Time window"
          value={range}
          onChange={(value) => {
            if (!isTelemetryWindow(value)) return;
            setRange(value);
            setNowMs(Date.now());
          }}
        >
          {WINDOW_OPTIONS.map((o) => (
            <SegmentedControlItem key={o.value} value={o.value} label={o.label} />
          ))}
        </SegmentedControl>
        <Text type="supporting">Since {formatDateTime(since, timeZone)}.</Text>
      </VStack>

      {body}
    </VStack>
  );
}
