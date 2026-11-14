'use client';

import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Grid} from '@astryxdesign/core/Grid';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {List, ListItem} from '@astryxdesign/core/List';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {LoadingState} from '@/components/LoadingState';
import {StatusBadge} from '@/components/StatusBadge';
import {useApprovals, useCalls} from '@/lib/api';
import {formatTime} from '@/lib/format';
import {statusView} from '@/lib/status';
import {BlockError} from './BlockError';
import {callTitle, callsSince, startOfTodayUtc, summarizeCalls} from './overview-logic';

const LIST_LIMIT = 200;

function CallsTile({businessId, timeZone}: {businessId: string; timeZone: string}) {
  // Local midnight in the business time zone. It is the same value all day,
  // so the query key only changes when the day changes.
  const since = startOfTodayUtc(timeZone);
  const calls = useCalls(businessId, {since, limit: LIST_LIMIT});

  let body;
  if (calls.isPending) {
    body = <LoadingState label="Loading calls" />;
  } else if (calls.error) {
    body = <BlockError title="Could not load calls" error={calls.error} onRetry={() => void calls.refetch()} />;
  } else {
    const summary = summarizeCalls(calls.data.items, since);
    const recent = callsSince(calls.data.items, since).slice(0, 4);
    const notes: string[] = [];
    if (summary.inProgress) notes.push(`${summary.inProgress} in progress`);
    if (summary.lost) notes.push(`${summary.lost} lost`);
    if (summary.failed) notes.push(`${summary.failed} failed`);
    if (summary.simulated) notes.push(`${summary.simulated} simulated`);
    body = (
      <VStack gap={3}>
        <HStack gap={2} vAlign="end">
          <Text type="display-2" id="overview-calls-today-count" hasTabularNumbers>
            {summary.total}
          </Text>
          <Text type="supporting">{calls.data.nextCursor ? 'or more calls' : summary.total === 1 ? 'call' : 'calls'}</Text>
        </HStack>
        {notes.length ? <Text type="supporting">{notes.join(', ')}</Text> : null}
        {recent.length === 0 ? (
          <Text type="supporting">No calls yet today.</Text>
        ) : (
          <List density="compact" hasDividers edge="bleed">
            {recent.map((call) => {
              const view = statusView('call', call.status);
              return (
                <ListItem
                  key={call.id}
                  label={callTitle(call)}
                  description={formatTime(call.startedAt, timeZone)}
                  endContent={<StatusBadge label={view.label} tone={view.tone} />}
                />
              );
            })}
          </List>
        )}
      </VStack>
    );
  }

  return (
    <Card>
      <VStack gap={3}>
        <Heading level={3}>Calls today</Heading>
        {body}
      </VStack>
    </Card>
  );
}

function ApprovalsTile({businessId}: {businessId: string}) {
  const approvals = useApprovals(businessId, {state: 'PENDING', limit: LIST_LIMIT});

  let body;
  if (approvals.isPending) {
    body = <LoadingState label="Loading approvals" />;
  } else if (approvals.error) {
    body = (
      <BlockError title="Could not load approvals" error={approvals.error} onRetry={() => void approvals.refetch()} />
    );
  } else {
    const count = approvals.data.items.length;
    const more = Boolean(approvals.data.nextCursor);
    const view = statusView('approval', 'PENDING');
    body = (
      <VStack gap={3}>
        <HStack gap={2} vAlign="end">
          <Text type="display-2" id="overview-pending-approvals-count" hasTabularNumbers>
            {more ? `${count}+` : String(count)}
          </Text>
          {count > 0 ? <StatusBadge label={view.label} tone={view.tone} /> : null}
        </HStack>
        <Text type="supporting">
          {count === 0
            ? 'Nothing is waiting for you. Every order, booking and fact change needs your approval first.'
            : 'Nothing runs until you approve the exact details.'}
        </Text>
        <HStack>
          <Button label="Open approvals" href="/approvals" variant={count > 0 ? 'primary' : 'secondary'} />
        </HStack>
      </VStack>
    );
  }

  return (
    <Card>
      <VStack gap={3}>
        <Heading level={3}>Waiting for your approval</Heading>
        {body}
      </VStack>
    </Card>
  );
}

export function TodaySection({businessId, timeZone}: {businessId: string; timeZone: string}) {
  return (
    <Grid columns={{minWidth: 280, max: 2}} gap={4} align="start">
      <ApprovalsTile businessId={businessId} />
      <CallsTile businessId={businessId} timeZone={timeZone} />
    </Grid>
  );
}
