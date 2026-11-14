// @vitest-environment jsdom
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {http, HttpResponse} from 'msw';
import {useState, type ReactNode} from 'react';
import {QueryClient} from '@tanstack/react-query';
import {QueryClientProvider} from '@tanstack/react-query';
import {afterEach, beforeAll, describe, expect, it} from 'vitest';
import {createApiQueryClient} from '@/lib/api';
import {BusinessProvider} from '@/lib/session';
import {BUSINESS_STORAGE_KEY} from '@/lib/session/business-selection';
import {mockControls, server} from '@/mocks/server';
import {TEST_BASE_URL, useMockServer} from '@/mocks/test-setup';
import {AgentsListScreen} from './_components/AgentsListScreen';

useMockServer();

beforeAll(() => {
  process.env.NEXT_PUBLIC_MOCK = '1';
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

let lastClient: QueryClient | null = null;

function Providers({children}: {children: ReactNode}) {
  const [client] = useState(createApiQueryClient);
  lastClient = client;
  return (
    <QueryClientProvider client={client}>
      <BusinessProvider>{children}</BusinessProvider>
    </QueryClientProvider>
  );
}

function renderList(businessId = 'biz_pizza_01') {
  window.localStorage.setItem(BUSINESS_STORAGE_KEY, businessId);
  render(
    <Providers>
      <AgentsListScreen />
    </Providers>,
  );
}

describe('AgentsListScreen', {timeout: 20_000}, () => {
  it('lists every pizza agent with its state, the number owner first, each linking to its page', async () => {
    renderList();
    await screen.findByText('Pizza Order Assistant answers the phone number.');
    const hrefs = screen.getAllByRole('link').map((l) => l.getAttribute('href'));
    // The shared world: the live agent, the draft FAQ line and a paused copy of the order assistant.
    expect(hrefs).toEqual(expect.arrayContaining(['/agents/agt_pizza_01', '/agents/agt_pizza_faq_01', '/agents/agt_pizza_paused_88']));
    expect(screen.getByRole('link', {name: /Pizza FAQ Line/}).getAttribute('href')).toBe('/agents/agt_pizza_faq_01');
    expect(screen.getAllByText('Live').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Paused').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Draft').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Answers the phone number').length).toBe(1);
  });

  it('says the number belongs to the other business by name only', async () => {
    renderList('biz_barber_01');
    expect(await screen.findByText('An agent of Demo Pizza Co. answers the phone number, not an agent of this business.')).toBeTruthy();
    expect(screen.queryByText(/Pizza Order Assistant/)).toBeNull();
    expect(screen.getByRole('link', {name: /Booking Assistant/}).getAttribute('href')).toBe('/agents/agt_barber_01');
    expect(screen.getAllByText('Live').length).toBeGreaterThan(0);
    expect(screen.queryByText('Answers the phone number')).toBeNull();
  });

  it('shows the empty state with a way to build an agent', async () => {
    server.use(http.get(`${TEST_BASE_URL}/api/agents`, () => HttpResponse.json({items: []})));
    renderList();
    expect(await screen.findByRole('heading', {name: 'No agents yet'})).toBeTruthy();
    const links = screen.getAllByRole('link', {name: 'Build an agent'});
    expect(links.every((l) => l.getAttribute('href') === '/build')).toBe(true);
  });

  it('shows an error with retry when the list fails with a retryable error', async () => {
    server.use(
      http.get(`${TEST_BASE_URL}/api/agents`, () =>
        HttpResponse.json({code: 'INTERNAL', message: 'Unexpected server error.', correlationId: 'corr-9', retryable: true}, {status: 500}),
      ),
    );
    renderList();
    // The query client retries a retryable read twice before it shows the error.
    expect(await screen.findByText('Could not load your agents', undefined, {timeout: 10_000})).toBeTruthy();
    expect(screen.getByText('Unexpected server error.')).toBeTruthy();
    expect(screen.getByRole('button', {name: 'Try again'})).toBeTruthy();
  });

  it('keeps the list when a background refetch fails, says so in one line, and Try again refreshes', async () => {
    renderList();
    await screen.findByText('Pizza Order Assistant answers the phone number.');
    expect(screen.queryByText('Could not refresh. Showing the last data we have.')).toBeNull();
    mockControls.simulateRequestFailure?.({path: '/api/agents'});
    await act(async () => {
      await lastClient!.refetchQueries({type: 'active'});
    });
    expect(await screen.findByText('Could not refresh. Showing the last data we have.', {}, {timeout: 10_000})).toBeTruthy();
    // The old list stays on screen, with no full error in its place.
    expect(screen.getByRole('link', {name: /Pizza FAQ Line/})).toBeTruthy();
    expect(screen.queryByText('Could not load your agents')).toBeNull();

    mockControls.clearRequestFailures?.();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', {name: 'Try again'}));
    });
    await waitFor(() => expect(screen.queryByText('Could not refresh. Showing the last data we have.')).toBeNull());
    expect(screen.getByRole('link', {name: /Pizza FAQ Line/})).toBeTruthy();
  });
});
