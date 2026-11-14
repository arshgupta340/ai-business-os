'use client';

import {createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode} from 'react';
import {getBrowserStorage} from '@/lib/storage';
import {DEFAULT_BUSINESS_ID, SEEDED_BUSINESSES, type BusinessSummary} from './businesses';
import {readStoredBusinessId, resolveBusinessId, storeBusinessId} from './business-selection';

export type BusinessContextValue = {
  businesses: readonly BusinessSummary[];
  business: BusinessSummary | null;
  businessId: string | null;
  /**
   * False until the stored selection has been read after mount. Until then
   * businessId is null, so no business-scoped call goes out with the default
   * before the stored business is known.
   */
  isReady: boolean;
  setBusinessId: (businessId: string) => void;
};

const BusinessContext = createContext<BusinessContextValue | null>(null);

type BusinessProviderProps = {
  children: ReactNode;
  /** Defaults to the seeded list. A later task passes the API result. */
  businesses?: readonly BusinessSummary[];
};

export function BusinessProvider({children, businesses = SEEDED_BUSINESSES}: BusinessProviderProps) {
  // Server HTML and the first client render have no business, so they match.
  // localStorage is read after mount; only then is a business selected.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const stored = readStoredBusinessId(getBrowserStorage());
    setSelectedId(resolveBusinessId(businesses, stored, DEFAULT_BUSINESS_ID));
    setIsReady(true);
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
    const business = (isReady && businesses.find((b) => b.id === selectedId)) || null;
    return {businesses, business, businessId: business?.id ?? null, isReady, setBusinessId};
  }, [businesses, selectedId, isReady, setBusinessId]);

  return <BusinessContext.Provider value={value}>{children}</BusinessContext.Provider>;
}

export function useBusiness(): BusinessContextValue {
  const value = useContext(BusinessContext);
  if (!value) {
    throw new Error('useBusiness must be used inside BusinessProvider.');
  }
  return value;
}
