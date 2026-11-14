import {afterEach, describe, expect, it, vi} from 'vitest';
import type {KeyValueStorage} from '@/lib/storage';
import {getSupabaseBrowserClient} from '@/lib/supabase/client';
import {clearMockSession, MOCK_SESSION_STORAGE_KEY, readMockSession, writeMockSession} from './mock-session';
import {DEMO_OWNER} from './owner';
import {getAccessToken, MOCK_ACCESS_TOKEN} from './token';

function memoryStorage(): KeyValueStorage & {data: Map<string, string>} {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('mock session storage', () => {
  it('writes, reads and clears the demo owner', () => {
    const storage = memoryStorage();
    expect(readMockSession(storage)).toBeNull();
    writeMockSession(storage, DEMO_OWNER);
    expect(readMockSession(storage)).toEqual(DEMO_OWNER);
    clearMockSession(storage);
    expect(readMockSession(storage)).toBeNull();
  });

  it('treats malformed data as signed out', () => {
    const storage = memoryStorage();
    storage.setItem(MOCK_SESSION_STORAGE_KEY, '{not json');
    expect(readMockSession(storage)).toBeNull();
    storage.setItem(MOCK_SESSION_STORAGE_KEY, JSON.stringify({owner: {email: 1}}));
    expect(readMockSession(storage)).toBeNull();
  });
});

describe('getAccessToken', () => {
  it('returns the fixed mock token in mock mode', async () => {
    vi.stubEnv('NEXT_PUBLIC_MOCK', '1');
    await expect(getAccessToken()).resolves.toBe(MOCK_ACCESS_TOKEN);
    expect(MOCK_ACCESS_TOKEN).toBe('mock-token');
  });

  it('returns null outside mock mode when Supabase is not configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_MOCK', '0');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
    expect(getSupabaseBrowserClient()).toBeNull();
    await expect(getAccessToken()).resolves.toBeNull();
  });
});
