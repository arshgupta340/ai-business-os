// @vitest-environment jsdom
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {http, HttpResponse} from 'msw';
import {useState, type ReactNode} from 'react';
import {QueryClientProvider} from '@tanstack/react-query';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createApiQueryClient} from '@/lib/api/provider';
import {server} from '@/mocks/server';
import {requests, TEST_BASE_URL, useMockServer} from '@/mocks/test-setup';
import {ApiBusinessProvider, useBusinessList} from './ApiBusinessProvider';
import {BusinessListGate, businessSelectorPlaceholder} from './BusinessListGate';
import {useBusiness} from './BusinessProvider';

// Real mode with a signed-in owner. Supabase is not needed: only the auth status is read here.
vi.mock('./auth', () => ({useAuth: () => ({status: 'signed_in'})}));

useMockServer();

const A = `${TEST_BASE_URL}/api`;

function Providers({children}: {children: ReactNode}) {
  const [client] = useState(createApiQueryClient);
  return (
    <QueryClientProvider client={client}>
      <ApiBusinessProvider>{children}</ApiBusinessProvider>
    </QueryClientProvider>
  );
}

function Probe() {
  const {businesses, businessId} = useBusiness();
  const {status} = useBusinessList();
  return (
    <>
      <output aria-label="list-status">{status}</output>
      <output aria-label="business">{businessId ?? 'none'}</output>
      <output aria-label="list">{businesses.map((b) => b.name).join(',')}</output>
      <BusinessListGate>
        <output aria-label="page">page</output>
      </BusinessListGate>
    </>
  );
}

const text = (label: string) => screen.getByLabelText(label).textContent;

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_MOCK', '0');
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  window.localStorage.clear();
});

describe('ApiBusinessProvider in real mode', () => {
  it('shows no seeded business and no page while GET /api/businesses loads', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.get(`${A}/businesses`, async () => {
        await gate;
        return HttpResponse.json({items: [{id: 'biz_real_01', name: 'Real Cafe', category: 'restaurant', timezone: 'America/New_York'}]});
      }),
    );
    render(<Probe />, {wrapper: Providers});
    expect(text('list-status')).toBe('loading');
    expect(text('business')).toBe('none');
    expect(text('list')).toBe('');
    expect(screen.queryByLabelText('page')).toBeNull();
    expect(screen.getByText('Loading your businesses')).toBeTruthy();
    expect(businessSelectorPlaceholder('loading')).toBe('Loading businesses');

    release();
    await waitFor(() => expect(text('business')).toBe('biz_real_01'));
    expect(text('list')).toBe('Real Cafe');
    expect(text('list-status')).toBe('ready');
    expect(screen.getByLabelText('page')).toBeTruthy();
  });

  it('shows the error with a retry and an empty selector when the call fails', async () => {
    let fail = true;
    server.use(
      http.get(`${A}/businesses`, () =>
        fail
          ? HttpResponse.json({code: 'INTERNAL', message: 'Something went wrong.', correlationId: 'cor_1', retryable: false}, {status: 500})
          : HttpResponse.json({items: [{id: 'biz_real_01', name: 'Real Cafe', category: 'restaurant', timezone: 'America/New_York'}]}),
      ),
    );
    render(<Probe />, {wrapper: Providers});
    expect(await screen.findByText('Your businesses did not load')).toBeTruthy();
    expect(text('list-status')).toBe('error');
    expect(text('list')).toBe('');
    expect(text('business')).toBe('none');
    expect(screen.queryByLabelText('page')).toBeNull();

    fail = false;
    fireEvent.click(screen.getByRole('button', {name: 'Try again'}));
    await waitFor(() => expect(text('business')).toBe('biz_real_01'));
    expect(screen.getByLabelText('page')).toBeTruthy();
  });

  it('says the account has no business when the server returns an empty list', async () => {
    server.use(http.get(`${A}/businesses`, () => HttpResponse.json({items: []})));
    render(<Probe />, {wrapper: Providers});
    expect(await screen.findByText('This account has no business yet')).toBeTruthy();
    expect(text('business')).toBe('none');
    expect(screen.queryByLabelText('page')).toBeNull();
  });

  it('sends no business-scoped call before the list arrives', async () => {
    server.use(http.get(`${A}/businesses`, () => HttpResponse.json({items: []})));
    render(<Probe />, {wrapper: Providers});
    await screen.findByText('This account has no business yet');
    const scoped = requests.filter((r) => !new URL(r.url).pathname.endsWith('/api/businesses'));
    expect(scoped).toEqual([]);
  });
});
