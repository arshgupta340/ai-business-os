// @vitest-environment jsdom
import {cleanup, configure, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {QueryClientProvider} from '@tanstack/react-query';
import {http, HttpResponse} from 'msw';
import {useState, type ReactNode} from 'react';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {createApiQueryClient} from '@/lib/api/provider';
import {BusinessProvider} from '@/lib/session';
import {approvalFactEditPending} from '@abos/contracts/fixtures';
import * as db from '@/mocks/db';
import {server} from '@/mocks/server';
import {requests, useMockServer} from '@/mocks/test-setup';
import {SettingsScreen} from './SettingsScreen';

// A stand-in for next/navigation, as in the other screen tests.
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/settings',
  useRouter: () => ({replace: vi.fn(), push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn()}),
}));

// jsdom has no CSS.escape and no modal <dialog>. The Astryx Dialog needs both.
const g = globalThis as unknown as {CSS?: {escape?: (s: string) => string}};
g.CSS ??= {};
g.CSS.escape ??= (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
if (typeof HTMLDialogElement !== 'undefined') {
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.show ??= function show(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
}

// Mock mode, so useActivityFeed receives the mock db's events (fact.changed, approval.expired).
beforeAll(() => vi.stubEnv('NEXT_PUBLIC_MOCK', '1'));
afterAll(() => vi.unstubAllEnvs());

// The machine is shared, so give each async lookup more time than the 1 second default (10 seconds).
configure({asyncUtilTimeout: 10_000});
vi.setConfig({testTimeout: 30_000});

useMockServer();
afterEach(() => cleanup());

const PIZZA = 'biz_pizza_01';
const BARBER = 'biz_barber_01';
const TZ = 'America/Los_Angeles';

function Providers({children}: {children: ReactNode}) {
  const [client] = useState(createApiQueryClient);
  return (
    <QueryClientProvider client={client}>
      <BusinessProvider>{children}</BusinessProvider>
    </QueryClientProvider>
  );
}

function renderSettings(businessId = PIZZA) {
  return render(<SettingsScreen businessId={businessId} timezone={TZ} />, {wrapper: Providers});
}

const button = (name: string | RegExp) => screen.getByRole('button', {name});
const proposeRequests = () => requests.filter((r) => r.method === 'POST' && r.url.includes('/facts/propose'));

function setTime(label: string, value: string) {
  const input = screen.getByLabelText(label) as HTMLInputElement;
  fireEvent.change(input, {target: {value}});
  fireEvent.blur(input);
}

/**
 * The shared world already has a pending Friday edit (apv_demo_f01, close at 23:00). The editor tests
 * start from a Friday with no pending change, so they reject that one first, as the owner could.
 */
async function rejectSeededFridayEdit() {
  const apv = db.getState().approvals.find((a) => a.id === approvalFactEditPending.id)!;
  await db.decideApproval(PIZZA, apv.id, {decision: 'reject', payloadHash: apv.payloadHash}, null);
}

async function openFridayEditor() {
  await rejectSeededFridayEdit();
  renderSettings();
  fireEvent.click(await screen.findByRole('button', {name: 'Edit Friday'}));
  await screen.findByLabelText('Friday closes');
}

describe('opening hours', () => {
  it('lists Monday to Sunday in order and shows closed days', async () => {
    renderSettings(BARBER);
    await screen.findByRole('button', {name: 'Edit Monday'});
    const names = screen.getAllByRole('button', {name: /^Edit (Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day$/}).map((b) => b.textContent);
    expect(names).toEqual(['Edit Monday', 'Edit Tuesday', 'Edit Wednesday', 'Edit Thursday', 'Edit Friday', 'Edit Saturday', 'Edit Sunday']);
    // Barbershop: closed on Monday and Sunday.
    expect(screen.getAllByText('Closed')).toHaveLength(2);
    expect(screen.getByText('Your agents use these hours on the next call.')).toBeTruthy();
  });

  it('shows a change the server still has pending, with a way back to the confirmation', async () => {
    renderSettings();
    // The shared pending edit: Friday closes at 11 pm instead of 10 pm.
    expect(await screen.findByText('Change waiting for your confirmation: 11:00 AM to 11:00 PM')).toBeTruthy();
    // Friday still shows its verified hours (Saturday has the same hours).
    expect(screen.getAllByText('11:00 AM to 10:00 PM')).toHaveLength(2);
    fireEvent.click(button('Review and confirm'));
    expect(await screen.findByText('Confirm your change')).toBeTruthy();
  });

  it('refuses a closing time before the opening time without sending anything', async () => {
    await openFridayEditor();
    setTime('Friday closes', '10:00');
    fireEvent.click(button('Review change'));
    expect(await screen.findByText(/The closing time must be later than the opening time/)).toBeTruthy();
    expect(proposeRequests()).toHaveLength(0);
  });

  it('proposes a fact_edit, opens the confirm dialog, and changes the row only after approval and the refetch', async () => {
    await openFridayEditor();
    setTime('Friday closes', '23:00');
    fireEvent.click(button('Review change'));

    // The dialog opens for the new approval, worded as the owner's own change.
    expect(await screen.findByText('Confirm your change')).toBeTruthy();
    const body = await proposeRequests()[0].clone().json();
    expect(body).toEqual({kind: 'hours', key: 'fri', value: {open: '11:00', close: '23:00'}});
    const created = db.getState().approvals.find((a) => a.bundleType === 'fact_edit' && a.state === 'PENDING' && (a.payload as {key: string}).key === 'fri');
    expect(created?.actorType).toBe('owner');
    expect(created?.id).not.toBe(approvalFactEditPending.id);

    // Nothing changed yet: Friday and Saturday both still close at 10 pm.
    expect(screen.getAllByText('11:00 AM to 10:00 PM')).toHaveLength(2);
    expect(screen.queryByText('11:00 AM to 11:00 PM')).toBeNull();
    expect(screen.getByText('Change waiting for your confirmation: 11:00 AM to 11:00 PM')).toBeTruthy();

    fireEvent.click(button('Confirm change'));
    expect(await screen.findByText('11:00 AM to 11:00 PM')).toBeTruthy();
    expect(screen.getAllByText('11:00 AM to 10:00 PM')).toHaveLength(1);
    expect(screen.getByText('Your change to 11:00 AM to 11:00 PM is saved.')).toBeTruthy();
    // The verified fact is the new version, written by the owner from the dashboard.
    expect(screen.getByText('You, in the dashboard, version 2')).toBeTruthy();
    // The change log picks it up without a reload.
    expect(await screen.findByText('From 11:00 AM to 10:00 PM, to 11:00 AM to 11:00 PM')).toBeTruthy();
  });

  it('leaves the hours unchanged when the owner discards the change', async () => {
    await openFridayEditor();
    setTime('Friday closes', '23:00');
    fireEvent.click(button('Review change'));
    await screen.findByText('Confirm your change');
    fireEvent.click(button('Discard change'));
    fireEvent.click(await screen.findByRole('button', {name: 'Discard change'}));

    expect(await screen.findByText(/You discarded the change to 11:00 AM to 11:00 PM\. Friday hours did not change\./)).toBeTruthy();
    expect(screen.getAllByText('11:00 AM to 10:00 PM')).toHaveLength(2);
    expect(screen.queryByText('11:00 AM to 11:00 PM')).toBeNull();
    const fri = db.getState().facts.find((f) => f.kind === 'hours' && f.key === 'fri' && f.status === 'verified');
    expect(fri?.value).toEqual({open: '11:00', close: '22:00'});
  });

  it('leaves the hours unchanged when the confirmation expires', async () => {
    await openFridayEditor();
    setTime('Friday closes', '23:00');
    fireEvent.click(button('Review change'));
    await screen.findByText('Confirm your change');
    fireEvent.click(button('Close'));

    // The server's expiry job runs after the 10 minute window.
    db.sweepExpired(Date.now() + 11 * 60 * 1000);
    expect(await screen.findByText(/The confirmation for 11:00 AM to 11:00 PM expired before you confirmed it\. Friday hours did not change\./)).toBeTruthy();
    expect(screen.getAllByText('11:00 AM to 10:00 PM')).toHaveLength(2);
    expect(screen.queryByText('11:00 AM to 11:00 PM')).toBeNull();
  });

  it('shows the propose error and offers a retry when the error allows it', async () => {
    server.use(
      http.post('*/api/businesses/:id/facts/propose', () =>
        HttpResponse.json({error: {code: 'INTERNAL', message: 'Something broke.', retryable: true}}, {status: 500}),
      ),
    );
    await openFridayEditor();
    setTime('Friday closes', '23:00');
    fireEvent.click(button('Review change'));
    expect(await screen.findByText('The change was not sent')).toBeTruthy();
    expect(screen.queryByText('Confirm your change')).toBeNull();
    expect(button('Try again')).toBeTruthy();
  });
});

describe('policies', () => {
  it('edits the pickup window through the same propose and confirm flow', async () => {
    renderSettings();
    fireEvent.click(await screen.findByRole('button', {name: 'Edit Pickup window'}));
    const input = screen.getByLabelText(/Pickup window in minutes/) as HTMLInputElement;
    fireEvent.change(input, {target: {value: '30'}});
    fireEvent.click(button('Review change'));
    expect(await screen.findByText('Confirm your change')).toBeTruthy();
    const body = await proposeRequests()[0].clone().json();
    expect(body).toEqual({kind: 'policy', key: 'pickup_window', value: {minutes: 30}});
    expect(screen.getByText('20 minutes')).toBeTruthy();
  });
});

describe('business profile', () => {
  it('shows saved only after the server answers', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.patch('*/api/businesses/:id', async ({params, request}) => {
        await gate;
        return HttpResponse.json(db.updateBusiness(String(params.id), (await request.json()) as Record<string, unknown>));
      }),
    );
    renderSettings();
    const name = (await screen.findByLabelText(/Business name/)) as HTMLInputElement;
    expect(name.value).toBe('Demo Pizza Co.');
    expect(screen.getByText('America/Los_Angeles')).toBeTruthy();
    fireEvent.change(name, {target: {value: 'Demo Pizza Company'}});
    fireEvent.click(button('Save'));

    await waitFor(() => expect(requests.some((r) => r.method === 'PATCH')).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText('Saving')).toBeTruthy();
    expect(screen.queryByText(/^Saved\./)).toBeNull();

    release();
    expect(await screen.findByText(/^Saved\. The server confirmed it at/)).toBeTruthy();
    const body = await requests.find((r) => r.method === 'PATCH')!.clone().json();
    expect(body.name).toBe('Demo Pizza Company');
    expect(Object.keys(body).sort()).toEqual(['contact', 'name']);
  });

  it('does not save an empty name', async () => {
    renderSettings();
    const name = (await screen.findByLabelText(/Business name/)) as HTMLInputElement;
    fireEvent.change(name, {target: {value: '  '}});
    fireEvent.click(button('Save'));
    expect(await screen.findByText('Enter the business name.')).toBeTruthy();
    expect(requests.some((r) => r.method === 'PATCH')).toBe(false);
  });
});
