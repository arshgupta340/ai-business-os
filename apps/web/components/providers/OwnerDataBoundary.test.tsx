// @vitest-environment jsdom
import {act, cleanup, render, screen, waitFor} from '@testing-library/react';
import {http, HttpResponse} from 'msw';
import {useEffect, useState, type ReactNode} from 'react';
import {QueryClientProvider, type QueryClient} from '@tanstack/react-query';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {queryKeys, useCatalog} from '@/lib/api';
import {createApiQueryClient} from '@/lib/api/provider';
import {ApiBusinessProvider, SESSION_ENDED_NOTICE, SIGN_IN_NOTICE_STORAGE_KEY, useBusiness} from '@/lib/session';
import {AuthProvider, DEMO_OWNER, useAuth} from '@/lib/session/auth';
import {MOCK_SESSION_STORAGE_KEY} from '@/lib/session/auth/mock-session';
import {BUSINESS_STORAGE_KEY} from '@/lib/session/business-selection';
import {server} from '@/mocks/server';
import {TEST_BASE_URL, useMockServer} from '@/mocks/test-setup';
import {OwnerDataBoundary} from './OwnerDataBoundary';
import {SessionErrorHandler} from './SessionErrorHandler';

const router = vi.hoisted(() => ({replace: vi.fn(), push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn()}));
vi.mock('next/navigation', () => ({useRouter: () => router, usePathname: () => '/overview'}));

type FakeUser = {id: string; email: string; user_metadata: Record<string, unknown>};
type AuthListener = (event: string, session: {user: FakeUser; access_token: string} | null) => void;

// A stand-in for the Supabase browser client: one stored session and the auth state listeners.
const supa = vi.hoisted(() => {
  const state = {
    session: null as {user: FakeUser; access_token: string} | null,
    listeners: new Set<AuthListener>(),
  };
  const client = {
    auth: {
      getSession: async () => ({data: {session: state.session}}),
      onAuthStateChange: (listener: AuthListener) => {
        state.listeners.add(listener);
        return {data: {subscription: {unsubscribe: () => state.listeners.delete(listener)}}};
      },
      signOut: async () => {
        state.session = null;
        return {error: null};
      },
      signInWithPassword: async () => ({data: {user: state.session?.user ?? null}, error: null}),
    },
  };
  return {state, client};
});
vi.mock('@/lib/supabase/client', () => ({getSupabaseBrowserClient: () => supa.client}));

useMockServer();

const A = `${TEST_BASE_URL}/api`;
const OWNER_A: FakeUser = {id: 'usr_owner_a', email: 'a@example.com', user_metadata: {display_name: 'Owner A'}};
const OWNER_B: FakeUser = {id: 'usr_owner_b', email: 'b@example.com', user_metadata: {display_name: 'Owner B'}};

const BIZ_A = {id: 'biz_pizza_01', name: 'Demo Pizza Co.', category: 'restaurant', timezone: 'America/Los_Angeles'};
const BIZ_B = {id: 'biz_barber_01', name: 'Demo Barbershop', category: 'barbershop', timezone: 'America/Los_Angeles'};

/** Each owner's own businesses, picked by who holds the stored session when the request arrives. */
function businessesByOwner() {
  server.use(
    http.get(`${A}/businesses`, () => HttpResponse.json({items: supa.state.session?.user.id === OWNER_B.id ? [BIZ_B] : [BIZ_A]})),
  );
}

function emit(event: string, user: FakeUser | null) {
  supa.state.session = user ? {user, access_token: `token-${user.id}`} : null;
  for (const listener of supa.state.listeners) listener(event, supa.state.session);
}

// Every render of the probe: which owner was signed in and which businesses the screen showed.
const renders: {owner: string | null; list: string}[] = [];
let mounts = 0;

function Probe() {
  const {owner, signOut} = useAuth();
  const {businesses} = useBusiness();
  const list = businesses.map((b) => b.id).join(',');
  renders.push({owner: owner?.id ?? null, list});
  useEffect(() => {
    mounts += 1;
  }, []);
  return (
    <>
      <output aria-label="owner">{owner?.id ?? 'none'}</output>
      <output aria-label="list">{list}</output>
      <button type="button" onClick={() => void signOut()}>
        Sign out
      </button>
    </>
  );
}

function CatalogProbe() {
  const {status} = useAuth();
  const {businessId} = useBusiness();
  useCatalog(status === 'signed_in' ? businessId : null);
  return null;
}

let client: QueryClient;

function Providers({children}: {children: ReactNode}) {
  const [queryClient] = useState(() => {
    client = createApiQueryClient();
    return client;
  });
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <OwnerDataBoundary>
          <ApiBusinessProvider>
            <SessionErrorHandler />
            {children}
          </ApiBusinessProvider>
        </OwnerDataBoundary>
      </QueryClientProvider>
    </AuthProvider>
  );
}

