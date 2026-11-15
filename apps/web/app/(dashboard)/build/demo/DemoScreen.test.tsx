// @vitest-environment jsdom
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {http, HttpResponse} from 'msw';
import type {ReactNode} from 'react';
import {useState} from 'react';
import {QueryClientProvider} from '@tanstack/react-query';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createApiQueryClient} from '@/lib/api/provider';
import {BusinessProvider} from '@/lib/session';
import {advanceMockClock, mockControls, server} from '@/mocks/server';
import {requests, TEST_BASE_URL, useMockServer} from '@/mocks/test-setup';
import BuildPage from '../page';
import {DemoScreen, SERVER_UNREACHABLE_TEXT} from './DemoScreen';
import {MISSING_NUMBER_TEXT} from './ResultPanel';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/build',
  useRouter: () => ({replace: vi.fn(), push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn()}),
}));

useMockServer();

const A = `${TEST_BASE_URL}/api`;
const POLL_MS = 150;

function Providers({children}: {children: ReactNode}) {
  const [client] = useState(createApiQueryClient);
  return (
    <QueryClientProvider client={client}>
      <BusinessProvider>{children}</BusinessProvider>
    </QueryClientProvider>
  );
}

function renderDemo(stepScale = 0) {
  return render(
    <Providers>
      <DemoScreen stepScale={stepScale} pollMs={POLL_MS} />
    </Providers>,
  );
}

async function click(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
}

async function clickButton(name: string | RegExp) {
  const button = await screen.findByRole('button', {name});
  await waitFor(() => expect(button.getAttribute('aria-disabled')).not.toBe('true'));
  await click(button);
}

async function sendPrompt() {
  await clickButton('Use the suggested prompt');
  await clickButton(/^send/i);
}

async function reachNumber() {
  await sendPrompt();
  await screen.findByText('Waiting for the call');
}

const decisionCalls = () => requests.filter((r) => r.method === 'POST' && new URL(r.url).pathname.endsWith('/decision'));

beforeEach(() => {
  window.localStorage.clear();
  vi.stubEnv('NEXT_PUBLIC_DEMO_PHONE_NUMBER', '+18055550123');
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('Build screen switch', () => {
  it('renders the normal builder when the flag is off', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_SCRIPT', '');
    render(<Providers>{BuildPage()}</Providers>);
    expect(await screen.findByText(/Describe the job and answer a few questions/)).toBeTruthy();
    expect(screen.queryByText('Demo')).toBeNull();
  });

  it('renders the demo run when the flag is on', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_SCRIPT', '1');
    render(<Providers>{BuildPage()}</Providers>);
    expect(await screen.findByText('Demo run. This agent was set up before the demo.')).toBeTruthy();
    expect(screen.getByText('Demo')).toBeTruthy();
  });
});

describe('Demo run: the build step', {timeout: 30000}, () => {
  it('shows the message, plays the steps in order and makes no request before the number', async () => {
    renderDemo(0.02);
    expect(await screen.findByRole('button', {name: 'Use the suggested prompt'})).toBeTruthy();
    expect(requests).toHaveLength(0);
    await sendPrompt();
    expect(await screen.findByText(/Create a voice calling agent for this pizza shop/)).toBeTruthy();
    expect(screen.getByText('Reading the menu')).toBeTruthy();
    expect(screen.getByText('Getting a phone number')).toBeTruthy();
    expect(requests).toHaveLength(0);
    await screen.findByText('Call this number to order');
    // The only reads are the finale's pending approvals, after the number shows.
    expect(requests.every((r) => new URL(r.url).pathname === '/api/approvals')).toBe(true);
    expect(screen.getByText('+1 (805) 555 0123')).toBeTruthy();
    expect(screen.getByText('Small $12.00, Medium $16.00, Large $20.00')).toBeTruthy();
    expect(screen.getByText('Waiting for the call')).toBeTruthy();
  });

  it('still reaches the number when every API request fails', async () => {
    server.use(http.all(`${A}/*`, () => HttpResponse.json({error: {code: 'INTERNAL', message: 'down'}}, {status: 500})));
    renderDemo();
    await reachNumber();
    expect(screen.getByText('+1 (805) 555 0123')).toBeTruthy();
    expect(screen.getByText('Waiting for the call')).toBeTruthy();
  });

  it('says plainly that the number is not set in real mode', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_PHONE_NUMBER', '');
    renderDemo();
    await reachNumber();
    expect(screen.getByText(MISSING_NUMBER_TEXT)).toBeTruthy();
    expect(screen.queryByText(/\+1 \(/)).toBeNull();
  });

  it('falls back to the fixture number in mock mode', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_PHONE_NUMBER', '');
    vi.stubEnv('NEXT_PUBLIC_MOCK', '1');
    renderDemo();
    await reachNumber();
    expect(screen.getByText('+1 (555) 555 0199')).toBeTruthy();
  });
});

