'use client';

import type {ReactNode} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {EmptyState} from '@/components/EmptyState';
import {ErrorState} from '@/components/ErrorState';
import {LoadingState} from '@/components/LoadingState';
import {useBusinessList, type BusinessListValue} from './ApiBusinessProvider';
import type {BusinessListStatus} from './business-list';

/** Owner-facing text for the selector itself, for each list state. */
export function businessSelectorPlaceholder(status: BusinessListStatus): string | undefined {
  switch (status) {
    case 'loading':
      return 'Loading businesses';
    case 'error':
      return 'Businesses did not load';
    case 'empty':
      return 'No business yet';
    case 'no_access':
      return 'No business you can open';
    default:
      return undefined;
  }
}

export function BusinessListNotice({list}: {list: BusinessListValue}) {
  switch (list.status) {
    case 'loading':
      return <LoadingState label="Loading your businesses" />;
    case 'error':
      return (
        <ErrorState
          title="Your businesses did not load"
          message={list.error?.message || 'The server did not answer.'}
          onRetry={list.retry}
        />
      );
    case 'empty':
      return (
        <EmptyState
          headingLevel={1}
          title="This account has no business yet"
          description="The server has no business for this account. When one is added, it shows here."
          actions={<Button label="Check again" onClick={list.retry} />}
        />
      );
    case 'no_access':
      return (
        <EmptyState
          headingLevel={1}
          title="No business you can open"
          description="The server refused access to every business on this account."
          actions={<Button label="Check again" onClick={list.retry} />}
        />
      );
    default:
      return null;
  }
}

/**
 * Renders the page only once the server has confirmed at least one business.
 * Otherwise it shows the loading, error or empty state, so no screen mounts
 * without a business. Mount it around the dashboard content.
 */
export function BusinessListGate({children}: {children: ReactNode}) {
  const list = useBusinessList();
  if (list.status === 'ready' || list.status === 'signed_out') return <>{children}</>;
  return <BusinessListNotice list={list} />;
}
