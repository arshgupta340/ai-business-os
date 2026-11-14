// @vitest-environment jsdom
import {cleanup, render, screen, waitFor} from '@testing-library/react';
import {http, HttpResponse} from 'msw';
import {useState, type ReactNode} from 'react';
import {QueryClientProvider} from '@tanstack/react-query';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {useCatalog} from '@/lib/api';
import {createApiQueryClient} from '@/lib/api/provider';
import {ApiBusinessProvider, SESSION_ENDED_NOTICE, SIGN_IN_NOTICE_STORAGE_KEY, useBusiness} from '@/lib/session';
import {AuthProvider, DEMO_OWNER, useAuth} from '@/lib/session/auth';
import {MOCK_SESSION_STORAGE_KEY} from '@/lib/session/auth/mock-session';
import {BUSINESS_STORAGE_KEY} from '@/lib/session/business-selection';
import {server} from '@/mocks/server';
import {TEST_BASE_URL, useMockServer} from '@/mocks/test-setup';
import {SessionErrorHandler} from './SessionErrorHandler';

const router = vi.hoisted(() => ({replace: vi.fn(), push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn()}));
vi.mock('next/navigation', () => ({useRouter: () => router, usePathname: () => '/overview'}));

useMockServer();

const A = `${TEST_BASE_URL}/api`;

function Providers({children}: {children: ReactNode}) {
  const [client] = useState(createApiQueryClient);
  return (
    <AuthProvider>
      <QueryClientProvider client={client}>
        <ApiBusinessProvider>
          <SessionErrorHandler />
          {children}
        </ApiBusinessProvider>
      </QueryClientProvider>
    </AuthProvider>
  );
}

function Probe({loadCatalog = true}: {loadCatalog?: boolean}) {
  const {status} = useAuth();
  const {businesses, businessId} = useBusiness();
  useCatalog(loadCatalog && status === 'signed_in' ? businessId : null);
  return (
    <>
      <output aria-label="status">{status}</output>
      <output aria-label="business">{businessId ?? 'none'}</output>
      <output aria-label="list">{businesses.map((b) => b.id).join(',')}</output>
    </>
  );
}

const text = (label: string) => screen.getByLabelText(label).textContent;

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_MOCK', '1');
  window.localStorage.setItem(MOCK_SESSION_STORAGE_KEY, JSON.stringify({owner: DEMO_OWNER}));
  router.replace.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('businesses from the API', () => {
  it('uses the API list once it loads', async () => {
    server.use(
      http.get(`${A}/businesses`, () =>
        HttpResponse.json({items: [{id: 'biz_barber_01', name: 'Demo Barbershop', category: 'barbershop', timezone: 'America/Los_Angeles'}]}),
      ),
    );
    render(<Probe loadCatalog={false} />, {wrapper: Providers});
    await waitFor(() => expect(text('list')).toBe('biz_barber_01'));
    expect(text('business')).toBe('biz_barber_01');
  });

  it('keeps the seeded list when the call fails', async () => {
    server.use(http.get(`${A}/businesses`, () => HttpResponse.json({code: 'INTERNAL', message: 'down', retryable: false}, {status: 500})));
    render(<Probe loadCatalog={false} />, {wrapper: Providers});
    await waitFor(() => expect(text('status')).toBe('signed_in'));
    await new Promise((r) => setTimeout(r, 30));
    expect(text('list')).toBe('biz_pizza_01,biz_barber_01');
    expect(text('business')).toBe('biz_pizza_01');
  });
});

describe('FORBIDDEN_BUSINESS', () => {
  it('falls back to a business the owner has and stores it', async () => {
    server.use(
      http.get(`${A}/businesses/biz_pizza_01/catalog`, () =>
        HttpResponse.json({code: 'FORBIDDEN_BUSINESS', message: 'You do not own this business.', retryable: false}, {status: 403}),
      ),
    );
    render(<Probe />, {wrapper: Providers});
    await waitFor(() => expect(text('business')).toBe('biz_barber_01'));
    expect(text('list')).not.toContain('biz_pizza_01');
    expect(window.localStorage.getItem(BUSINESS_STORAGE_KEY)).toBe('biz_barber_01');
    expect(text('status')).toBe('signed_in');
  });
});

describe('UNAUTHENTICATED', () => {
  it('signs out, leaves a notice and goes to /sign-in', async () => {
    server.use(
      http.get(`${A}/businesses/biz_pizza_01/catalog`, () =>
        HttpResponse.json({code: 'UNAUTHENTICATED', message: 'Sign in again.', retryable: false}, {status: 401}),
      ),
    );
    render(<Probe />, {wrapper: Providers});
    await waitFor(() => expect(text('status')).toBe('signed_out'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/sign-in'));
    expect(window.sessionStorage.getItem(SIGN_IN_NOTICE_STORAGE_KEY)).toBe(SESSION_ENDED_NOTICE);
    expect(window.localStorage.getItem(MOCK_SESSION_STORAGE_KEY)).toBeNull();
  });
});