const text = (label: string) => screen.getByLabelText(label).textContent;
const cachedBusinesses = () => client.getQueryData(queryKeys.businesses());
const anyCachedData = () => client.getQueryCache().getAll().some((q) => q.state.data !== undefined);

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_MOCK', '');
  supa.state.session = {user: OWNER_A, access_token: 'token-a'};
  supa.state.listeners.clear();
  renders.length = 0;
  mounts = 0;
  router.replace.mockClear();
  businessesByOwner();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

async function renderSignedInAsA() {
  render(<Probe />, {wrapper: Providers});
  await waitFor(() => expect(text('list')).toBe(BIZ_A.id));
  expect(text('owner')).toBe(OWNER_A.id);
}

describe('OwnerDataBoundary', () => {
  it('does not clear when the first owner signs in', async () => {
    await renderSignedInAsA();
    expect(cachedBusinesses()).toBeDefined();
    expect(mounts).toBe(1);
  });

  it('clears the cache and owner storage when the owner signs out', async () => {
    await renderSignedInAsA();
    window.localStorage.setItem(BUSINESS_STORAGE_KEY, BIZ_A.id);
    window.localStorage.setItem('abos.builderSessions', JSON.stringify({[BIZ_A.id]: 'bld_1'}));
    window.localStorage.setItem('abos.builderNotes.bld_1', '{}');

    act(() => screen.getByRole('button', {name: 'Sign out'}).click());

    await waitFor(() => expect(text('owner')).toBe('none'));
    await waitFor(() => expect(anyCachedData()).toBe(false));
    expect(window.localStorage.getItem(BUSINESS_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem('abos.builderSessions')).toBeNull();
    expect(window.localStorage.getItem('abos.builderNotes.bld_1')).toBeNull();
  });

  it('clears the cache when another tab signs out', async () => {
    await renderSignedInAsA();
    act(() => emit('SIGNED_OUT', null));
    await waitFor(() => expect(text('owner')).toBe('none'));
    await waitFor(() => expect(anyCachedData()).toBe(false));
  });

  it('shows a second owner none of the first owner data after a sign-out', async () => {
    await renderSignedInAsA();
    act(() => emit('SIGNED_OUT', null));
    await waitFor(() => expect(anyCachedData()).toBe(false));

    act(() => emit('SIGNED_IN', OWNER_B));
    await waitFor(() => expect(text('list')).toBe(BIZ_B.id));
    const asB = renders.filter((r) => r.owner === OWNER_B.id);
    expect(asB.length).toBeGreaterThan(0);
    expect(asB.every((r) => !r.list.includes(BIZ_A.id))).toBe(true);
  });

  it('shows a second owner none of the first owner data when the owner changes without a sign-out', async () => {
    await renderSignedInAsA();

    act(() => emit('SIGNED_IN', OWNER_B));
    await waitFor(() => expect(text('list')).toBe(BIZ_B.id));
    const asB = renders.filter((r) => r.owner === OWNER_B.id);
    expect(asB.length).toBeGreaterThan(0);
    expect(asB.every((r) => !r.list.includes(BIZ_A.id))).toBe(true);
    expect(cachedBusinesses()).toEqual({items: [BIZ_B]});
  });

  it('keeps the cache when a token refresh keeps the same owner', async () => {
    await renderSignedInAsA();
    const before = cachedBusinesses();

    act(() => emit('TOKEN_REFRESHED', OWNER_A));
    await new Promise((r) => setTimeout(r, 30));

    expect(text('owner')).toBe(OWNER_A.id);
    expect(text('list')).toBe(BIZ_A.id);
    expect(cachedBusinesses()).toBe(before);
    expect(mounts).toBe(1);
  });

  it('still lets SessionErrorHandler sign out on UNAUTHENTICATED', async () => {
    server.use(
      http.get(`${A}/businesses/${BIZ_A.id}/catalog`, () =>
        HttpResponse.json({code: 'UNAUTHENTICATED', message: 'Sign in again.', retryable: false}, {status: 401}),
      ),
    );
    render(
      <>
        <Probe />
        <CatalogProbe />
      </>,
      {wrapper: Providers},
    );
    await waitFor(() => expect(text('owner')).toBe('none'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/sign-in'));
    expect(anyCachedData()).toBe(false);
    expect(window.sessionStorage.getItem(SIGN_IN_NOTICE_STORAGE_KEY)).toBe(SESSION_ENDED_NOTICE);
  });
});

describe('OwnerDataBoundary in mock mode', () => {
  it('clears the cache when the demo owner signs out', async () => {
    vi.stubEnv('NEXT_PUBLIC_MOCK', '1');
    window.localStorage.setItem(MOCK_SESSION_STORAGE_KEY, JSON.stringify({owner: DEMO_OWNER}));
    render(<Probe />, {wrapper: Providers});
    await waitFor(() => expect(text('owner')).toBe(DEMO_OWNER.id));
    await waitFor(() => expect(cachedBusinesses()).toBeDefined());

    act(() => screen.getByRole('button', {name: 'Sign out'}).click());

    await waitFor(() => expect(text('owner')).toBe('none'));
    await waitFor(() => expect(anyCachedData()).toBe(false));
    expect(window.localStorage.getItem(MOCK_SESSION_STORAGE_KEY)).toBeNull();
  });
});
