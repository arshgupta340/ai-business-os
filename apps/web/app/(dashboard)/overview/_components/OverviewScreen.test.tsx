// @vitest-environment jsdom
import {cleanup, render, screen, waitFor} from '@testing-library/react';
import {QueryClientProvider} from '@tanstack/react-query';
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

function renderOverview() {
  const client = createApiQueryClient();
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
    expect(cards.map((c) => c.getAttribute('href')).sort()).toEqual(['/agents/agt_pizza_01', '/agents/agt_pizza_faq_01']);
  });
});
