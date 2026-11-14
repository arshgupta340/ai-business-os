import {removeItem, type KeyValueStorage} from '@/lib/storage';
import {BUSINESS_STORAGE_KEY} from './business-selection';

/**
 * localStorage keys that hold one owner's data. They are removed when the
 * owner signs out or a different owner signs in, so the next owner on the
 * same browser starts clean.
 *
 * The builder keys are written by app/(dashboard)/build/_lib/memory.ts
 * (SESSIONS_KEY and notesKey). Keep these in step with that file.
 */
export const OWNER_STORAGE_KEYS = [BUSINESS_STORAGE_KEY, 'abos.builderSessions'] as const;
export const OWNER_STORAGE_PREFIXES = ['abos.builderNotes.'] as const;

/**
 * Removes every owner-scoped key. The mock session and the sign-in notice
 * stay: the first belongs to whoever is signed in now, and the second must
 * survive the move to /sign-in.
 */
export function clearOwnerStorage(storage: (KeyValueStorage & Partial<Pick<Storage, 'key' | 'length'>>) | null): void {
  if (!storage) return;
  for (const key of OWNER_STORAGE_KEYS) removeItem(storage, key);
  let keys: string[] = [];
  try {
    const length = storage.length ?? 0;
    for (let i = 0; i < length; i += 1) {
      const key = storage.key?.(i);
      if (key) keys.push(key);
    }
  } catch {
    keys = [];
  }
  for (const key of keys) {
    if (OWNER_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))) removeItem(storage, key);
  }
}
