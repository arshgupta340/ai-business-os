// @vitest-environment jsdom
import {act, renderHook, waitFor} from '@testing-library/react';
import type {ReactNode} from 'react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {AuthProvider, SUPABASE_CONFIG_ERROR, useAuth} from './AuthProvider';
import {MOCK_SESSION_STORAGE_KEY} from './mock-session';
import {DEMO_OWNER} from './owner';

const wrapper = ({children}: {children: ReactNode}) => <AuthProvider>{children}</AuthProvider>;

afterEach(() => {
  vi.unstubAllEnvs();
  window.localStorage.clear();
});

describe('useAuth in mock mode', () => {
  it('signs in the demo owner and keeps the session in localStorage', async () => {
    vi.stubEnv('NEXT_PUBLIC_MOCK', '1');
    const {result} = renderHook(() => useAuth(), {wrapper});
    await waitFor(() => expect(result.current.status).toBe('signed_out'));
    expect(result.current.isMock).toBe(true);

    let outcome: Awaited<ReturnType<typeof result.current.signIn>> | undefined;
    await act(async () => {
      outcome = await result.current.signIn('', '');
    });
    expect(outcome).toEqual({ok: true});
    expect(result.current.status).toBe('signed_in');
    expect(result.current.owner).toEqual(DEMO_OWNER);
    expect(window.localStorage.getItem(MOCK_SESSION_STORAGE_KEY)).not.toBeNull();

    await act(async () => {
      await result.current.signOut();
    });
    expect(result.current.status).toBe('signed_out');
    expect(window.localStorage.getItem(MOCK_SESSION_STORAGE_KEY)).toBeNull();
  });

  it('restores a stored mock session', async () => {
    vi.stubEnv('NEXT_PUBLIC_MOCK', '1');
    window.localStorage.setItem(MOCK_SESSION_STORAGE_KEY, JSON.stringify({owner: DEMO_OWNER}));
    const {result} = renderHook(() => useAuth(), {wrapper});
    await waitFor(() => expect(result.current.status).toBe('signed_in'));
    expect(result.current.owner?.displayName).toBe('Demo Owner');
  });
});

describe('useAuth without mock mode or Supabase values', () => {
  it('reports a configuration error and does not crash', async () => {
    vi.stubEnv('NEXT_PUBLIC_MOCK', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
    const {result} = renderHook(() => useAuth(), {wrapper});
    await waitFor(() => expect(result.current.status).toBe('signed_out'));
    expect(result.current.configError).toBe(SUPABASE_CONFIG_ERROR);
    let outcome: Awaited<ReturnType<typeof result.current.signIn>> | undefined;
    await act(async () => {
      outcome = await result.current.signIn('owner@example.com', 'x');
    });
    expect(outcome).toEqual({ok: false, message: SUPABASE_CONFIG_ERROR});
  });
});
