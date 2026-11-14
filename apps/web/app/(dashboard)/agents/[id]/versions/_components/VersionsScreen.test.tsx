// @vitest-environment jsdom
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {http, HttpResponse} from 'msw';
import type {ReactNode} from 'react';
import {useState} from 'react';
import {QueryClientProvider} from '@tanstack/react-query';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createApiQueryClient} from '@/lib/api/provider';
import {BusinessProvider, useBusiness} from '@/lib/session';
import {pizzaSpecV1, pizzaSpecV2} from '@abos/contracts/fixtures';
import * as db from '@/mocks/db';
import {getState, server} from '@/mocks/server';
import {requests, useMockServer} from '@/mocks/test-setup';
import {VersionsScreen} from './VersionsScreen';

// The same next/navigation stand-in as the other screen tests. This screen
// does not read the URL itself, but shared components may.
const nav = vi.hoisted(() => ({
  router: {replace: vi.fn(), push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn()},
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/agents/agt_pizza_01/versions',
  useRouter: () => nav.router,
}));

// jsdom has no CSS.escape and no modal <dialog>. The Astryx Dialog uses both.
if (typeof globalThis.CSS === 'undefined' || typeof globalThis.CSS.escape !== 'function') {
  (globalThis as {CSS?: unknown}).CSS = {
    ...(globalThis.CSS ?? {}),
    escape: (value: string) => String(value).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`),
  };
}
if (typeof HTMLDialogElement !== 'undefined') {
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & {showModal?: () => void; close?: () => void};
  if (typeof proto.showModal !== 'function') {
    proto.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
  }
  if (typeof proto.close !== 'function') {
    proto.close = function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  }
}

useMockServer();

// The business selection is kept in localStorage. Start every test on the pizza business.
beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

const PIZZA = 'biz_pizza_01';
const V1 = 'agv_pizza_01_v1';
const V2 = 'agv_pizza_01_v2';

function Providers({children}: {children: ReactNode}) {
  const [client] = useState(createApiQueryClient);
  return (
    <QueryClientProvider client={client}>
      <BusinessProvider>{children}</BusinessProvider>
    </QueryClientProvider>
  );
}

function SwitchToBarber() {
  const {setBusinessId, businessId} = useBusiness();
  return (
    <button type="button" onClick={() => setBusinessId('biz_barber_01')}>
      {`test: barbershop (${businessId})`}
    </button>
  );
}

function renderScreen(agentId = 'agt_pizza_01') {
  return render(
    <Providers>
      <SwitchToBarber />
      <VersionsScreen agentId={agentId} />
    </Providers>,
  );
}

async function toBarber() {
  fireEvent.click(await screen.findByRole('button', {name: /test: barbershop/}));
  await screen.findByRole('button', {name: 'test: barbershop (biz_barber_01)'});
}

const rollbackRequests = () => requests.filter((r) => r.method === 'POST' && r.url.includes('/rollback'));

function resolveRequiredConflicts() {
  for (const c of getState().conflicts) if (c.required) c.state = 'resolved';
}

/** The row of one version in the history list. */
async function versionRow(label: string) {
  let row: HTMLElement | undefined;
  await waitFor(() => {
    row = screen
      .getAllByText(label)
      .map((el) => el.closest('li'))
      .find((li): li is HTMLLIElement => li !== null);
    expect(row).toBeTruthy();
  });
  return row!;
}

function errorOnce(code: string, status: number, details?: Record<string, unknown>, retryable = false) {
  server.use(
    http.post(
      '*/api/agents/:id/rollback',
      () => HttpResponse.json({code, message: 'server says no', correlationId: 'cor_test', retryable, ...(details ? {details} : {})}, {status}),
      {once: true},
    ),
  );
}

async function openRollback() {
  renderScreen();
  const row = await versionRow('Version 1');
  fireEvent.click(within(row).getByRole('button', {name: 'Roll back to this version'}));
  return await screen.findByRole('button', {name: 'Roll back to version 1'});
}

describe('history and compare', () => {
  it('lists versions newest first, marks the active one and offers rollback only on the other', async () => {
    renderScreen();
    const v2 = await versionRow('Version 2');
    const v1 = await versionRow('Version 1');
    expect(v2.compareDocumentPosition(v1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(v2).getByText('Active')).toBeTruthy();
    expect(within(v2).queryByRole('button', {name: 'Roll back to this version'})).toBeNull();
    expect(within(v1).getByRole('button', {name: 'Roll back to this version'})).toBeTruthy();
    expect(within(v1).getByText(/Published .* by usr_owner_01/)).toBeTruthy();
    expect(screen.getByRole('link', {name: 'Back to the agent'}).getAttribute('href')).toBe('/agents/agt_pizza_01');
  });

  it('compares the active version with the one before it and shows both values of a changed field', async () => {
    renderScreen();
    // Shared versions: v2 changed the goal, the knowledge scopes (faq added) and the greeting.
    await screen.findByText('3 parts changed from Version 1 to Version 2.');
    expect(screen.getByText(pizzaSpecV1.goal)).toBeTruthy();
    expect(screen.getByText(pizzaSpecV2.goal)).toBeTruthy();
    expect(screen.getByText(pizzaSpecV1.greeting!)).toBeTruthy();
    expect(screen.getByText(pizzaSpecV2.greeting!)).toBeTruthy();
    expect(screen.getAllByText('Same in both').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Changed')).toHaveLength(3);
  });
});

describe('rollback', () => {
  it('sends confirm: true with the chosen version once, and moves Active only after the server answers', async () => {
    resolveRequiredConflicts();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.post('*/api/agents/:id/rollback', async ({request, params}) => {
        const body = (await request.json()) as {toVersionId?: string; confirm?: unknown};
        await gate;
        return HttpResponse.json(db.rollbackAgent(PIZZA, params.id as string, body));
      }),
    );
    const confirm = await openRollback();
    expect(screen.getByText('The agent goes back to version 1. No new version is created.')).toBeTruthy();
    expect(screen.getByText(/the number follows: new calls use version 1/)).toBeTruthy();
    expect(screen.getByText(/Calls in progress keep the version they started with/)).toBeTruthy();
    expect(screen.getByText(/No version is edited or deleted/)).toBeTruthy();
    const versionsBefore = getState().versions.filter((v) => v.agentId === 'agt_pizza_01').length;
    expect(rollbackRequests()).toHaveLength(0);

    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(rollbackRequests()).toHaveLength(1));
    expect(await rollbackRequests()[0].json()).toEqual({toVersionId: V1, confirm: true});

    // Still waiting for the server: v2 is active and no success is shown.
    const v2 = await versionRow('Version 2');
    expect(within(v2).getByText('Active')).toBeTruthy();
    expect(screen.queryByText(/is the active version again/)).toBeNull();

    release();
    await screen.findByText('Version 1 is the active version again');
    await waitFor(async () => expect(within(await versionRow('Version 1')).queryByText('Active')).toBeTruthy());
    expect(within(await versionRow('Version 2')).queryByText('Active')).toBeNull();
    expect(within(await versionRow('Version 2')).getByRole('button', {name: 'Roll back to this version'})).toBeTruthy();
    expect(rollbackRequests()).toHaveLength(1);
    expect(getState().agents.find((a) => a.id === 'agt_pizza_01')!.activeVersionId).toBe(V1);
    await screen.findByText('Rolled back from v2');
    // Same versions as before: only the active marker moved.
    expect(getState().versions.filter((v) => v.agentId === 'agt_pizza_01')).toHaveLength(versionsBefore);
    expect(screen.queryByText('Version 3')).toBeNull();
    expect(screen.getAllByRole('button', {name: 'Roll back to this version'})).toHaveLength(1);
  });

  it('open required conflict: lists it and links to Knowledge review, nothing changes', async () => {
    const confirm = await openRollback();
    fireEvent.click(confirm);
    await screen.findByText('An open conflict blocks this rollback');
    expect(screen.getByText('Open conflicts: cfl_pizza_01')).toBeTruthy();
    expect(screen.getByRole('link', {name: 'Open Knowledge review'}).getAttribute('href')).toBe('/knowledge');
    expect(getState().agents.find((a) => a.id === 'agt_pizza_01')!.activeVersionId).toBe(V2);
    expect(screen.getByRole('button', {name: 'Roll back to version 1'}).getAttribute('aria-disabled')).toBe('true');
  });

  it.each([
    ['NOT_FOUND', 404, undefined, 'Not found in this business'],
    ['INVALID_STATE', 409, {state: 'live'}, 'This version cannot be rolled back to'],
    ['CAPABILITY_NOT_ALLOWED', 422, undefined, 'This version uses a capability that is no longer allowed'],
  ])('%s has its own message', async (code, status, details, title) => {
    errorOnce(code, status, details);
    fireEvent.click(await openRollback());
    await screen.findByText(title);
    expect(screen.getByText('Reference: cor_test')).toBeTruthy();
  });

  it('integration unavailable: names the provider and allows a retry', async () => {
    resolveRequiredConflicts();
    errorOnce('INTEGRATION_UNAVAILABLE', 503, {provider: 'Square'}, true);
    fireEvent.click(await openRollback());
    await screen.findByText('Square is not responding');
    fireEvent.click(screen.getByRole('button', {name: 'Try again'}));
    await screen.findByText('Version 1 is the active version again');
    expect(rollbackRequests()).toHaveLength(2);
  });
});

describe('states', () => {
  it('single version: says there is nothing to compare and offers no rollback', async () => {
    renderScreen('agt_barber_01');
    await toBarber();
    await screen.findByText('There is only one version, so there is nothing to compare yet.');
    expect(screen.queryByRole('button', {name: 'Roll back to this version'})).toBeNull();
  });

  it('draft that was never published', async () => {
    // The shared draft is the pizza FAQ line.
    renderScreen('agt_pizza_faq_01');
    await screen.findByText('This agent has not been published yet');
  });

  it('agent of the other business is not found', async () => {
    renderScreen('agt_barber_01');
    await screen.findByText('Not found in this business');
    expect(screen.getByRole('link', {name: 'Back to My Agents'}).getAttribute('href')).toBe('/agents');
  });
});
