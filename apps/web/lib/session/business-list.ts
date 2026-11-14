import type {AuthStatus} from './auth';

/**
 * Where the owner's list of businesses stands. In real mode the selector and
 * every screen wait for GET /api/businesses; nothing is shown that the server
 * has not confirmed.
 *
 * - ready: the list is there and has at least one business.
 * - loading: the first answer has not arrived.
 * - error: the call failed and there is no list to show.
 * - empty: the server answered with no business for this account.
 * - no_access: the server listed businesses, but refused every one of them.
 * - signed_out: no owner is signed in, so the list is not asked for.
 */
export type BusinessListStatus = 'ready' | 'loading' | 'error' | 'empty' | 'no_access' | 'signed_out';

export type BusinessListInput = {
  authStatus: AuthStatus;
  /** True with NEXT_PUBLIC_MOCK=1. Mock mode keeps the seeded list while loading or after a failure. */
  mock: boolean;
  isPending: boolean;
  hasError: boolean;
  /** Number of items the server returned, or undefined before any answer. */
  apiCount: number | undefined;
  /** Number of businesses left after the ones the server refused. */
  visibleCount: number;
};

export function businessListStatus({authStatus, mock, isPending, hasError, apiCount, visibleCount}: BusinessListInput): BusinessListStatus {
  if (mock) {
    // Today's mock behavior: the seeded list stands in until the API list arrives.
    if (apiCount === 0) return 'empty';
    if (visibleCount === 0) return apiCount === undefined ? 'empty' : 'no_access';
    return 'ready';
  }
  if (authStatus !== 'signed_in') return 'signed_out';
  // No answer yet: a failed call is an error once React Query stops retrying.
  // Anything else (pending, or not started) is still loading.
  if (apiCount === undefined) return hasError && !isPending ? 'error' : 'loading';
  if (apiCount === 0) return 'empty';
  if (visibleCount === 0) return 'no_access';
  return 'ready';
}
