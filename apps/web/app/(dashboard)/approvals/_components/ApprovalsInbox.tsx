'use client';

import {useState} from 'react';
import {usePathname, useRouter, useSearchParams} from 'next/navigation';
import {Badge} from '@astryxdesign/core/Badge';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {HStack} from '@astryxdesign/core/HStack';
import {List, ListItem} from '@astryxdesign/core/List';
import {Tab, TabList} from '@astryxdesign/core/TabList';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {EmptyState} from '@/components/EmptyState';
import {ErrorState} from '@/components/ErrorState';
import {LoadingState} from '@/components/LoadingState';
import {PageHeader} from '@/components/PageHeader';
import {SandboxBadge} from '@/components/SandboxBadge';
import {StatusBadge} from '@/components/StatusBadge';
import {
  isApiError,
  useActivityFeed,
  useApprovals,
  useMockControls,
  type ApprovalRequest,
  type ApprovalState,
  type OrderApprovalPayload,
} from '@/lib/api';
import {formatCountdown, formatMoney, formatRelative, secondsUntil} from '@/lib/format';
import {useBusiness} from '@/lib/session';
import {statusView} from '@/lib/status';
import {actorLabel, bundleLabel, effectiveState, sortInbox, summaryLine} from '../_lib/approval-view';
import {useNow} from '../_lib/useNow';
import {ApprovalDecisionDialog} from './ApprovalDecisionDialog';

type Filter = 'all' | ApprovalState;

const FILTERS: {value: Filter; label: string}[] = [
  {value: 'all', label: 'All'},
  {value: 'PENDING', label: 'Waiting'},
  {value: 'APPROVED', label: 'Approved'},
  {value: 'REJECTED', label: 'Rejected'},
  {value: 'EXPIRED', label: 'Expired'},
];

/** The same query the shell badge uses, so the two share one cache entry. */
export const PENDING_QUERY = {state: 'PENDING', limit: 200} as const;

export function ApprovalsInbox() {
  const {businessId, business} = useBusiness();
  const timeZone = business?.timezone ?? 'UTC';
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const openId = searchParams.get('id');
  const [filter, setFilter] = useState<Filter>('all');

  // Stay subscribed: each event refetches the approval queries.
  const feed = useActivityFeed(businessId);

  const pending = useApprovals(businessId, PENDING_QUERY);
  const approved = useApprovals(businessId, {state: 'APPROVED', limit: 200});
  const rejected = useApprovals(businessId, {state: 'REJECTED', limit: 200});
  const expired = useApprovals(businessId, {state: 'EXPIRED', limit: 200});
  const queries = {PENDING: pending, APPROVED: approved, REJECTED: rejected, EXPIRED: expired};
  const shownQueries = filter === 'all' ? Object.values(queries) : [queries[filter]];

  // A request can move between lists during a refetch. Keep one row per ID.
  const byId = new Map<string, ApprovalRequest>();
  for (const a of shownQueries.flatMap((q) => q.data?.items ?? [])) byId.set(a.id, a);
  const items = sortInbox([...byId.values()]);

  const hasPending = (pending.data?.items.length ?? 0) > 0;
  const now = useNow(hasPending);
  const isLoading = shownQueries.some((q) => q.isPending);
  const failed = shownQueries.find((q) => q.error);
  const pendingCount = pending.data?.items.filter((a) => effectiveState(a, now) === 'PENDING').length ?? 0;

  const hrefFor = (id: string) => `${pathname}?id=${encodeURIComponent(id)}`;
  const closeDialog = () => router.replace(pathname, {scroll: false});

  return (
    <VStack gap={5}>
      <PageHeader
        title="Approvals"
        description="Nothing is charged, sent or booked until you approve the exact request. Requests expire 10 minutes after they arrive."
      />

      {feed.status === 'disconnected' || feed.status === 'unavailable' ? (
        <Text type="supporting">Live updates are off. Reload the page to see new requests.</Text>
      ) : null}

      <MockPanel />

      <TabList value={filter} onChange={(v) => setFilter(v as Filter)} hasDivider>
        {FILTERS.map((f) => (
          <Tab
            key={f.value}
            value={f.value}
            label={f.label}
            endContent={f.value === 'PENDING' && pendingCount > 0 ? <Badge label={String(pendingCount)} variant="warning" /> : undefined}
          />
        ))}
      </TabList>

      {isLoading ? (
        <LoadingState label="Loading approval requests" />
      ) : failed?.error ? (
        <ErrorState
          title="Could not load approval requests"
          message={failed.error.message}
          onRetry={!isApiError(failed.error) || failed.error.retryable ? () => shownQueries.forEach((q) => void q.refetch()) : undefined}
        />
      ) : items.length === 0 ? (
        <EmptyState
          title={filter === 'all' || filter === 'PENDING' ? 'Nothing is waiting for you' : `No ${FILTERS.find((f) => f.value === filter)?.label.toLowerCase()} requests`}
          description="New requests from your phone agent and your own edits appear here as they arrive."
        />
      ) : (
        <List hasDividers>
          {items.map((a) => (
            <InboxRow key={a.id} approval={a} now={now} timeZone={timeZone} href={hrefFor(a.id)} isSelected={a.id === openId} />
          ))}
        </List>
      )}

      {businessId && openId ? (
        <ApprovalDecisionDialog isOpen businessId={businessId} approvalId={openId} onClose={closeDialog} />
      ) : null}
    </VStack>
  );
}

