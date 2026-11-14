'use client';

import {List, ListItem} from '@astryxdesign/core/List';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {EmptyState} from '@/components/EmptyState';
import {LoadingState} from '@/components/LoadingState';
import {useActivity, useFacts, type ActivityEventType, type BusinessFact} from '@/lib/api';
import {formatDateTime} from '@/lib/format';
import {changeLogEntries} from '../_lib/settings-model';
import {RequestError} from './RequestError';

const CHANGE_TYPES: ActivityEventType[] = ['fact.changed'];

/**
 * Recent fact.changed events, newest first. The activity list is refetched on
 * every live event (useActivityFeed, mounted by the screen), so a confirmed
 * edit shows up here without a reload.
 */
export function ChangeLog({businessId, timezone, facts}: {businessId: string; timezone: string; facts: readonly BusinessFact[]}) {
  const activity = useActivity(businessId, {types: CHANGE_TYPES, limit: 20});
  // Replaced rows hold the "before" values.
  const replaced = useFacts(businessId, {status: 'superseded'});

  if (activity.isPending) return <LoadingState label="Loading the change log" />;
  if (activity.error) {
    return <RequestError title="The change log could not be loaded" error={activity.error} onRetry={() => void activity.refetch()} />;
  }
  const entries = changeLogEntries(activity.data.items, [...facts, ...(replaced.data?.items ?? [])]);
  if (!entries.length) {
    return <EmptyState title="No changes yet" description="Changes you confirm to hours and policies appear here." headingLevel={3} />;
  }
  return (
    <List>
      {entries.map((entry) => (
        <ListItem
          key={entry.id}
          align="start"
          label={<Text weight="medium">{entry.what}</Text>}
          description={
            <VStack gap={0.5}>
              {entry.before !== undefined && entry.after !== undefined ? (
                <Text>{`From ${entry.before}, to ${entry.after}`}</Text>
              ) : entry.after !== undefined ? (
                <Text>{`Now ${entry.after}`}</Text>
              ) : null}
              <Text type="supporting">{[entry.versions, `Changed by ${entry.who.startsWith('You') ? `you${entry.who.slice(3)}` : entry.who}`, formatDateTime(entry.occurredAt, timezone)].filter(Boolean).join('. ')}</Text>
            </VStack>
          }
        />
      ))}
    </List>
  );
}
