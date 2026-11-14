// @vitest-environment jsdom
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {http, HttpResponse} from 'msw';
import type {ReactNode} from 'react';
import {useState} from 'react';
import {QueryClientProvider} from '@tanstack/react-query';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import * as api from '@/lib/api/client';
import {createApiQueryClient} from '@/lib/api/provider';
import {BusinessProvider, useBusiness} from '@/lib/session';
import {server} from '@/mocks/server';
import {requests, TEST_BASE_URL, useMockServer} from '@/mocks/test-setup';
import {BuildScreen} from './BuildScreen';

// A tiny stand-in for next/navigation: the search string is a store, so
// router.replace re-renders the screen the way the App Router does.
const nav = vi.hoisted(() => {
  let search = '';
  const listeners = new Set<() => void>();
  const set = (url: string) => {
    search = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
    listeners.forEach((l) => l());
  };
  return {
    get: () => search,
    set,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    router: {replace: vi.fn((url: string) => set(url)), push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn()},
  };
});

vi.mock('next/navigation', async () => {
  const React = await import('react');
  return {
    useSearchParams: () => new URLSearchParams(React.useSyncExternalStore(nav.subscribe, nav.get, nav.get)),
    usePathname: () => '/build',
    useRouter: () => nav.router,
  };
});

useMockServer();

const PIZZA = 'biz_pizza_01';
const A = `${TEST_BASE_URL}/api`;

function Providers({children}: {children: ReactNode}) {
  const [client] = useState(createApiQueryClient);
  return (
    <QueryClientProvider client={client}>
      <BusinessProvider>{children}</BusinessProvider>
    </QueryClientProvider>
  );
}

// Stands in for the top bar business selector.
function SwitchBusiness() {
  const {setBusinessId} = useBusiness();
  return (
    <>
      <button type="button" onClick={() => setBusinessId('biz_barber_01')}>
        test: barbershop
      </button>
      <button type="button" onClick={() => setBusinessId('biz_pizza_01')}>
        test: pizza
      </button>
    </>
  );
}

function renderScreen() {
  return render(
    <Providers>
      <SwitchBusiness />
      <BuildScreen />
    </Providers>,
  );
}

const createCalls = () => requests.filter((r) => r.method === 'POST' && new URL(r.url).pathname === '/api/builder/sessions');
const messageCalls = () => requests.filter((r) => r.method === 'POST' && new URL(r.url).pathname.endsWith('/messages'));

async function send(text: string) {
  // The Astryx composer input is a contentEditable element.
  const input = await screen.findByRole('textbox');
  await waitFor(() => expect(input.getAttribute('aria-disabled')).not.toBe('true'));
  await act(async () => {
    input.textContent = text;
    fireEvent.input(input);
  });
  const sendButton = await screen.findByRole('button', {name: /^send/i});
  await waitFor(() => expect(sendButton.getAttribute('aria-disabled')).not.toBe('true'));
  await act(async () => {
    fireEvent.click(sendButton);
  });
}

async function clickButton(name: string | RegExp) {
  const button = await screen.findByRole('button', {name});
  await act(async () => {
    fireEvent.click(button);
  });
}

