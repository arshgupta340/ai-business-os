/**
 * Per-viewer conveniences kept in localStorage: which builder session each
 * business last used, and the notes from each session's turns. Nothing here is
 * a source of truth. The session itself always comes from the server.
 */
import {getBrowserStorage, readItem, removeItem, writeItem, type KeyValueStorage} from '@/lib/storage';
import {EMPTY_NOTES, parseNotes, type TurnNotes} from './spec';

export const SESSIONS_KEY = 'abos.builderSessions';
export const notesKey = (sessionId: string) => `abos.builderNotes.${sessionId}`;

type SessionMap = Record<string, string>;

function readMap(storage: KeyValueStorage | null): SessionMap {
  const raw = readItem(storage, SESSIONS_KEY);
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object') return {};
    return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'string')) as SessionMap;
  } catch {
    return {};
  }
}

export function rememberedSession(businessId: string, storage = getBrowserStorage()): string | null {
  return readMap(storage)[businessId] ?? null;
}

/** The business a remembered session belongs to, or null when the session is not remembered. */
export function businessOfSession(sessionId: string, storage = getBrowserStorage()): string | null {
  const entry = Object.entries(readMap(storage)).find(([, id]) => id === sessionId);
  return entry ? entry[0] : null;
}

export function rememberSession(businessId: string, sessionId: string, storage = getBrowserStorage()): void {
  writeItem(storage, SESSIONS_KEY, JSON.stringify({...readMap(storage), [businessId]: sessionId}));
}

export function forgetSession(sessionId: string, storage = getBrowserStorage()): void {
  const map = readMap(storage);
  const next = Object.fromEntries(Object.entries(map).filter(([, id]) => id !== sessionId));
  writeItem(storage, SESSIONS_KEY, JSON.stringify(next));
  removeItem(storage, notesKey(sessionId));
}

export function readNotes(sessionId: string | null, storage = getBrowserStorage()): TurnNotes {
  if (!sessionId) return EMPTY_NOTES;
  return parseNotes(readItem(storage, notesKey(sessionId)));
}

export function writeNotes(sessionId: string, notes: TurnNotes, storage = getBrowserStorage()): void {
  writeItem(storage, notesKey(sessionId), JSON.stringify(notes));
}
