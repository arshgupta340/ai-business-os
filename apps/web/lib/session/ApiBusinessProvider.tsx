'use client';

import {createContext, useCallback, useContext, useMemo, useState, type ReactNode} from 'react';
import {useBusinesses, type BusinessListItem} from '@/lib/api';
import {useAuth} from './auth';
import {BusinessProvider} from './BusinessProvider';
import {SEEDED_BUSINESSES, type BusinessSummary} from './businesses';

/** Maps GET /api/businesses items to the selector's BusinessSummary. Only fields the API returned are kept. */
export function toBusinessSummaries(items: readonly BusinessListItem[]): BusinessSummary[] {
  return items.map(({id, name, category, timezone, contact}) => (contact ? {id, name, category, timezone, contact} : {id, name, category, timezone}));
}

/**
 * The list the selector shows: the API list once it loads, otherwise the
 * seeded list (while loading, signed out, or when the call failed). An empty
 * API list is kept as empty. Businesses the server refused are left out.
 */
export function chooseBusinesses(
  apiItems: readonly BusinessListItem[] | undefined,
  forbidden: ReadonlySet<string>,
): readonly BusinessSummary[] {
  const base = apiItems ? toBusinessSummaries(apiItems) : SEEDED_BUSINESSES;
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

/**
 * BusinessProvider fed by useBusinesses(). Must sit inside ApiProvider and
 * AuthProvider. useBusiness() keeps the same fields, default and persistence:
 * BusinessProvider still does the selecting and storing.
 */
export function ApiBusinessProvider({children}: {children: ReactNode}) {
  const {status} = useAuth();
  const list = useBusinesses({enabled: status === 'signed_in'});
  const [forbidden, setForbidden] = useState<ReadonlySet<string>>(() => new Set());

  const apiItems = status === 'signed_in' && list.data ? list.data.items : undefined;
  const businesses = useMemo(() => chooseBusinesses(apiItems, forbidden), [apiItems, forbidden]);

  const markForbidden = useCallback((businessId: string) => {
    setForbidden((prev) => (prev.has(businessId) ? prev : new Set([...prev, businessId])));
  }, []);
  const value = useMemo(() => ({markForbidden}), [markForbidden]);

  return (
    <ForbiddenBusinessesContext.Provider value={value}>
      <BusinessProvider businesses={businesses}>{children}</BusinessProvider>
    </ForbiddenBusinessesContext.Provider>
  );
}
