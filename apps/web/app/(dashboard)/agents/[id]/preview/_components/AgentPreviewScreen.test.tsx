// @vitest-environment jsdom
import {act, cleanup, configure, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {delay, http, HttpResponse} from 'msw';
import type {ReactNode} from 'react';
import {useState} from 'react';
import {QueryClientProvider} from '@tanstack/react-query';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import * as api from '@/lib/api/client';
import {createApiQueryClient} from '@/lib/api/provider';
import {BusinessProvider} from '@/lib/session';
import {BUSINESS_STORAGE_KEY} from '@/lib/session/business-selection';
import {server} from '@/mocks/server';
import {requests, TEST_BASE_URL, useMockServer} from '@/mocks/test-setup';
import {AgentPreviewScreen} from './AgentPreviewScreen';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/agents/x/preview',
  useRouter: () => ({
    replace: vi.fn(),
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

// jsdom has no CSS.escape and no modal dialog methods, which the Astryx Dialog uses.
const g = globalThis as unknown as {CSS?: {escape?: (s: string) => string}};
g.CSS ??= {};
g.CSS.escape ??= (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
if (typeof HTMLDialogElement !== 'undefined') {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.show ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
}

// These tests walk several server round trips each. Give them room on a busy machine.
configure({asyncUtilTimeout: 5000});

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

function renderScreen(agentId: string) {
  return render(
    <Providers>
      <AgentPreviewScreen agentId={agentId} />
    </Providers>,
  );
}

async function createPizzaDraft(name = 'Pizza Test Agent') {
  // CreateAgentBodySchema: a spec sent directly is a full AgentSpec.
  const agent = await api.createAgent(PIZZA, {
    spec: {
      id: 'agt_pizza_test',
      businessId: PIZZA,
      version: 1,
      status: 'draft',
      guardrailVersion: 'v1',
      template: 'restaurant_order_taker',
      name,
      channel: 'phone',
      goal: 'Take pickup orders by phone.',
      knowledgeScopes: ['catalog', 'hours'],
      capabilities: ['catalog.read', 'order.quote', 'order.propose', 'order.checkout.prepare', 'message.checkout.send'],
      writePolicy: 'owner_approval_each_action_bundle',
      escalation: 'explain_unsupported_or_offer_callback',
    },
  });
  requests.length = 0;
  return agent;
}

async function resolveRequiredConflict() {
  await api.resolveConflict(PIZZA, 'cfl_pizza_01');
  requests.length = 0;
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

async function send(text: string) {
  const input = await screen.findByRole('textbox');
  await waitFor(() => expect(input.getAttribute('aria-disabled')).not.toBe('true'));
  await act(async () => {
    input.textContent = text;
    fireEvent.input(input);
  });
  await clickButton(/^send/i);
}

const publishCalls = () => requests.filter((r) => r.method === 'POST' && new URL(r.url).pathname.endsWith('/publish'));
const writes = () => requests.filter((r) => r.method !== 'GET' && !/\/(preview|test)$/.test(new URL(r.url).pathname));

async function openPublishDialog() {
  await clickButton('Publish');
  return screen.findByRole('dialog');
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('Agent preview', {timeout: 30000}, () => {
  it('shows the agent, the permission groups and the example calls marked as mock', async () => {
    const agent = await createPizzaDraft();
    renderScreen(agent.id);
    expect(await screen.findByText('Preview: Pizza Test Agent')).toBeTruthy();
    expect(screen.getByText('Take pickup orders by phone.')).toBeTruthy();
    expect(await screen.findByText('Example call, mock tools')).toBeTruthy();
    expect(screen.getByText('Reads only')).toBeTruthy();
    expect(screen.getByText('Proposes, you approve')).toBeTruthy();
    expect(screen.getByText('Runs only after your approval')).toBeTruthy();
    expect(screen.getByText('A caller tries to change a price')).toBeTruthy();
    expect(screen.getByText('Draft')).toBeTruthy();
    // The pizza fixture has an open required conflict: it is shown next to the button.
    expect(await screen.findByText('A required conflict is open')).toBeTruthy();
    expect(screen.getAllByRole('link', {name: 'Resolve in Knowledge'})[0].getAttribute('href')).toBe('/knowledge');
    expect(screen.getByRole('link', {name: 'Agent details'}).getAttribute('href')).toBe(`/agents/${agent.id}`);
  });

  it('disables the simulated call for a draft and says why', async () => {
    const agent = await createPizzaDraft();
    renderScreen(agent.id);
    const sim = await screen.findByRole('radio', {name: 'Simulated call'});
    expect(sim.hasAttribute('disabled') || sim.getAttribute('aria-disabled') === 'true').toBe(true);
    expect(screen.getByText(/Simulated call is off: Publish this agent first/)).toBeTruthy();
  });

  it('test console: a price change is refused distinctly, and a mock approval is labelled and never linked', async () => {
    const agent = await createPizzaDraft();
    renderScreen(agent.id);
    await screen.findByText('Example call, mock tools');
    expect(screen.getAllByText('Test with mock tools').length).toBeGreaterThan(0);
    await clickButton('Change the price of the large margherita to zero');
    expect(await screen.findByText('The agent refused this request')).toBeTruthy();
    expect(screen.getByText('no_fact_changes')).toBeTruthy();
    expect(screen.getByText('Refused')).toBeTruthy();

    await send('Yes, that is right. Send it to the shop.');
    expect(await screen.findByText('Proposed an order')).toBeTruthy();
    const mockId = await screen.findByText(/^apv_mock_/);
    expect(mockId).toBeTruthy();
    expect(screen.getAllByText('Mock approval').length).toBeGreaterThan(0);
    expect(screen.getByText('This approval is not stored. It does not appear in your Approvals inbox.')).toBeTruthy();
    const approvalLinks = screen.queryAllByRole('link').filter((a) => (a.getAttribute('href') ?? '').startsWith('/approvals'));
    expect(approvalLinks).toHaveLength(0);
    // Nothing but preview and test calls went out.
    expect(writes()).toHaveLength(0);
  });

  it('reset starts a new test session', async () => {
    const agent = await createPizzaDraft();
    renderScreen(agent.id);
    await clickButton('What time do you close on Friday?');
    await screen.findByText(/Test session/);
    await clickButton('Reset conversation');
    expect(screen.queryByText(/Test session/)).toBeNull();
    await clickButton('What time do you close on Friday?');
    await screen.findByText(/Test session/);
    const bodies = await Promise.all(
      requests.filter((r) => new URL(r.url).pathname.endsWith('/test')).map((r) => r.clone().json() as Promise<{testSessionId?: string}>),
    );
    expect(bodies.map((b) => b.testSessionId)).toEqual([undefined, undefined]);
  });

  it('publishes once with confirm: true and the chosen makeLive, and shows the published state only after the server answers', async () => {
    await resolveRequiredConflict();
    const agent = await createPizzaDraft();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.post(`${A}/agents/:id/publish`, async () => {
        await gate;
        return undefined;
      }),
    );
    renderScreen(agent.id);
    const dialog = await openPublishDialog();
    expect(within(dialog).getByText(/A new version is created from this draft/)).toBeTruthy();
    expect(await within(dialog).findByText(/Pizza Order Assistant keeps answering/)).toBeTruthy();
    await click(within(dialog).getByRole('checkbox'));
    expect(within(dialog).getByText(/It starts answering \+1.*replacing Pizza Order Assistant/)).toBeTruthy();
    const confirm = within(dialog).getByRole('button', {name: 'Publish now'});
    await act(async () => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });
    await waitFor(() => expect(publishCalls()).toHaveLength(1));
    expect(screen.queryByText(/Published as version/)).toBeNull();
    await act(async () => {
      release();
    });
    expect(await screen.findByText('Published as version 1')).toBeTruthy();
    expect(publishCalls()).toHaveLength(1);
    expect(await publishCalls()[0].clone().json()).toEqual({
      confirm: true,
      makeLive: true,
    });
    expect(screen.getByText(/This agent is live and answers \+1/)).toBeTruthy();
  });

  it('sends makeLive: false when the box is not ticked', async () => {
    await resolveRequiredConflict();
    const agent = await createPizzaDraft();
    renderScreen(agent.id);
    const dialog = await openPublishDialog();
    await click(within(dialog).getByRole('button', {name: 'Publish now'}));
    expect(await screen.findByText('Published as version 1')).toBeTruthy();
    expect(await publishCalls()[0].clone().json()).toEqual({
      confirm: true,
      makeLive: false,
    });
    expect(screen.getByText(/It does not answer/)).toBeTruthy();
  });

  it('shows the server refusal for an open required conflict with a link to Knowledge', async () => {
    const agent = await createPizzaDraft();
    renderScreen(agent.id);
    const dialog = await openPublishDialog();
    await click(within(dialog).getByRole('button', {name: 'Publish now'}));
    expect(await within(dialog).findByText('Publish was refused: a required conflict is open')).toBeTruthy();
    expect(within(dialog).getByText('cfl_pizza_01')).toBeTruthy();
    expect(within(dialog).getByRole('link', {name: 'Resolve in Knowledge'}).getAttribute('href')).toBe('/knowledge');
    expect(screen.queryByText(/Published as version/)).toBeNull();
  });

  const errorCases: [string, number, Record<string, unknown>, string, string | null][] = [
    ['CAPABILITY_NOT_ALLOWED', 422, {}, 'Publish was refused: a capability is not allowed', '/build'],
    ['INTEGRATION_UNAVAILABLE', 503, {provider: 'Square'}, 'Publish did not finish', '/integrations'],
    ['ENVIRONMENT_MISMATCH', 503, {}, 'Publish was refused: Square is not in sandbox', '/integrations'],
    [
      'VALIDATION_FAILED',
      400,
      {issues: [{path: 'draftSpec.capabilities', message: 'Required'}]},
      'Publish was refused: the draft is not valid',
      '/build',
    ],
    ['NOT_FOUND', 404, {}, 'This agent was not found', '/agents'],
  ];

  it.each(errorCases)('renders %s with its own message and next step', async (code, status, details, title, href) => {
    const agent = await createPizzaDraft();
    server.use(
      http.post(`${A}/agents/:id/publish`, () =>
        HttpResponse.json(
          {
            code,
            message: `Server: ${code}`,
            correlationId: 'cor_x',
            retryable: code === 'INTEGRATION_UNAVAILABLE',
            details,
          },
          {status},
        ),
      ),
    );
    renderScreen(agent.id);
    const dialog = await openPublishDialog();
    await click(within(dialog).getByRole('button', {name: 'Publish now'}));
    expect(await within(dialog).findByText(title)).toBeTruthy();
    if (href)
      expect(
        within(dialog)
          .getAllByRole('link')
          .some((a) => a.getAttribute('href') === href),
      ).toBe(true);
    if (code === 'INTEGRATION_UNAVAILABLE') {
      expect(within(dialog).getByText(/Square is not responding/)).toBeTruthy();
      expect(within(dialog).getByRole('button', {name: 'Try again'})).toBeTruthy();
    }
    if (code === 'VALIDATION_FAILED') expect(within(dialog).getByText('draftSpec.capabilities: Required')).toBeTruthy();
    expect(within(dialog).getByText('Reference: cor_x')).toBeTruthy();
    expect(screen.queryByText(/Published as version/)).toBeNull();
  });

  it('places a simulated call on a live agent: real approval linked to the inbox, call linked to Activity, End call', async () => {
    renderScreen('agt_pizza_01');
    const sim = await screen.findByRole('radio', {name: 'Simulated call'});
    await click(sim);
    expect(await screen.findByText('Simulated call with the real read and propose tools')).toBeTruthy();
    await clickButton('One large margherita with mushrooms and one large pepperoni for pickup at 7');
    expect(await screen.findByText('Priced the order')).toBeTruthy();
    const activity = await screen.findByRole('link', {
      name: 'See this call in Activity',
    });
    expect(activity.getAttribute('href')).toMatch(/^\/activity\?call=call_/);
    await clickButton('Yes, that is right. Send it to the shop.');
    const review = await screen.findByRole('link', {
      name: 'Review in Approvals',
    });
    expect(review.getAttribute('href')).toMatch(/^\/approvals\?id=apv_(?!mock_)/);
    expect(screen.getAllByText('Real tool').length).toBeGreaterThan(0);
    await clickButton('End call');
    expect(await screen.findByText('Call ended')).toBeTruthy();
    const sims = requests.filter((r) => new URL(r.url).pathname.endsWith('/sim-call'));
    const last = (await sims[sims.length - 1].clone().json()) as {
      end?: boolean;
      callId?: string;
    };
    expect(last.end).toBe(true);
    expect(last.callId).toMatch(/^call_/);
  });

  it('handles INVALID_STATE from the simulated call', async () => {
    server.use(
      http.post(`${A}/agents/:id/sim-call`, () =>
        HttpResponse.json(
          {
            code: 'INVALID_STATE',
            message: 'A simulated call needs a published, live agent.',
            correlationId: 'cor_s',
            retryable: false,
            details: {state: 'draft'},
          },
          {status: 409},
        ),
      ),
    );
    renderScreen('agt_pizza_01');
    await click(await screen.findByRole('radio', {name: 'Simulated call'}));
    await clickButton('What time do you close on Friday?');
    expect(await screen.findByText('A simulated call is not possible now')).toBeTruthy();
  });

  it('shows a paused fixture agent as paused, with the simulated call off', async () => {
    renderScreen('agt_pizza_paused_88');
    expect(await screen.findByText('This agent is paused')).toBeTruthy();
    expect(screen.getByText(/Simulated call is off: This agent is paused/)).toBeTruthy();
  });

  it('an agent of the other business shows not found and none of its data', async () => {
    window.localStorage.setItem(BUSINESS_STORAGE_KEY, 'biz_barber_01');
    renderScreen('agt_pizza_01');
    expect(await screen.findByText('This agent was not found')).toBeTruthy();
    expect(screen.queryByText(/Pizza Order Assistant/)).toBeNull();
    const reads = requests.filter((r) => new URL(r.url).pathname === '/api/agents/agt_pizza_01');
    // The provider applies the stored business after mount, so the last read is the barbershop's.
    expect(new URL(reads[reads.length - 1].url).searchParams.get('businessId')).toBe('biz_barber_01');
  });

  it('shows a retry when the agent does not load', async () => {
    let fail = true;
    server.use(
      http.get(`${A}/agents/:id`, async () => {
        if (!fail) return undefined;
        await delay(1);
        return HttpResponse.json(
          {
            code: 'INTERNAL',
            message: 'Boom.',
            correlationId: 'cor_i',
            retryable: true,
          },
          {status: 500},
        );
      }),
    );
    renderScreen('agt_pizza_01');
    expect(await screen.findByText('The agent did not load', {}, {timeout: 4000})).toBeTruthy();
    fail = false;
    await clickButton('Try again');
    expect(await screen.findByText('Preview: Pizza Order Assistant')).toBeTruthy();
  });
});
