// @vitest-environment jsdom
import {cleanup, render, screen} from '@testing-library/react';
import {http, HttpResponse} from 'msw';
import {useState, type ReactNode} from 'react';
import {QueryClientProvider} from '@tanstack/react-query';
import {afterEach, beforeAll, describe, expect, it} from 'vitest';
import {createApiQueryClient} from '@/lib/api';
import {BusinessProvider} from '@/lib/session';
import {BUSINESS_STORAGE_KEY} from '@/lib/session/business-selection';
import {server} from '@/mocks/server';
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

function Providers({children}: {children: ReactNode}) {
  const [client] = useState(createApiQueryClient);
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
    const live = await screen.findByRole('link', {name: /Pizza Order Assistant/});
    expect(live.getAttribute('href')).toBe('/agents/agt_pizza_01');
    const paused = screen.getByRole('link', {name: /Pizza FAQ Assistant/});
    expect(paused.getAttribute('href')).toBe('/agents/agt_pizza_faq_01');
    expect(screen.getByText('Pizza Order Assistant answers the phone number.')).toBeTruthy();
    expect(screen.getAllByText('Live').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Paused').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Answers the phone number').length).toBe(1);
  });

  it('says the number belongs to the other business by name only', async () => {
    renderList('biz_barber_01');
    expect(await screen.findByText('An agent of Demo Pizza Co. answers the phone number, not an agent of this business.')).toBeTruthy();
    expect(screen.queryByText(/Pizza Order Assistant/)).toBeNull();
    expect(screen.getAllByText('Draft').length).toBeGreaterThan(0);
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
    expect(await screen.findByText('Could not load this', undefined, {timeout: 10_000})).toBeTruthy();
    expect(screen.getByText('Unexpected server error.')).toBeTruthy();
    expect(screen.getByRole('button', {name: 'Try again'})).toBeTruthy();
  });
});
