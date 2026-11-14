'use client';

import {useCallback, useEffect, useMemo, useState} from 'react';
import {usePathname, useRouter, useSearchParams} from 'next/navigation';
import {useQueryClient} from '@tanstack/react-query';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {HStack} from '@astryxdesign/core/HStack';
import {Tab, TabList} from '@astryxdesign/core/TabList';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {
  useActivity,
  useActivityFeed,
  useAgents,
  useBookings,
  useCalls,
  useOrders,
  type ActivityFeedStatus,
  type ActivityEventPayloads,
} from '@/lib/api';
import {formatRelative} from '@/lib/format';
import type {Tone} from '@/lib/status';
import {useBusiness} from '@/lib/session';
import {EmptyState} from '@/components/EmptyState';
import {LoadingState} from '@/components/LoadingState';
import {PageHeader} from '@/components/PageHeader';
import {StatusBadge} from '@/components/StatusBadge';
import {CallDetail} from './CallDetail';
import {CallList} from './CallList';
import {deriveJourney, groupByCall, mergeEvents, rejectedWebhooks, subjectIdFromEvents, type JourneyInput} from './journey';
import {MockControlsPanel} from './MockControlsPanel';
import {QueryError} from './ui';

/**
 * The live feed is not a server state machine, so statusView has no entry
 * for it. Nothing here is green: a connected feed confirms nothing.
 */
const FEED_VIEW: Record<ActivityFeedStatus, {label: string; tone: Tone}> = {
  connecting: {label: 'Live updates: connecting', tone: 'info'},
  connected: {label: 'Live updates: on', tone: 'info'},
  disconnected: {label: 'Live updates lost, data may be stale', tone: 'warning'},
  unavailable: {label: 'Live updates not configured', tone: 'warning'},
  idle: {label: 'No business selected', tone: 'neutral'},
};

type Tab = 'active' | 'finished';

