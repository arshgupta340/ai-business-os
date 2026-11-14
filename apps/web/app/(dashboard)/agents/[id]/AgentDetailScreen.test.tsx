// @vitest-environment jsdom
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {http, HttpResponse} from 'msw';
import {useState, type ReactNode} from 'react';
import {QueryClientProvider} from '@tanstack/react-query';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {createApiQueryClient} from '@/lib/api';
import {BusinessProvider} from '@/lib/session';
import {BUSINESS_STORAGE_KEY} from '@/lib/session/business-selection';
import {mockControls, server} from '@/mocks/server';
import {requests, TEST_BASE_URL, useMockServer} from '@/mocks/test-setup';
import {notesKey} from '../../build/_lib/memory';
import {AgentDetailScreen} from './_components/AgentDetailScreen';

// A stand-in for next/navigation: the change field pushes to /build.
const nav = vi.hoisted(() => ({
  router: {push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn()},
}));

vi.mock('next/navigation', () => ({
  useRouter: () => nav.router,
  usePathname: () => '/agents',
  useSearchParams: () => new URLSearchParams(),
}));

useMockServer();

const A = `${TEST_BASE_URL}/api`;

beforeAll(() => {
  process.env.NEXT_PUBLIC_MOCK = '1';
  // jsdom has no CSS.escape and no modal dialog methods. The Astryx Dialog uses both.
  const g = globalThis as unknown as {CSS?: {escape?: (v: string) => string}};
  if (!g.CSS) g.CSS = {};
  if (!g.CSS.escape) g.CSS.escape = (v: string) => v.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  if (typeof proto.showModal !== 'function') {
    proto.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
  }
  if (typeof proto.close !== 'function') {
    proto.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  }
});

