'use client';

import {useCallback, useSyncExternalStore} from 'react';
import {useQueryClient, type Query} from '@tanstack/react-query';
import {Button} from '@astryxdesign/core/Button';
import {HStack} from '@astryxdesign/core/HStack';
import {Icon} from '@astryxdesign/core/Icon';
import {Text} from '@astryxdesign/core/Text';
import {queryKeys} from '@/lib/api/query-keys';

export const REFRESH_FAILED_TEXT = 'Could not refresh. Showing the last data we have.';

/**
 * A query on screen whose last refetch failed while its old data is still
 * shown: it is in use, it is in error, and it still has data. Only the
 * selected business's queries and the owner's live agent count.
 */
export function isStaleAfterFailedRefetch(query: Query, businessId: string): boolean {
  if (query.getObserversCount() === 0) return false;
  if (query.state.status !== 'error' || query.state.data === undefined) return false;
  const key = query.queryKey;
  const live = queryKeys.liveAgent();
  if (key.length === live.length && key.every((part, i) => part === live[i])) return true;
  return key[0] === 'api' && key[1] === 'biz' && key[2] === businessId;
}

/**
 * One line under the page header when a background refetch failed and the
 * screen still shows the last data it had. "Try again" refetches the failed
 * queries. Renders nothing otherwise.
 */
export function RefreshFailedNotice({businessId}: {businessId: string}) {
  const client = useQueryClient();
  const cache = client.getQueryCache();
  const subscribe = useCallback((onChange: () => void) => cache.subscribe(onChange), [cache]);
  const hasStale = useSyncExternalStore(
    subscribe,
    () => cache.getAll().some((q) => isStaleAfterFailedRefetch(q, businessId)),
    () => false,
  );
  if (!hasStale) return null;
  const retry = () => void client.refetchQueries({predicate: (q) => isStaleAfterFailedRefetch(q, businessId)});
  return (
    <HStack gap={2} vAlign="center" wrap="wrap">
      <Icon icon="warning" color="warning" />
      <Text type="supporting">{REFRESH_FAILED_TEXT}</Text>
      <Button label="Try again" variant="ghost" size="sm" onClick={retry} />
    </HStack>
  );
}
