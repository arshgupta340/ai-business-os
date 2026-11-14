'use client';

import {createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode} from 'react';
import {getBrowserStorage} from '@/lib/storage';
import {DEFAULT_BUSINESS_ID, SEEDED_BUSINESSES, type BusinessSummary} from './businesses';
import {readStoredBusinessId, resolveBusinessId, storeBusinessId} from './business-selection';

export type BusinessContextValue = {
  businesses: readonly BusinessSummary[];
  business: BusinessSummary | null;
  businessId: string | null;
  setBusinessId: (businessId: string) => void;
};

const BusinessContext = createContext<BusinessContextValue | null>(null);

type BusinessProviderProps = {
  children: ReactNode;
  /** Defaults to the seeded list. A later task passes the API result. */
  businesses?: readonly BusinessSummary[];
};

export function BusinessProvider({children, businesses = SEEDED_BUSINESSES}: BusinessProviderProps) {
  // The first render uses the default so server and client HTML match.
  // The stored choice is applied after mount.
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    resolveBusinessId(businesses, null, DEFAULT_BUSINESS_ID),
  );

  useEffect(() => {
    const stored = readStoredBusinessId(getBrowserStorage());
    setSelectedId(resolveBusinessId(businesses, stored, DEFAULT_BUSINESS_ID));
  }, [businesses]);

  const setBusinessId = useCallback(
    (businessId: string) => {
      if (!businesses.some((b) => b.id === businessId)) {
        return;
      }
      setSelectedId(businessId);
      storeBusinessId(getBrowserStorage(), businessId);
    },
    [businesses],
  );

  const value = useMemo<BusinessContextValue>(() => {
    const business = businesses.find((b) => b.id === selectedId) ?? null;
    return {businesses, business, businessId: business?.id ?? null, setBusinessId};
  }, [businesses, selectedId, setBusinessId]);

  return <BusinessContext.Provider value={value}>{children}</BusinessContext.Provider>;
}

export function useBusiness(): BusinessContextValue {
  const value = useContext(BusinessContext);
  if (!value) {
    throw new Error('useBusiness must be used inside BusinessProvider.');
  }
  return value;
}
