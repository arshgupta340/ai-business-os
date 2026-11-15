// @vitest-environment jsdom
import {act, cleanup, render, screen, waitFor} from '@testing-library/react';
import {http, HttpResponse} from 'msw';
import {useState, type ReactNode} from 'react';
import {QueryClientProvider} from '@tanstack/react-query';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createApiQueryClient} from '@/lib/api/provider';
import {ApiBusinessProvider} from '@/lib/session';
import {server} from '@/mocks/server';
import {TEST_BASE_URL, useMockServer} from '@/mocks/test-setup';
import {DashboardShell} from './DashboardShell';
import {SANDBOX_BANNER_TEXT} from './SandboxBanner';

vi.mock('next/navigation', () => ({
  useRouter: () => ({replace: vi.fn(), push: vi.fn()}),
  usePathname: () => '/overview',
}));
vi.mock('@/lib/session/auth', () => ({
  useAuth: () => ({status: 'signed_in', owner: {email: 'owner@example.com', displayName: 'Demo Owner'}, signOut: vi.fn()}),
}));

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

function renderShell() {
  return render(
    <Providers>
      <DashboardShell>
        <output aria-label="page">page</output>
      </DashboardShell>
    </Providers>,
  );
}

const selector = () => screen.getByRole('combobox', {name: 'Business'});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  window.localStorage.clear();
});

describe('DashboardShell and the business list', () => {
  it('in real mode shows "This account has no business yet" instead of the page, and the selector says so', async () => {
    vi.stubEnv('NEXT_PUBLIC_MOCK', '0');
    server.use(http.get(`${A}/businesses`, () => HttpResponse.json({items: []})));
    renderShell();
    expect(await screen.findByText('This account has no business yet')).toBeTruthy();
    expect(screen.queryByLabelText('page')).toBeNull();
    expect(selector().textContent).toContain('No business yet');
    expect(selector().getAttribute('aria-disabled')).toBe('true');
  });

  it('in real mode shows a loading state and a loading selector while the list loads, with no seeded name', async () => {
    vi.stubEnv('NEXT_PUBLIC_MOCK', '0');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.get(`${A}/businesses`, async () => {
        await gate;
        return HttpResponse.json({items: [{id: 'biz_real_01', name: 'Real Cafe', category: 'restaurant', timezone: 'America/New_York'}]});
      }),
    );
    renderShell();
    expect(await screen.findByText('Loading your businesses')).toBeTruthy();
    expect(selector().textContent).toContain('Loading businesses');
    expect(selector().textContent).not.toContain('Demo Pizza Co.');
    expect(screen.queryByLabelText('page')).toBeNull();
    release();
    expect(await screen.findByLabelText('page')).toBeTruthy();
    await waitFor(() => expect(selector().textContent).toContain('Real Cafe'));
    expect(selector().getAttribute('aria-disabled')).not.toBe('true');
  });

  it('in mock mode renders the page with the seeded business in the selector, as before', async () => {
    vi.stubEnv('NEXT_PUBLIC_MOCK', '1');
    renderShell();
    expect(await screen.findByLabelText('page')).toBeTruthy();
    expect(selector().textContent).toContain('Demo Pizza Co.');
    expect(selector().getAttribute('aria-disabled')).not.toBe('true');
  });
});

describe('DashboardShell and the sandbox bar', () => {
  it('shows the bar by default', async () => {
    renderShell();
    expect(await screen.findByText(SANDBOX_BANNER_TEXT)).toBeTruthy();
  });

  it('hides the bar while the scripted demo is on', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_SCRIPT', '1');
    renderShell();
    expect(await screen.findByLabelText('page')).toBeTruthy();
    expect(screen.queryByText(SANDBOX_BANNER_TEXT)).toBeNull();
  });
});

describe('DashboardShell top bar', () => {
  it('shows the business selector by default and a profile circle with Sign out in its menu', async () => {
    renderShell();
    expect(await screen.findByLabelText('page')).toBeTruthy();
    expect(selector()).toBeTruthy();
    const account = screen.getByRole('button', {name: 'Account'});
    act(() => account.click());
    expect(await screen.findByRole('menuitem', {name: 'Sign out'})).toBeTruthy();
  });

  it('hides the business selector while the scripted demo is on', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_SCRIPT', '1');
    renderShell();
    expect(await screen.findByLabelText('page')).toBeTruthy();
    expect(screen.queryByRole('combobox', {name: 'Business'})).toBeNull();
    expect(screen.getByRole('button', {name: 'Account'})).toBeTruthy();
  });
});