export function LiveOperations() {
  const {businessId, business} = useBusiness();
  const timeZone = business?.timezone ?? 'America/Los_Angeles';
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const selectedParam = params.get('call');
  const [tab, setTab] = useState<Tab>('active');
  const [clearedAt, setClearedAt] = useState<string | null>(null);
  // After a mock call starts, the detail follows the newest call even when it moves to Finished.
  const [followSince, setFollowSince] = useState<string | null>(null);

  const feed = useActivityFeed(businessId, {limit: 200});
  const calls = useCalls(businessId, {limit: 50});
  const activity = useActivity(businessId, {limit: 200});
  const orders = useOrders(businessId, {limit: 200});
  const bookings = useBookings(businessId, {limit: 200});
  const agents = useAgents(businessId);

  const feedEvents = useMemo(
    () => (clearedAt ? feed.events.filter((e) => e.occurredAt > clearedAt) : feed.events),
    [feed.events, clearedAt],
  );

  const inputs = useMemo(() => {
    const all = mergeEvents(activity.data?.items ?? [], feedEvents);
    const groups = groupByCall(all);
    const callRows = calls.data?.items ?? [];
    const ids = new Set<string>([...callRows.map((c) => c.id), ...groups.keys()]);
    const list: JourneyInput[] = [];
    for (const callId of ids) {
      const events = groups.get(callId) ?? [];
      const call = callRows.find((c) => c.id === callId);
      // Feed events from before a mock reset can name a call the server no longer has.
      if (!call && calls.data && !activity.data?.items.some((e) => e.correlationId === callId) && clearedAt) continue;
      const fromEvents = subjectIdFromEvents(events);
      const order = orders.data?.items.find((o) => o.callId === callId || o.id === fromEvents.orderId);
      const booking = order ? undefined : bookings.data?.items.find((b) => b.callId === callId || b.id === fromEvents.bookingId);
      list.push({callId, call, events, order, booking});
    }
    return list;
  }, [activity.data, feedEvents, calls.data, orders.data, bookings.data, clearedAt]);

  const journeys = useMemo(
    () => inputs.map((input) => ({input, journey: deriveJourney(input)})).sort((a, b) => b.journey.startedAt.localeCompare(a.journey.startedAt)),
    [inputs],
  );
  const visible = journeys.filter(({journey}) => (tab === 'finished' ? journey.finished : !journey.finished));
  const activeCount = journeys.filter(({journey}) => !journey.finished).length;
  const finishedCount = journeys.length - activeCount;

  const selected =
    selectedParam
      ? journeys.find(({journey}) => journey.callId === selectedParam)
      : ((followSince ? journeys.find(({journey}) => journey.startedAt >= followSince) : undefined) ?? visible[0] ?? journeys[0]);

  // A link to one call (?call=) opens the tab that holds it, and follows it there when it finishes.
  const linkedFinished = selectedParam ? journeys.find(({journey}) => journey.callId === selectedParam)?.journey.finished : undefined;
  useEffect(() => {
    if (linkedFinished !== undefined) setTab(linkedFinished ? 'finished' : 'active');
  }, [selectedParam, linkedFinished]);

  const select = useCallback(
    (callId: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (callId) next.set('call', callId);
      else next.delete('call');
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, {scroll: false});
    },
    [params, pathname, router],
  );

  const followNewest = useCallback(() => {
    setTab('active');
    setFollowSince(new Date(Date.now() - 1000).toISOString());
    select(null);
  }, [select]);

  const onReset = useCallback(() => {
    setClearedAt(new Date().toISOString());
    select(null);
    void queryClient.invalidateQueries();
  }, [queryClient, select]);

  const webhooks = useMemo(() => rejectedWebhooks(mergeEvents(activity.data?.items ?? [], feedEvents)), [activity.data, feedEvents]);
  const feedView = FEED_VIEW[feed.status];
  const feedLabel = feed.source === 'mock' ? `${feedView.label} (mock data)` : feedView.label;

  const loading = calls.isPending || activity.isPending;
  const error = calls.error ?? activity.error;

  return (
    <VStack gap={5}>
      <PageHeader
        title="Live operations"
        description="Every call, from the first word to a verified sandbox payment. Nothing is charged or sent before you approve."
        actions={
          <HStack gap={2} vAlign="center">
            <StatusBadge label={feedLabel} tone={feedView.tone} />
            {feed.status === 'disconnected' ? (
              <Button label="Refresh" size="sm" onClick={() => void queryClient.invalidateQueries()} />
            ) : null}
          </HStack>
        }
      />

      <MockControlsPanel onStarted={followNewest} onReset={onReset} />

      {webhooks[0] ? (
        <Banner
          status="warning"
          title={`Rejected webhook from ${(webhooks[0].payload as unknown as ActivityEventPayloads['webhook.rejected']).provider === 'square' ? 'Square' : 'Twilio'}`}
          description={`${
            (webhooks[0].payload as unknown as ActivityEventPayloads['webhook.rejected']).reason === 'signature_invalid'
              ? 'The signature did not match, so the server ignored it.'
              : 'The request was malformed, so the server ignored it.'
          } No order or payment changed. ${formatRelative(webhooks[0].occurredAt, timeZone)}.${
            webhooks.length > 1 ? ` ${webhooks.length - 1} earlier.` : ''
          } If this keeps happening, check the webhook signature key in Integrations.`}
          collapsible={false}
        />
      ) : null}

      {loading ? (
        <LoadingState label="Loading calls" />
      ) : error ? (
        <QueryError
          title="Could not load calls"
          error={error}
          onRetry={() => {
            void calls.refetch();
            void activity.refetch();
          }}
        />
      ) : journeys.length === 0 ? (
        <EmptyState title="No calls yet" description="When a customer calls your live agent, the call appears here and fills in as it happens." />
      ) : (
        <VStack gap={4}>
          <TabList value={tab} onChange={(v) => setTab(v as Tab)} hasDivider size="lg">
            <Tab value="active" label={`In progress (${activeCount})`} />
            <Tab value="finished" label={`Finished (${finishedCount})`} />
          </TabList>
          <HStack gap={5} vAlign="start" wrap="wrap">
            <VStack gap={2} width={360} style={{flex: '0 1 auto', maxWidth: '100%'}}>
              {visible.length === 0 ? (
                <Text type="body" color="secondary">
                  {tab === 'active' ? 'No call is in progress.' : 'No finished calls yet.'}
                </Text>
              ) : (
                <CallList
                  journeys={visible.map((v) => v.journey)}
                  selectedId={selected?.journey.callId ?? null}
                  onSelect={select}
                  agents={agents.data?.items}
                  timeZone={timeZone}
                />
              )}
            </VStack>
            <VStack gap={4} style={{flex: '1 1 30rem', minWidth: 0}}>
              {selected && businessId ? (
                <CallDetail businessId={businessId} input={selected.input} agents={agents.data?.items} timeZone={timeZone} />
              ) : selectedParam ? (
                <EmptyState
                  title="Call not found in this business"
                  description="It may belong to another business, or the mock data was reset."
                  actions={<Button label="Show the newest call" onClick={() => select(null)} />}
                />
              ) : null}
            </VStack>
          </HStack>
        </VStack>
      )}
    </VStack>
  );
}
