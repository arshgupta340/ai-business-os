// @vitest-environment jsdom
// The demo reset (Arsh, 2026-11-15): pressing the "Integrations OK" badge on the scripted demo build puts
// the app back to its starting page and clears the lists. Nothing is deleted on the server: the lists leave
// out what happened up to the reset.
import {act, cleanup, fireEvent, render, renderHook, screen, waitFor} from '@testing-library/react';
import type {ReactNode} from 'react';
import {useState} from 'react';
import {QueryClientProvider} from '@tanstack/react-query';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createApiQueryClient} from '@/lib/api/provider';
import {useApprovals, useCalls} from '@/lib/api';
import {BusinessProvider} from '@/lib/session';
import {useMockServer} from '@/mocks/test-setup';
import {ConnectionHealth, resetDemo} from '@/components/shell/ConnectionHealth';
import {DEMO_RUN_STORAGE_KEY} from '@/app/(dashboard)/build/demo/demo-run-store';
import {markDemoAgentBuilt} from './demo-stage';
import {HIDDEN_BEFORE_STORAGE_KEY, hideEverythingUntil, newerThan, readHiddenBefore, showEverythingAgain} from './demo-reset';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/overview',
  useRouter: () => ({replace: vi.fn(), push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn()}),
}));

useMockServer();

function Providers({children}: {children: ReactNode}) {
  const [client] = useState(createApiQueryClient);
  return (
    <QueryClientProvider client={client}>
      <BusinessProvider>{children}</BusinessProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  showEverythingAgain();
});

describe('demo reset: the stored moment', () => {
  it('keeps items that happened after the reset and drops the rest', () => {
    const items = [{at: '2026-11-15T10:00:00Z'}, {at: '2026-11-15T10:00:01Z'}, {at: 'not a time'}, {at: undefined}];
    const cutoff = Date.parse('2026-11-15T10:00:00Z');
    expect(newerThan(items, cutoff, (x) => x.at)).toEqual([items[1], items[2], items[3]]);
    expect(newerThan(items, null, (x) => x.at)).toEqual(items);
  });

  it('is stored in this browser and can be undone', () => {
    expect(readHiddenBefore()).toBeNull();
    hideEverythingUntil(1_794_700_000_000);
    expect(window.localStorage.getItem(HIDDEN_BEFORE_STORAGE_KEY)).toBe('1794700000000');
    expect(readHiddenBefore()).toBe(1_794_700_000_000);
    showEverythingAgain();
    expect(readHiddenBefore()).toBeNull();
    window.localStorage.setItem(HIDDEN_BEFORE_STORAGE_KEY, 'nonsense');
    expect(readHiddenBefore()).toBeNull();
  });
});

describe('demo reset: the lists', () => {
  it('shows everything before a reset and nothing older after it', async () => {
    const calls = renderHook(() => useCalls('biz_pizza_01', {limit: 50}), {wrapper: Providers});
    const approvals = renderHook(() => useApprovals('biz_pizza_01', {limit: 200}), {wrapper: Providers});
    await waitFor(() => expect(calls.result.current.data?.items.length ?? 0).toBeGreaterThan(0));
    await waitFor(() => expect(approvals.result.current.data?.items.length ?? 0).toBeGreaterThan(0));

    // The fixtures are dated 2026-11-14. A reset far later hides them all, without a new request.
    act(() => hideEverythingUntil(Date.parse('2030-01-01T00:00:00Z')));
    await waitFor(() => expect(calls.result.current.data?.items).toEqual([]));
    await waitFor(() => expect(approvals.result.current.data?.items).toEqual([]));

    // A reset before them hides nothing, and undoing the reset brings everything back.
    act(() => hideEverythingUntil(Date.parse('2020-01-01T00:00:00Z')));
    await waitFor(() => expect(calls.result.current.data?.items.length ?? 0).toBeGreaterThan(0));
    act(() => showEverythingAgain());
    await waitFor(() => expect(approvals.result.current.data?.items.length ?? 0).toBeGreaterThan(0));
  });
});

describe('demo reset: the badge', () => {
  it('drops the saved Build run, stores the moment and loads the Build page afresh', () => {
    window.sessionStorage.setItem(DEMO_RUN_STORAGE_KEY, '{"shopKey":"barber"}');
    // The last build reached its number, so Overview and My Agents show that shop's agent.
    markDemoAgentBuilt('biz_barber_01');
    expect(window.sessionStorage.getItem('abos.demo.agentBuilt')).toBe('biz_barber_01');
    const go = vi.fn();
    resetDemo(1_794_700_000_000, go);
    expect(window.sessionStorage.getItem(DEMO_RUN_STORAGE_KEY)).toBeNull();
    // After a reset the agent card is gone until the next build (Arsh, 2026-11-15).
    expect(window.sessionStorage.getItem('abos.demo.agentBuilt')).toBeNull();
    expect(readHiddenBefore()).toBe(1_794_700_000_000);
    expect(go).toHaveBeenCalledWith('/build');
  });

  it('is a plain link to Integrations outside the scripted demo', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_SCRIPT', '');
    render(<Providers><ConnectionHealth status={{label: 'Integrations OK', tone: 'success'}} /></Providers>);
    expect(screen.queryByRole('button', {name: /Reset the demo/})).toBeNull();
    expect((await screen.findByText('Integrations OK')).closest('a')?.getAttribute('href')).toBe('/integrations');
  });

  it('looks the same on the scripted demo, and pressing it resets', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_SCRIPT', '1');
    const assign = vi.fn();
    vi.stubGlobal('location', {...window.location, assign});
    render(<Providers><ConnectionHealth status={{label: 'Integrations OK', tone: 'success'}} /></Providers>);
    const badge = await screen.findByText('Integrations OK');
    expect(badge.closest('a')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', {name: /Reset the demo/}));
    });
    expect(assign).toHaveBeenCalledWith('/build');
    expect(readHiddenBefore()).not.toBeNull();
    vi.unstubAllGlobals();
  });
});
