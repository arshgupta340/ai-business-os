import {readItem, removeItem, writeItem, type KeyValueStorage} from '@/lib/storage';
import type {Owner} from './owner';

export const MOCK_SESSION_STORAGE_KEY = 'abos.mockSession';

type StoredMockSession = {owner: Owner};

/** Reads the mock session. Returns null if absent or malformed. */
export function readMockSession(storage: KeyValueStorage | null): Owner | null {
  const raw = readItem(storage, MOCK_SESSION_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredMockSession> | null;
    const owner = parsed?.owner;
    if (owner && typeof owner.email === 'string' && typeof owner.displayName === 'string') {
      return {email: owner.email, displayName: owner.displayName};
    }
    return null;
  } catch {
    return null;
  }
}

export function writeMockSession(storage: KeyValueStorage | null, owner: Owner): void {
  const value: StoredMockSession = {owner};
  writeItem(storage, MOCK_SESSION_STORAGE_KEY, JSON.stringify(value));
}

export function clearMockSession(storage: KeyValueStorage | null): void {
  removeItem(storage, MOCK_SESSION_STORAGE_KEY);
}
