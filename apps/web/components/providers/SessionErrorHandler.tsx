'use client';

import {useEffect, useRef} from 'react';
import {useRouter} from 'next/navigation';
import {useQueryClient} from '@tanstack/react-query';
import {queryKeys, subscribeApiErrors} from '@/lib/api';
import {
  SESSION_ENDED_NOTICE,
  getSessionStorage,
  useBusiness,
  useForbiddenBusinesses,
  writeSignInNotice,
} from '@/lib/session';
import {useAuth} from '@/lib/session/auth';

/**
 * Handles two API answers once, for every screen. Renders nothing.
 *
 * - UNAUTHENTICATED: sign out, clear cached data, and go to /sign-in, which
 *   shows a short notice.
 * - FORBIDDEN_BUSINESS: leave that business out of the selector and select
 *   one the owner has. The businesses list is refetched.
 *
 * Mount it inside ApiProvider and ApiBusinessProvider.
 */
export function SessionErrorHandler() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const {status, signOut} = useAuth();
  const {businesses, businessId, setBusinessId} = useBusiness();
  const forbidden = useForbiddenBusinesses();

  // Read the latest values from the listener without resubscribing.
  const latest = useRef({status, signOut, businesses, businessId, setBusinessId, forbidden});
  latest.current = {status, signOut, businesses, businessId, setBusinessId, forbidden};
  const signingOut = useRef(false);

  useEffect(() => {
    if (status === 'signed_in') signingOut.current = false;
  }, [status]);

  useEffect(
    () =>
      subscribeApiErrors(({error, businessId: failedId}) => {
        const now = latest.current;
        if (now.status !== 'signed_in') return;

        if (error.code === 'UNAUTHENTICATED') {
          if (signingOut.current) return;
          signingOut.current = true;
          writeSignInNotice(getSessionStorage(), SESSION_ENDED_NOTICE);
          void now.signOut().then(() => {
            queryClient.clear();
            router.replace('/sign-in');
          });
          return;
        }

        if (error.code === 'FORBIDDEN_BUSINESS') {
          const refused = failedId ?? now.businessId;
          if (!refused) return;
          now.forbidden?.markForbidden(refused);
          if (refused === now.businessId) {
            const next = now.businesses.find((b) => b.id !== refused);
            if (next) now.setBusinessId(next.id);
          }
          void queryClient.invalidateQueries({queryKey: queryKeys.businesses()});
        }
      }),
    [queryClient, router],
  );

  return null;
}
