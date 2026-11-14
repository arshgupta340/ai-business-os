import {readItem, writeItem, type KeyValueStorage} from '@/lib/storage';
import type {BusinessSummary} from './businesses';

export const BUSINESS_STORAGE_KEY = 'abos.selectedBusinessId';

/**
 * Picks the business to show. A stored ID wins only if it is still in the
 * list. Otherwise the default wins if present, then the first business.
 */
export function resolveBusinessId(
  businesses: readonly BusinessSummary[],
  storedId: string | null,
  defaultId: string,
): string | null {
  if (storedId && businesses.some((b) => b.id === storedId)) {
    return storedId;
  }
  if (businesses.some((b) => b.id === defaultId)) {
    return defaultId;
  }
  return businesses[0]?.id ?? null;
}

export function readStoredBusinessId(storage: KeyValueStorage | null): string | null {
  return readItem(storage, BUSINESS_STORAGE_KEY);
}

export function storeBusinessId(storage: KeyValueStorage | null, businessId: string): void {
  writeItem(storage, BUSINESS_STORAGE_KEY, businessId);
}
