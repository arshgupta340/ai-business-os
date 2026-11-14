// @vitest-environment jsdom
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {QueryClientProvider, type QueryClient} from '@tanstack/react-query';
import {afterEach, beforeAll, describe, expect, it} from 'vitest';
import {createApiQueryClient} from '@/lib/api';
import {BusinessProvider} from '@/lib/session';
import {BUSINESS_STORAGE_KEY} from '@/lib/session/business-selection';
import {mockControls, whenIdle} from '@/mocks/server';
import {useMockServer} from '@/mocks/test-setup';
import {OverviewScreen} from './OverviewScreen';

useMockServer();

beforeAll(() => {
  // useActivityFeed listens to the mock event bus only in mock mode.
  process.env.NEXT_PUBLIC_MOCK = '1';
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

let lastClient: QueryClient | null = null;

function renderOverview() {
  const client = createApiQueryClient();
  lastClient = client;
  render(
    <QueryClientProvider client={client}>
      <BusinessProvider>
        <OverviewScreen />
      </BusinessProvider>
    </QueryClientProvider>,
  );
}

const countText = (id: string) => document.getElementById(id)?.textContent ?? null;

describe('OverviewScreen', () => {
  it('updates the pending approval and calls counts when a mock pizza call arrives, with no reload', async () => {
    renderOverview();
    await waitFor(() => expect(countText('overview-pending-approvals-count')).not.toBeNull());
    await waitFor(() => expect(countText('overview-calls-today-count')).not.toBeNull());
    const approvalsBefore = Number(countText('overview-pending-approvals-count'));
    const callsBefore = Number(countText('overview-calls-today-count'));

    await mockControls.startPizzaCall();
    await whenIdle();

    await waitFor(() => expect(Number(countText('overview-pending-approvals-count'))).toBe(approvalsBefore + 1));
    await waitFor(() => expect(Number(countText('overview-calls-today-count'))).toBe(callsBefore + 1));
  });

  it('shows orders with a sandbox label for the pizza shop', async () => {
    renderOverview();
    expect(await screen.findByRole('heading', {name: 'Orders'})).toBeTruthy();
    expect(screen.getAllByText('Sandbox payments').length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Paid, verified')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', {name: 'Bookings'})).toBeNull();
  });

  it('shows bookings and no orders for the barbershop', async () => {
    window.localStorage.setItem(BUSINESS_STORAGE_KEY, 'biz_barber_01');
    renderOverview();
    expect(await screen.findByRole('heading', {name: 'Bookings'})).toBeTruthy();
    expect(screen.queryByRole('heading', {name: 'Orders'})).toBeNull();
    expect((await screen.findAllByText('Booked, verified')).length).toBeGreaterThan(0);
  });

  it('links each agent card to its agent page', async () => {
    renderOverview();
    const cards = await screen.findAllByRole('link', {name: /^Open /});
    expect(cards.map((c) => c.getAttribute('href')).sort()).toEqual(['/agents/agt_pizza_01', '/agents/agt_pizza_faq_01', '/agents/agt_pizza_paused_88']);
  });

  it('a business with nothing yet shows empty blocks, each with a next step, and no error', async () => {
    mockControls.simulateEmptyBusiness?.('biz_pizza_01');
    renderOverview();
    expect(await screen.findByText('No agents yet')).toBeTruthy();
    const build = screen.getByRole('link', {name: 'Build an agent'});
    expect(build.getAttribute('href')).toBe('/build');
    expect(await screen.findByText('No orders yet')).toBeTruthy();
    expect(await screen.findByText('No activity yet')).toBeTruthy();
    await waitFor(() => expect(countText('overview-pending-approvals-count')).toBe('0'));
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });

  it('keeps the blocks when a background refetch fails, says so in one line, and Try again refreshes', async () => {
    renderOverview();
    await screen.findAllByRole('link', {name: /^Open /});
    expect(screen.queryByText('Could not refresh. Showing the last data we have.')).toBeNull();
    mockControls.simulateRequestFailure?.({path: '/api/'});
    await act(async () => {
      await lastClient!.refetchQueries({type: 'active'});
    });
    expect(await screen.findByText('Could not refresh. Showing the last data we have.', {}, {timeout: 10_000})).toBeTruthy();
    expect(screen.getAllByText('Could not refresh. Showing the last data we have.')).toHaveLength(1);
    // The old data stays: the agent cards and the counts are still there, with no block error.
    const hrefs = screen.getAllByRole('link', {name: /^Open /}).map((c) => c.getAttribute('href'));
    expect(hrefs).toEqual(expect.arrayContaining(['/agents/agt_pizza_01', '/agents/agt_pizza_faq_01', '/agents/agt_pizza_paused_88']));
    expect(countText('overview-pending-approvals-count')).not.toBeNull();
    expect(screen.queryByText('Could not load agents')).toBeNull();

    mockControls.clearRequestFailures?.();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', {name: 'Try again'}));
    });
    await waitFor(() => expect(screen.queryByText('Could not refresh. Showing the last data we have.')).toBeNull());
  });
});