describe('Demo run: the finale', {timeout: 30000}, () => {
  it('ignores an order created before the number was shown and shows a new one by itself', async () => {
    await mockControls.startPizzaCall();
    renderDemo();
    await reachNumber();
    // Wait through a few polls: the earlier order and the seeded ones never show.
    await new Promise((r) => setTimeout(r, POLL_MS * 4));
    expect(screen.getByText('Waiting for the call')).toBeTruthy();
    expect(screen.queryByText('New order')).toBeNull();

    await act(async () => {
      await mockControls.startPizzaCall();
    });
    expect(await screen.findByText('New order')).toBeTruthy();
    expect(await screen.findByText('1 x Large Margherita')).toBeTruthy();
    expect(screen.getByText('Toppings: Mushrooms')).toBeTruthy();
    expect(screen.getByText(/^Pickup at /)).toBeTruthy();
    expect(screen.queryByText('Waiting for the call')).toBeNull();
  });

  it('shows the order through the live updates in mock mode', async () => {
    vi.stubEnv('NEXT_PUBLIC_MOCK', '1');
    render(
      <Providers>
        <DemoScreen stepScale={0} pollMs={60_000} />
      </Providers>,
    );
    await reachNumber();
    await act(async () => {
      await mockControls.startPizzaCall();
    });
    expect(await screen.findByText('New order')).toBeTruthy();
  });

  it('keeps waiting with a small line when a poll fails, and shows the order when a later poll works', async () => {
    renderDemo();
    await reachNumber();
    mockControls.simulateRequestFailure?.({path: '/api/approvals', code: 'VALIDATION_FAILED', times: 2});
    expect(await screen.findByText(SERVER_UNREACHABLE_TEXT)).toBeTruthy();
    expect(screen.getByText('Waiting for the call')).toBeTruthy();
    await act(async () => {
      await mockControls.startPizzaCall();
    });
    expect(await screen.findByText('New order')).toBeTruthy();
  });

  async function orderOnScreen() {
    renderDemo();
    await reachNumber();
    let approvalId = '';
    await act(async () => {
      ({approvalId} = await mockControls.startPizzaCall());
    });
    await screen.findByText('1 x Large Margherita');
    expect(screen.getByText(/^Expires in \d+:\d\d$/)).toBeTruthy();
    return approvalId;
  }

  it('sends exactly one decision with an idempotency key and shows Approved only after the answer', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // Holds the decision, then falls through to the mock handler.
    server.use(
      http.post(`${A}/approvals/:id/decision`, async () => {
        await gate;
      }),
    );
    const approvalId = await orderOnScreen();
    const approve = await screen.findByRole('button', {name: 'Approve'});
    await waitFor(() => expect(approve.getAttribute('aria-disabled')).not.toBe('true'));
    requests.length = 0;
    await click(approve);
    await click(approve);
    await waitFor(() => expect(decisionCalls()).toHaveLength(1));
    expect(screen.queryByText('Approved')).toBeNull();
    const call = decisionCalls()[0]!;
    expect(new URL(call.url).pathname).toBe(`/api/approvals/${approvalId}/decision`);
    expect(call.headers.get('idempotency-key')).toBeTruthy();
    expect(await call.clone().json()).toMatchObject({decision: 'approve'});
    await act(async () => {
      release();
    });
    expect((await screen.findAllByText('Approved')).length).toBeGreaterThan(0);
    expect(decisionCalls()).toHaveLength(1);
    expect(screen.queryByRole('button', {name: 'Approve'})).toBeNull();
    // What the server reports next for the order, from statusView('order', ...).
    expect(await screen.findByText('Now:')).toBeTruthy();
  });

  it('says the order expired and never shows Approved', async () => {
    await orderOnScreen();
    advanceMockClock(11 * 60_000);
    await clickButton('Approve');
    expect(await screen.findByText('Expired, nothing was sent')).toBeTruthy();
    expect(screen.queryByText('Approved')).toBeNull();
  });

  it('says a failed decision plainly and never shows Approved', async () => {
    await orderOnScreen();
    mockControls.simulateRequestFailure?.({path: '/api/approvals/', method: 'POST', code: 'INTERNAL'});
    await clickButton('Approve');
    expect(await screen.findByText('The decision did not go through')).toBeTruthy();
    expect(screen.getByRole('button', {name: 'Try again'})).toBeTruthy();
    expect(screen.queryByText('Approved')).toBeNull();
  });

  it('start over goes back to the composer', async () => {
    renderDemo();
    await reachNumber();
    await clickButton('Start over');
    expect(await screen.findByRole('button', {name: 'Use the suggested prompt'})).toBeTruthy();
    expect(screen.queryByText('Call this number to order')).toBeNull();
  });
});