beforeEach(() => {
  nav.router.push.mockClear();
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

function renderDetail(agentId: string, businessId = 'biz_pizza_01') {
  window.localStorage.setItem(BUSINESS_STORAGE_KEY, businessId);
  render(
    <Providers>
      <AgentDetailScreen agentId={agentId} />
    </Providers>,
  );
}

function deferred() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {gate, release};
}

const countRequests = (method: string, pathEnd: string) =>
  requests.filter((r) => r.method === method && new URL(r.url).pathname.endsWith(pathEnd)).length;

// The first render loads every Astryx module, which can pass 5 seconds on a busy machine.
describe('AgentDetailScreen', {timeout: 20_000}, () => {
  it('pauses only after the owner confirms, and shows Paused only after the server answers', async () => {
    const {gate, release} = deferred();
    // Hold the pause request open. Returning nothing falls through to the mock handler.
    server.use(
      http.post(`${A}/agents/:id/pause`, async () => {
        await gate;
      }),
    );
    renderDetail('agt_pizza_01');
    expect(await screen.findByRole('heading', {level: 1, name: 'Pizza Order Assistant'})).toBeTruthy();

    fireEvent.click(screen.getByRole('button', {name: 'Pause agent'}));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/stops taking new calls\. Calls in progress finish/)).toBeTruthy();
    expect(countRequests('POST', '/pause')).toBe(0);

    fireEvent.click(within(dialog).getByRole('button', {name: 'Pause agent'}));
    await waitFor(() => expect(countRequests('POST', '/pause')).toBe(1));
    // The server has not answered yet: the badge still says Live.
    expect(screen.getAllByText('Live').length).toBeGreaterThan(0);
    expect(screen.queryByText('Paused')).toBeNull();

    release();
    await waitFor(() => expect(screen.getAllByText('Paused').length).toBeGreaterThan(0));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the state and explains INVALID_STATE when the server refuses to pause', async () => {
    server.use(
      http.post(`${A}/agents/:id/pause`, () =>
        HttpResponse.json(
          {code: 'INVALID_STATE', message: 'A draft agent cannot be paused.', correlationId: 'corr-1', retryable: false, details: {state: 'draft'}},
          {status: 409},
        ),
      ),
    );
    renderDetail('agt_pizza_01');
    fireEvent.click(await screen.findByRole('button', {name: 'Pause agent'}));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', {name: 'Pause agent'}));
    expect(await within(dialog).findByText('This agent is a draft. Publish before pausing.')).toBeTruthy();
    expect(within(dialog).queryByRole('button', {name: 'Try again'})).toBeNull();
    expect(screen.queryByText('Paused')).toBeNull();
  });

  it('names the agent being replaced, sends the switch once, and shows the result after the server answers', async () => {
    const {gate, release} = deferred();
    server.use(
      http.put(`${A}/live-agent`, async () => {
        await gate;
      }),
    );
    renderDetail('agt_barber_01', 'biz_barber_01');
    expect(await screen.findByText(/An agent of Demo Pizza Co\. answers the phone number/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', {name: 'Make this agent answer the phone'}));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/The agent of Demo Pizza Co\. stops answering\./)).toBeTruthy();

    const confirm = within(dialog).getByRole('button', {name: 'Make this agent answer'});
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(countRequests('PUT', '/live-agent')).toBe(1));
    expect(screen.queryByText('Answers the phone number')).toBeNull();

    release();
    expect(await screen.findByText('Answers the phone number')).toBeTruthy();
    expect(countRequests('PUT', '/live-agent')).toBe(1);
  });

  it('does not offer the live switch or pause for a draft agent', async () => {
    // The shared draft is the pizza FAQ line; the pizza order assistant holds the number.
    renderDetail('agt_pizza_faq_01');
    expect(await screen.findByText('Draft')).toBeTruthy();
    await screen.findByText('Pizza Order Assistant answers the phone number.');
    expect(screen.queryByRole('button', {name: 'Make this agent answer the phone'})).toBeNull();
    expect(screen.queryByRole('button', {name: 'Pause agent'})).toBeNull();
    expect(screen.getByText('Publish this agent before it can answer the phone number.')).toBeTruthy();
  });

  it('shows the empty live agent case and says no agent is replaced', async () => {
    await mockControls.simulateNoLiveAgent();
    renderDetail('agt_barber_01', 'biz_barber_01');
    expect(await screen.findByText('No agent is answering the phone number')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: 'Make this agent answer the phone'}));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/No agent answers the phone number now\./)).toBeTruthy();
  });

  it('treats an agent of the other business as not found', async () => {
    renderDetail('agt_barber_01', 'biz_pizza_01');
    expect(await screen.findByRole('heading', {name: 'Agent not found'})).toBeTruthy();
    expect(screen.queryByText('Booking Assistant')).toBeNull();
  });

  it('shows the phone number only for the agent that answers it, and links the last calls to Live operations', async () => {
    renderDetail('agt_pizza_01');
    expect(await screen.findByText('Answers the phone number')).toBeTruthy();
    expect(screen.getByText(/^\+1/)).toBeTruthy();
    await waitFor(() => {
      const hrefs = screen.getAllByRole('link').map((l) => l.getAttribute('href') ?? '');
      expect(hrefs.filter((h) => h.startsWith('/activity?call=call_')).length).toBeGreaterThan(0);
    });
    const links = screen.getAllByRole('link');
    expect(links.some((l) => l.getAttribute('href') === '/agents/agt_pizza_01/preview')).toBe(true);
    expect(links.some((l) => l.getAttribute('href') === '/agents/agt_pizza_01/versions')).toBe(true);
  });

  it('starts a builder session for this agent with the first instruction and opens the builder', async () => {
    renderDetail('agt_pizza_01');
    const field = await screen.findByLabelText('What should change');
    fireEvent.change(field, {target: {value: 'We close at 11 pm on Fridays now.'}});
    fireEvent.click(screen.getByRole('button', {name: 'Open in the builder'}));

    await waitFor(() => expect(nav.router.push).toHaveBeenCalledTimes(1));
    const url = String(nav.router.push.mock.calls[0]![0]);
    expect(url).toMatch(/^\/build\?session=bld_/);
    const sessionId = decodeURIComponent(url.split('=')[1]!);

    const create = requests.find((r) => r.method === 'POST' && new URL(r.url).pathname.endsWith('/builder/sessions'));
    expect(await create!.clone().json()).toEqual({agentId: 'agt_pizza_01'});
    const notes = JSON.parse(window.localStorage.getItem(notesKey(sessionId)) ?? '{}');
    expect(notes.proposedChanges).toEqual([expect.objectContaining({bundleType: 'fact_edit'})]);
  });
});
