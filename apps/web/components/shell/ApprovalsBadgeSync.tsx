'use client';

import {useEffect} from 'react';
import {useActivityFeed, useApprovals} from '@/lib/api';
import {useBusiness} from '@/lib/session';
import {useAuth} from '@/lib/session/auth';
import {useShellBadges} from './ShellBadgesContext';

/** Same query as the Approvals inbox, so both read one cache entry. */
const PENDING_QUERY = {state: 'PENDING', limit: 200} as const;

/**
 * Keeps the sidebar Approvals count equal to the pending approvals of the
 * selected business, on every screen. Renders nothing. It subscribes to the
 * activity feed, so a new or decided request updates the count without a reload.
 */
export function ApprovalsBadgeSync() {
  const {status} = useAuth();
  const {businessId} = useBusiness();
  const activeId = status === 'signed_in' ? businessId : null;
  const {setPendingApprovalsCount} = useShellBadges();

  useActivityFeed(activeId);
  const pending = useApprovals(activeId, PENDING_QUERY);
  const count = activeId && pending.data ? pending.data.items.filter((a) => a.state === 'PENDING').length : null;

  useEffect(() => {
    setPendingApprovalsCount(count);
  }, [count, setPendingApprovalsCount]);

  useEffect(() => () => setPendingApprovalsCount(null), [setPendingApprovalsCount]);

  return null;
}