beforeEach(() => {
  window.localStorage.clear();
  nav.set('/build');
  nav.router.replace.mockClear();
  nav.router.push.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('Build an Agent', () => {
  it('creates a session on first use, puts it in the URL and shows the first prompt with examples', async () => {
    renderScreen();
    expect(await screen.findByText('What would you like an agent to do for your business?')).toBeTruthy();
    expect(createCalls()).toHaveLength(1);
    expect(nav.get()).toMatch(/^session=bld_/);
    expect(screen.getByRole('button', {name: 'Book haircut appointments for my barbershop'})).toBeTruthy();
    expect(screen.getByRole('button', {name: 'Continue'}).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('button', {name: 'Voice input is not available yet'}).getAttribute('aria-disabled')).toBe('true');
  });

  it('resumes the session from the URL without creating a new one', async () => {
    const session = await api.createBuilderSession(PIZZA);
    await api.sendBuilderMessage(PIZZA, session.id, {text: 'I run a pizza shop and want an AI that takes pickup orders', inputMode: 'text'});
    requests.length = 0;
    nav.set(`/build?session=${session.id}`);
    renderScreen();
    expect(await screen.findByText('I run a pizza shop and want an AI that takes pickup orders')).toBeTruthy();
    expect(createCalls()).toHaveLength(0);
    expect(screen.getByText('Pizza Order Assistant')).toBeTruthy();
  });

  it('runs a turn: the example prompt is sent and the spec groups capabilities by effect', async () => {
    renderScreen();
    await clickButton('I run a pizza shop and want an AI that takes pickup orders');
    expect(await screen.findByText(/latest pickup time you accept on weekdays/)).toBeTruthy();
    const body = (await messageCalls()[0].clone().json()) as {text: string; inputMode: string};
    expect(body).toEqual({text: 'I run a pizza shop and want an AI that takes pickup orders', inputMode: 'text'});
    expect(screen.getByText('Reads only')).toBeTruthy();
    expect(screen.getByText('Proposes, you approve')).toBeTruthy();
    expect(screen.getByText('Runs only after your approval')).toBeTruthy();
    expect(screen.getByText('order.checkout.prepare')).toBeTruthy();
    expect(screen.getByText('What is the latest weekday pickup time?')).toBeTruthy();
    expect(screen.getByRole('button', {name: 'Continue'}).getAttribute('aria-disabled')).toBe('true');
  });

  it('shows an unsupported request as not available and keeps it in the spec panel', async () => {
    renderScreen();
    await screen.findByText('What would you like an agent to do for your business?');
    await send('Can it also take delivery orders?');
    expect(await screen.findByText('delivery orders')).toBeTruthy();
    expect(screen.getAllByText('Not available').length).toBeGreaterThanOrEqual(2);
    await send('I run a pizza shop and want an AI that takes pickup orders');
    await screen.findByText(/latest pickup time/);
    expect(screen.getByText('delivery orders')).toBeTruthy();
  });

  it('keeps the owner message on an error and resends the same text on retry', async () => {
    let failOnce = true;
    server.use(
      http.post(`${A}/builder/sessions/:id/messages`, () => {
        if (!failOnce) return undefined;
        failOnce = false;
        return HttpResponse.json(
          {code: 'INTEGRATION_UNAVAILABLE', message: 'OpenAI is not responding.', correlationId: 'cor_test', retryable: true, details: {provider: 'OpenAI'}},
          {status: 503},
        );
      }),
    );
    renderScreen();
    await screen.findByText('What would you like an agent to do for your business?');
    await send('Book haircut appointments');
    expect(await screen.findByText('The builder is not available right now')).toBeTruthy();
    expect(screen.getByText('Book haircut appointments')).toBeTruthy();
    expect(screen.queryByText(/latest pickup time/)).toBeNull();
    await clickButton('Try again');
    expect(await screen.findByText(/latest pickup time/)).toBeTruthy();
    const bodies = await Promise.all(messageCalls().map((r) => r.clone().json()));
    expect(bodies).toEqual([
      {text: 'Book haircut appointments', inputMode: 'text'},
      {text: 'Book haircut appointments', inputMode: 'text'},
    ]);
    expect(screen.queryByText('The builder is not available right now')).toBeNull();
  });

  it('lists stop conditions and keeps Continue disabled even with nothing missing', async () => {
    server.use(
      http.post(`${A}/builder/sessions/:id/messages`, ({params}) =>
        HttpResponse.json({
          reply: {id: 'bmsg_x', sessionId: String(params.id), role: 'assistant', inputMode: 'text', text: 'Your business has no timezone.', createdAt: '2026-11-13T19:00:00Z'},
          draftSpec: {template: 'restaurant_order_taker', name: 'Pizza Order Assistant'},
          missingFields: [],
          suggestions: [],
          stopConditions: [{code: 'missing_timezone'}],
          progress: {answered: 6, required: 6},
          unsupportedRequests: [],
        }),
      ),
    );
    renderScreen();
    await screen.findByText('What would you like an agent to do for your business?');
    await send('Take pickup orders');
    expect(await screen.findByText('This draft is blocked')).toBeTruthy();
    expect(screen.getByText('The business has no timezone.')).toBeTruthy();
    expect(screen.getByRole('button', {name: 'Continue'}).getAttribute('aria-disabled')).toBe('true');
  });

  it('enables Continue after the full interview, creates the draft and goes to the preview', async () => {
    renderScreen();
    await screen.findByText('What would you like an agent to do for your business?');
    const answers = ['I run a pizza shop and want an AI that takes pickup orders', '9 pm', '20 minutes', 'Yes, up to 140 characters', 'Text message', 'Yes'];
    for (const answer of answers) {
      await send(answer);
      await waitFor(() => expect(screen.queryByText(answer, {selector: '*'})).toBeTruthy());
      await waitFor(() => expect(screen.getByRole('textbox').getAttribute('aria-disabled')).not.toBe('true'));
    }
    expect(await screen.findByText(/The draft is ready/)).toBeTruthy();
    const cont = screen.getByRole('button', {name: 'Continue'});
    await waitFor(() => expect(cont.getAttribute('aria-disabled')).not.toBe('true'));
    await act(async () => {
      fireEvent.click(cont);
    });
    await waitFor(() => expect(nav.router.push).toHaveBeenCalledWith(expect.stringMatching(/^\/agents\/agt_[^/]+\/preview$/)));
    const created = requests.filter((r) => r.method === 'POST' && new URL(r.url).pathname === '/api/agents');
    expect(created).toHaveLength(1);
  });

  it('switching the business starts a session for it, and switching back resumes the first one', async () => {
    renderScreen();
    await screen.findByText('What would you like an agent to do for your business?');
    await send('I run a pizza shop and want an AI that takes pickup orders');
    await screen.findByText(/latest pickup time/);
    const pizzaSearch = nav.get();
    await clickButton('test: barbershop');
    await waitFor(() => expect(nav.get()).not.toBe(pizzaSearch));
    await clickButton('Book haircut appointments for my barbershop');
    expect(await screen.findByText(/Which services should it offer/)).toBeTruthy();
    const create = createCalls();
    expect(create.map((r) => new URL(r.url).searchParams.get('businessId'))).toEqual(['biz_pizza_01', 'biz_barber_01']);
    await clickButton('test: pizza');
    await waitFor(() => expect(nav.get()).toBe(pizzaSearch));
    expect(await screen.findByText(/latest pickup time/)).toBeTruthy();
    expect(createCalls()).toHaveLength(2);
  });

  it('never sends a not found session ID with another business after a switch', async () => {
    nav.set('/build?session=bld_gone_01');
    renderScreen();
    expect(await screen.findByText('This builder session was not found')).toBeTruthy();
    await clickButton('test: barbershop');
    expect(await screen.findByRole('button', {name: 'Book haircut appointments for my barbershop'})).toBeTruthy();
    const gets = requests.filter((r) => r.method === 'GET' && new URL(r.url).pathname.endsWith('/bld_gone_01'));
    expect(gets.map((r) => new URL(r.url).searchParams.get('businessId'))).toEqual(['biz_pizza_01']);
  });

  it('renders owner text as text, never as markup', async () => {
    renderScreen();
    await screen.findByText('What would you like an agent to do for your business?');
    await send('<img src=x onerror=alert(1)> take orders');
    expect(await screen.findByText('<img src=x onerror=alert(1)> take orders')).toBeTruthy();
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });
});
