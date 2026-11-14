import {readItem, removeItem, writeItem, type KeyValueStorage} from '@/lib/storage';

/** A short message for the sign-in page, kept in sessionStorage across the redirect. */
export const SIGN_IN_NOTICE_STORAGE_KEY = 'abos.signInNotice';

export const SESSION_ENDED_NOTICE = 'Your session ended. Sign in again to continue.';

export function getSessionStorage(): KeyValueStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function writeSignInNotice(storage: KeyValueStorage | null, notice: string): void {
  writeItem(storage, SIGN_IN_NOTICE_STORAGE_KEY, notice);
}

/** Reads the notice and removes it, so it shows once. */
export function takeSignInNotice(storage: KeyValueStorage | null): string | null {
  const notice = readItem(storage, SIGN_IN_NOTICE_STORAGE_KEY);
  if (notice !== null) removeItem(storage, SIGN_IN_NOTICE_STORAGE_KEY);
  return notice;
}