function InboxRow({
  approval,
  now,
  timeZone,
  href,
  isSelected,
}: {
  approval: ApprovalRequest;
  now: number;
  timeZone: string;
  href: string;
  isSelected: boolean;
}) {
  const state = effectiveState(approval, now);
  const view = statusView('approval', state);
  const order = approval.bundleType === 'order_bundle' ? (approval.payload as OrderApprovalPayload) : null;
  return (
    <ListItem
      href={href}
      isSelected={isSelected}
      align="first-line"
      label={
        <Text weight="semibold" maxLines={3}>
          {`${bundleLabel(approval.bundleType)}: ${summaryLine(approval, timeZone)}`}
        </Text>
      }
      description={
        <VStack gap={1}>
          <Text type="supporting">{`${actorLabel(approval.actorType)}, ${formatRelative(approval.createdAt, timeZone, now)}`}</Text>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <StatusBadge label={view.label} tone={view.tone} />
            {state === 'PENDING' ? (
              <Text type="label" hasTabularNumbers>
                {`${formatCountdown(secondsUntil(approval.expiresAt, now))} left`}
              </Text>
            ) : null}
            {order ? (
              <HStack gap={1} vAlign="center">
                <Text hasTabularNumbers weight="semibold">
                  {formatMoney(order.totalMinor, order.currency)}
                </Text>
                <SandboxBadge />
              </HStack>
            ) : null}
          </HStack>
        </VStack>
      }
    />
  );
}

/** Shown only with NEXT_PUBLIC_MOCK=1. Starts scripted calls so a new request arrives live. */
function MockPanel() {
  const controls = useMockControls();
  const {businessId} = useBusiness();
  const [busy, setBusy] = useState(false);
  if (!controls) return null;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card variant="muted">
      <HStack gap={3} vAlign="center" wrap="wrap">
        <Text type="label">Mock controls</Text>
        {businessId === 'biz_barber_01' ? (
          <Button label="Start a booking call" size="sm" isDisabled={busy} onClick={() => void run(() => controls.startBookingCall())} />
        ) : (
          <Button label="Start a pizza call" size="sm" isDisabled={busy} onClick={() => void run(() => controls.startPizzaCall())} />
        )}
        <Text type="supporting">The call ends with a new request in this list. It does not decide anything.</Text>
      </HStack>
    </Card>
  );
}
