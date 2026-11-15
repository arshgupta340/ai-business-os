// @vitest-environment jsdom
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {http, HttpResponse} from 'msw';
import type {ReactNode} from 'react';
import {useState} from 'react';
import {QueryClientProvider} from '@tanstack/react-query';
import {bookingVerified, STAGE_SHOPS, type StageShopKey} from '@abos/contracts/fixtures';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createApiQueryClient} from '@/lib/api/provider';
import {BusinessProvider, useBusiness} from '@/lib/session';
import {advanceMockClock, mockControls, server} from '@/mocks/server';
import {requests, TEST_BASE_URL, useMockServer} from '@/mocks/test-setup';
import BuildPage from '../page';
import {DemoScreen, SERVER_UNREACHABLE_TEXT} from './DemoScreen';
import {addFiles} from './DemoChat';
import {missingNumberText, NO_SHOP_TEXT, shopNotFoundText} from './stage-shop';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/build',
  useRouter: () => ({replace: vi.fn(), push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn()}),
}));

useMockServer();

const A = `${TEST_BASE_URL}/api`;
const POLL_MS = 150;

/** Shows the selected business, so a test can see the switch. */
function SelectedBusiness() {
  const {businessId} = useBusiness();
  return <output data-testid="selected-business">{businessId ?? ''}</output>;
}

function Providers({children}: {children: ReactNode}) {
  const [client] = useState(createApiQueryClient);
  return (
    <QueryClientProvider client={client}>
      <BusinessProvider>
        <SelectedBusiness />
        {children}
      </BusinessProvider>
    </QueryClientProvider>
  );
}

function renderDemo(stepScale = 0, approveHoldMs = 0) {
  return render(
    <Providers>
      <DemoScreen stepScale={stepScale} pollMs={POLL_MS} approveHoldMs={approveHoldMs} />
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

/** Attaches the shop's menu or service list, as the presenter does on stage. */
async function attachShop(key: StageShopKey) {
  await attach(pdf(STAGE_SHOPS[key].files.info));
}

async function sendPrompt(key?: StageShopKey) {
  if (key) await attachShop(key);
  await clickButton('Use the suggested prompt');
  await clickButton(/^send/i);
}

async function reachNumber(key: StageShopKey = 'pizza') {
  await sendPrompt(key);
  await screen.findByText('Waiting for the call');
}

const selected = () => screen.getByTestId('selected-business').textContent;

const decisionCalls = () => requests.filter((r) => r.method === 'POST' && new URL(r.url).pathname.endsWith('/decision'));

beforeEach(() => {
  window.localStorage.clear();
  vi.stubEnv('NEXT_PUBLIC_DEMO_PHONE_NUMBER', '');
  vi.stubEnv('NEXT_PUBLIC_DEMO_PHONE_PIZZA', '+18055550123');
  vi.stubEnv('NEXT_PUBLIC_DEMO_PHONE_BARBER', '+18055550124');
  vi.stubEnv('NEXT_PUBLIC_DEMO_PHONE_SALON', '+18055550125');
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
    expect(await screen.findByText('Use the suggested prompt')).toBeTruthy();
    // Arsh's decision on 2026-11-14: no demo badge on the screen.
    expect(screen.queryByText('Demo run. This agent was set up before the demo.')).toBeNull();
    expect(screen.queryByText('Demo')).toBeNull();
  });
});

const pdf = (name: string) => new File(['x'], name, {type: 'application/pdf'});
const MENU_PDF = STAGE_SHOPS.pizza.files.info;
const FAQ_PDF = STAGE_SHOPS.pizza.files.faq;

async function attach(...files: File[]) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  await act(async () => {
    fireEvent.change(input, {target: {files}});
  });
}

