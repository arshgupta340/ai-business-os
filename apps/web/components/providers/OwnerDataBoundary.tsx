'use client';

import {Fragment, useEffect, useState, type ReactNode} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {clearOwnerStorage} from '@/lib/session/owner-storage';
import {useAuth} from '@/lib/session/auth';
import {getBrowserStorage} from '@/lib/storage';

/**
 * Keeps one owner's data away from the next owner on the same browser.
 *
 * When auth leaves signed_in (the Sign out button, a sign-out in another
 * tab, a failed token refresh, SessionErrorHandler) or the signed-in owner's
 * id changes, it clears the React Query cache, removes the owner-scoped
 * localStorage keys, and remounts everything below it. The remount drops
 * component state that holds owner data: the forbidden businesses set, the
 * selected business, activity feed events and their realtime channels, and
 * the shell badges.
 *
 * It does nothing on the first render or on loading to signed_in, and a
 * token refresh that keeps the same owner id changes nothing.
 *
 * When a different owner signs in without a sign-out in between, it renders
 * nothing until the cache is cleared, so no screen shows the old owner's
 * cached data under the new owner. Mount it once, inside ApiProvider.
 */
export function OwnerDataBoundary({children}: {children: ReactNode}) {
  const queryClient = useQueryClient();
  const {status, owner} = useAuth();
  const signedInId = status === 'signed_in' && owner ? owner.id : null;

  // The owner whose data the cache and the tree below may hold. Null when it holds nobody's.
  const [holder, setHolder] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (signedInId === holder) return;
    if (holder === null) {
      // Signed in from loading or signed_out. The cache holds nobody's data yet.
      setHolder(signedInId);
      return;
    }
    queryClient.clear();
    clearOwnerStorage(getBrowserStorage());
    setHolder(signedInId);
    setGeneration((g) => g + 1);
  }, [signedInId, holder, queryClient]);

  const switchingOwner = signedInId !== null && holder !== null && signedInId !== holder;
  if (switchingOwner) return null;

  return <Fragment key={generation}>{children}</Fragment>;
}
