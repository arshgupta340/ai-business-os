'use client';

import {createContext, useCallback, useContext, useMemo, useState, type ReactNode} from 'react';
import {isApiError, useBusinesses, type ApiError, type ListBusinessesResponse} from '@/lib/api';
import {isMockMode} from '@/lib/env';
import {useAuth} from './auth';
import {BusinessProvider} from './BusinessProvider';
import {SEEDED_BUSINESSES, type BusinessSummary} from './businesses';
import {businessListStatus, type BusinessListStatus} from './business-list';

/** Maps GET /api/businesses items to the selector's BusinessSummary. A list item carries no contact (contract BusinessSummarySchema). */
export function toBusinessSummaries(items: ListBusinessesResponse['items']): BusinessSummary[] {
  return items.map(({id, name, category, timezone}) => ({id, name, category, timezone}));
}

export type ChooseBusinessesOptions = {
  /**
   * What to show before the API list arrives or when the call failed.
   * "seeded" (mock mode, and the default for older callers) shows the seeded
   * list. "none" (real mode) shows nothing the server has not confirmed.
   */
  fallback?: 'seeded' | 'none';
};

/**
 * The list the selector shows: the API list once it loads. Before that, or
 * when the call failed, the seeded list in mock mode and an empty list in
 * real mode. An empty API list is kept as empty. Businesses the server
 * refused are left out.
 */
export function chooseBusinesses(
  apiItems: ListBusinessesResponse['items'] | undefined,
  forbidden: ReadonlySet<string>,
  {fallback = 'seeded'}: ChooseBusinessesOptions = {},
): readonly BusinessSummary[] {
  const base = apiItems ? toBusinessSummaries(apiItems) : fallback === 'seeded' ? SEEDED_BUSINESSES : [];
  return forbidden.size ? base.filter((b) => !forbidden.has(b.id)) : base;
}

type ForbiddenBusinessesValue = {
  /** Leave a business out of the list after the server answered FORBIDDEN_BUSINESS for it. */
  markForbidden: (businessId: string) => void;
};

const ForbiddenBusinessesContext = createContext<ForbiddenBusinessesValue | null>(null);

/** markForbidden from the nearest ApiBusinessProvider, or null outside one. */
export function useForbiddenBusinesses(): ForbiddenBusinessesValue | null {
  return useContext(ForbiddenBusinessesContext);
}

export type BusinessListValue = {
  status: BusinessListStatus;
  /** The failed GET /api/businesses answer while status is "error". */
  error: ApiError | null;
  /** Asks the server for the list again. */
  retry: () => void;
};

const READY: BusinessListValue = {status: 'ready', error: null, retry: () => {}};

const BusinessListContext = createContext<BusinessListValue>(READY);

/**
 * Where GET /api/businesses stands. Outside an ApiBusinessProvider (a plain
 * BusinessProvider, as in tests) it is always "ready".
 */
export function useBusinessList(): BusinessListValue {
  return useContext(BusinessListContext);
}

/**
 * BusinessProvider fed by useBusinesses(). Must sit inside ApiProvider and
 * AuthProvider. useBusiness() keeps the same fields, default and persistence:
 * BusinessProvider still does the selecting and storing. In real mode the
 * list stays empty (businessId null) until the server answers, so no screen
 * sends a business-scoped call with an id the server never returned.
 */
export function ApiBusinessProvider({children}: {children: ReactNode}) {
  const {status: authStatus} = useAuth();
  const mock = isMockMode();
  const list = useBusinesses({enabled: authStatus === 'signed_in'});
  const [forbidden, setForbidden] = useState<ReadonlySet<string>>(() => new Set());

  const apiItems = authStatus === 'signed_in' && list.data ? list.data.items : undefined;
  const businesses = useMemo(
    () => chooseBusinesses(apiItems, forbidden, {fallback: mock ? 'seeded' : 'none'}),
    [apiItems, forbidden, mock],
  );

  const markForbidden = useCallback((businessId: string) => {
    setForbidden((prev) => (prev.has(businessId) ? prev : new Set([...prev, businessId])));
  }, []);
  const forbiddenValue = useMemo(() => ({markForbidden}), [markForbidden]);

  const {refetch} = list;
  const retry = useCallback(() => void refetch(), [refetch]);
  const status = businessListStatus({
    authStatus,
    mock,
    // A retry after a failure is loading again, not still the old error.
    isPending: list.isPending || (list.isFetching && !list.data),
    hasError: !!list.error,
    apiCount: apiItems?.length,
    visibleCount: businesses.length,
  });
  const error = status === 'error' && isApiError(list.error) ? list.error : null;
  const listValue = useMemo<BusinessListValue>(() => ({status, error, retry}), [status, error, retry]);

  return (
    <ForbiddenBusinessesContext.Provider value={forbiddenValue}>
      <BusinessListContext.Provider value={listValue}>
        <BusinessProvider businesses={businesses}>{children}</BusinessProvider>
      </BusinessListContext.Provider>
    </ForbiddenBusinessesContext.Provider>
  );
}