describe('Demo composer attachments', {timeout: 30000}, () => {
  it('adds a second pick to the list and skips a name already there', () => {
    const first = addFiles([], [pdf(MENU_PDF)]);
    const second = addFiles(first, [pdf(FAQ_PDF), pdf(MENU_PDF)]);
    expect(second.map((f) => f.name)).toEqual([MENU_PDF, FAQ_PDF]);
    expect(addFiles(second, null)).toHaveLength(2);
  });

  it('accepts several files, shows one removable token each, and sends both names without a request', async () => {
    renderDemo(0.02);
    await screen.findByRole('button', {name: 'Use the suggested prompt'});
    expect(document.querySelector<HTMLInputElement>('input[type="file"]')!.multiple).toBe(true);
    await attach(pdf(MENU_PDF));
    await attach(pdf(FAQ_PDF), pdf(MENU_PDF));
    expect(screen.getAllByText(MENU_PDF)).toHaveLength(1);
    expect(screen.getAllByText(FAQ_PDF)).toHaveLength(1);
    expect(screen.getAllByRole('button', {name: /remove/i}).length).toBeGreaterThanOrEqual(2);
    await sendPrompt();
    expect(await screen.findByText(/Create a voice calling agent for this pizza place/)).toBeTruthy();
    expect(screen.getByText(MENU_PDF)).toBeTruthy();
    expect(screen.getByText(FAQ_PDF)).toBeTruthy();
    expect(requests).toHaveLength(0);
  });

  it('selects the shop by an attached file name: one barbershop file is enough', async () => {
    renderDemo(0.02);
    await attach(pdf('notes.pdf'), pdf(STAGE_SHOPS.barber.files.faq));
    await sendPrompt();
    expect(await screen.findByText(/Create a voice calling agent for this barbershop/)).toBeTruthy();
    expect(screen.getByText('Reading the services')).toBeTruthy();
  });

  it('keeps the suggested prompt off, with one plain line, until a recognized file is attached', async () => {
    renderDemo(0.02);
    const suggest = await screen.findByRole('button', {name: 'Use the suggested prompt'});
    expect(suggest.getAttribute('aria-disabled') === 'true' || (suggest as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(NO_SHOP_TEXT)).toBeTruthy();
    await attach(pdf('menu.pdf'));
    expect(screen.getByText(NO_SHOP_TEXT)).toBeTruthy();
    await click(suggest);
    expect(screen.queryByText(/Create a voice calling agent/)).toBeNull();
    await attach(pdf(STAGE_SHOPS.barber.files.info));
    expect(screen.queryByText(NO_SHOP_TEXT)).toBeNull();
  });
});

describe('Demo composer: the shop comes only from the attached files', {timeout: 30000}, () => {
  it('lists no shops and says nothing about picking one', async () => {
    renderDemo();
    expect(await screen.findByText('Attach your menu or service list and your FAQs, then send.')).toBeTruthy();
    expect(screen.getByText(NO_SHOP_TEXT)).toBeTruthy();
    for (const shop of Object.values(STAGE_SHOPS)) {
      expect(screen.queryByText(shop.kindLabel)).toBeNull();
      expect(screen.queryByText(shop.blurb)).toBeNull();
      expect(screen.queryByText(shop.name)).toBeNull();
    }
    expect(screen.queryByText(/pick/i)).toBeNull();
  });

  it.each([
    ['pizza', 'info', /Create a voice calling agent for this pizza place/, 'Reading the menu'],
    ['pizza', 'faq', /Create a voice calling agent for this pizza place/, 'Reading the menu'],
    ['barber', 'info', /Create a voice calling agent for this barbershop/, 'Reading the services'],
    ['barber', 'faq', /Create a voice calling agent for this barbershop/, 'Reading the services'],
  ] as const)("the %s shop's %s file alone selects it and sends", async (key, which, prompt, firstStep) => {
    renderDemo(0.02);
    await screen.findByText(NO_SHOP_TEXT);
    await attach(pdf(STAGE_SHOPS[key].files[which]));
    expect(screen.queryByText(NO_SHOP_TEXT)).toBeNull();
    await sendPrompt();
    expect(await screen.findByText(prompt)).toBeTruthy();
    expect(screen.getByText(firstStep)).toBeTruthy();
    await waitFor(() => expect(selected()).toBe(STAGE_SHOPS[key].businessId));
  });

  it("the salon's file selects the salon, which is not a seeded business here: one plain line, and no steps", async () => {
    renderDemo(0.02);
    await attach(pdf(STAGE_SHOPS.salon.files.faq));
    await sendPrompt();
    expect(await screen.findByText(shopNotFoundText(STAGE_SHOPS.salon))).toBeTruthy();
    expect(screen.queryByText('Reading the services')).toBeNull();
    expect(selected()).toBe(STAGE_SHOPS.pizza.businessId);
  });

  it('an unrecognized file leaves the suggested prompt off and Send does nothing', async () => {
    renderDemo(0.02);
    await attach(pdf('OurMenu.pdf'), pdf('FAQ.pdf'));
    expect(screen.getByText('OurMenu.pdf')).toBeTruthy();
    expect(screen.getByText(NO_SHOP_TEXT)).toBeTruthy();
    const suggest = screen.getByRole('button', {name: 'Use the suggested prompt'});
    expect(suggest.getAttribute('aria-disabled') === 'true' || (suggest as HTMLButtonElement).disabled).toBe(true);
    await click(suggest);
    const send = screen.queryByRole('button', {name: /^send/i});
    if (send) await click(send);
    expect(screen.queryByText(/Create a voice calling agent/)).toBeNull();
    expect(screen.queryByText('Reading the menu')).toBeNull();
    expect(screen.queryByText('Reading the services')).toBeNull();
  });

  it("with two shops' files attached, the first attached file decides", async () => {
    renderDemo(0.02);
    await attach(pdf(STAGE_SHOPS.barber.files.info));
    await attach(pdf(STAGE_SHOPS.pizza.files.info));
    await sendPrompt();
    expect(await screen.findByText(/Create a voice calling agent for this barbershop/)).toBeTruthy();
    await waitFor(() => expect(selected()).toBe(STAGE_SHOPS.barber.businessId));
  });

  it('removing the deciding file hands the choice to the next recognized file', async () => {
    renderDemo(0.02);
    await attach(pdf(STAGE_SHOPS.barber.files.info), pdf(STAGE_SHOPS.pizza.files.faq));
    const removeButtons = screen.getAllByRole('button', {name: /remove/i});
    const removeBarber = removeButtons.find((b) => (b.getAttribute('aria-label') ?? '').includes(STAGE_SHOPS.barber.files.info)) ?? removeButtons[0]!;
    await click(removeBarber);
    await sendPrompt();
    expect(await screen.findByText(/Create a voice calling agent for this pizza place/)).toBeTruthy();
  });

  it('removes one attached file with its token', async () => {
    renderDemo(0.02);
    await screen.findByRole('button', {name: 'Use the suggested prompt'});
    await attach(pdf(MENU_PDF), pdf(FAQ_PDF));
    const removeButtons = screen.getAllByRole('button', {name: /remove/i});
    const removeMenu = removeButtons.find((b) => (b.getAttribute('aria-label') ?? '').includes(MENU_PDF)) ?? removeButtons[0]!;
    await click(removeMenu);
    expect(screen.queryByText(MENU_PDF)).toBeNull();
    expect(screen.getByText(FAQ_PDF)).toBeTruthy();
  });
});

describe('Demo run: the build step', {timeout: 30000}, () => {
  it('shows the message, plays the steps in order and makes no request before the number', async () => {
    renderDemo(0.02);
    expect(await screen.findByRole('button', {name: 'Use the suggested prompt'})).toBeTruthy();
    expect(requests).toHaveLength(0);
    await sendPrompt('pizza');
    expect(await screen.findByText(/Create a voice calling agent for this pizza place/)).toBeTruthy();
    expect(screen.getByText('Reading the menu')).toBeTruthy();
    expect(screen.getByText('Getting a phone number')).toBeTruthy();
    expect(requests).toHaveLength(0);
    await screen.findByText(STAGE_SHOPS.pizza.callerAction);
    // The only reads are the finale's pending approvals, after the number shows.
    expect(requests.every((r) => new URL(r.url).pathname === '/api/approvals')).toBe(true);
    expect(screen.getByText('(805) 555-0123')).toBeTruthy();
    expect(screen.getByText('$15')).toBeTruthy();
    expect(screen.getByText('$35')).toBeTruthy();
    expect(screen.getByText('Supreme')).toBeTruthy();
    expect(screen.getByText('Waiting for the call')).toBeTruthy();
  });

  it("shows the barbershop's own number and its services", async () => {
    renderDemo();
    await reachNumber('barber');
    expect(screen.getByText(STAGE_SHOPS.barber.name)).toBeTruthy();
    expect(screen.getByText('(805) 555-0124')).toBeTruthy();
    expect(screen.getByText('Beard trim')).toBeTruthy();
    expect(screen.queryByText('(805) 555-0123')).toBeNull();
  });

  it('still reaches the number when every API request fails', async () => {
    server.use(http.all(`${A}/*`, () => HttpResponse.json({error: {code: 'INTERNAL', message: 'down'}}, {status: 500})));
    renderDemo();
    await reachNumber();
    expect(screen.getByText('(805) 555-0123')).toBeTruthy();
    expect(screen.getByText('Waiting for the call')).toBeTruthy();
  });

  it('says plainly that the number is not set in real mode', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_PHONE_PIZZA', '');
    renderDemo();
    await reachNumber();
    expect(screen.getByText(missingNumberText('pizza'))).toBeTruthy();
    expect(screen.queryByText(/\+1 \(/)).toBeNull();
  });

  it('falls back to the fixture number in mock mode', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_PHONE_PIZZA', '');
    vi.stubEnv('NEXT_PUBLIC_MOCK', '1');
    renderDemo();
    await reachNumber();
    expect(screen.getByText('(555) 555-0199')).toBeTruthy();
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

  async function orderOnScreen(approveHoldMs = 0) {
    renderDemo(0, approveHoldMs);
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

  it('shows Approving for the hold time, and Approved only after the server answered and the hold is over', async () => {
    await orderOnScreen(500);
    await clickButton('Approve');
    expect(await screen.findByText('Approving the order')).toBeTruthy();
    expect(screen.queryByText('Approved')).toBeNull();
    expect(screen.queryByRole('button', {name: 'Approve'})).toBeNull();
    await waitFor(() => expect(decisionCalls()).toHaveLength(1));
    expect((await screen.findAllByText('Approved', undefined, {timeout: 3000})).length).toBeGreaterThan(0);
    expect(screen.queryByText('Approving the order')).toBeNull();
    expect(screen.getByText('The shop accepted this order')).toBeTruthy();
    expect(decisionCalls()).toHaveLength(1);
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
    expect(screen.queryByText(STAGE_SHOPS.pizza.callerAction)).toBeNull();
    // The choice is cleared: no shop is attached, so the suggestion is off again.
    expect(screen.getByText(NO_SHOP_TEXT)).toBeTruthy();
    expect(screen.queryByText(MENU_PDF)).toBeNull();
  });
});

describe('Demo run: the booking finale', {timeout: 30000}, () => {
  async function bookingOnScreen(approveHoldMs = 0) {
    renderDemo(0, approveHoldMs);
    await reachNumber('barber');
    let approvalId = '';
    await act(async () => {
      ({approvalId} = await mockControls.startBookingCall());
    });
    expect(await screen.findByText('New booking')).toBeTruthy();
    return approvalId;
  }

  it('shows the booking: service, date and time, customer, duration and a sandbox price', async () => {
    await bookingOnScreen();
    // The booking's customer shows once the booking itself has loaded.
    expect(await screen.findByText(bookingVerified.customer.name)).toBeTruthy();
    // The service shows in the services panel and on the card.
    expect(screen.getAllByText('Haircut')).toHaveLength(2);
    expect(screen.getByText(/^[A-Z][a-z]{2},\s[A-Z][a-z]{2}\s\d{1,2},\s\d{1,2}:\d\d\s[AP]M$/)).toBeTruthy();
    expect(screen.getAllByText('30 minutes')).toHaveLength(2);
    expect(screen.getAllByText('Sandbox').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$30.00').length).toBeGreaterThan(0);
    expect(screen.getByText(/^Expires in \d+:\d\d$/)).toBeTruthy();
  });

  it('sends exactly one decision and shows Approved only after the answer', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    server.use(
      http.post(`${A}/approvals/:id/decision`, async () => {
        await gate;
      }),
    );
    const approvalId = await bookingOnScreen(300);
    await screen.findByText(bookingVerified.customer.name);
    const approve = await screen.findByRole('button', {name: 'Approve'});
    await waitFor(() => expect(approve.getAttribute('aria-disabled')).not.toBe('true'));
    requests.length = 0;
    await click(approve);
    await click(approve);
    expect(await screen.findByText('Approving the booking')).toBeTruthy();
    await waitFor(() => expect(decisionCalls()).toHaveLength(1));
    expect(new URL(decisionCalls()[0]!.url).pathname).toBe(`/api/approvals/${approvalId}/decision`);
    expect(decisionCalls()[0]!.headers.get('idempotency-key')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.queryByText('Approved')).toBeNull();
    await act(async () => {
      release();
    });
    expect((await screen.findAllByText('Approved', undefined, {timeout: 3000})).length).toBeGreaterThan(0);
    expect(screen.getByText('The shop accepted this booking')).toBeTruthy();
    expect(decisionCalls()).toHaveLength(1);
  });
});
