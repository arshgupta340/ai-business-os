// @vitest-environment jsdom
import type {ReactNode} from 'react';
import {act, cleanup, configure, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {QueryClientProvider, type QueryClient} from '@tanstack/react-query';
import {http, HttpResponse} from 'msw';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createApiQueryClient, queryKeys} from '@/lib/api';
import {BusinessProvider} from '@/lib/session';
import {approvalPriceEditPending} from '@abos/contracts/fixtures';
import {getState, server} from '@/mocks/server';
import {requests, useMockServer} from '@/mocks/test-setup';
import {whenIdle} from '@/mocks/server';
import {PricesScreen} from './PricesScreen';

// A stand-in for next/navigation, as in the other screen tests. Nothing here navigates.
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/knowledge/prices',
  useRouter: () => ({replace: vi.fn(), push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn()}),
}));

// jsdom has no CSS.escape and no modal dialog methods. The Astryx Dialog uses both.
if (typeof globalThis.CSS === 'undefined') {
  (globalThis as unknown as {CSS: {escape: (s: string) => string}}).CSS = {escape: (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`)};
}
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

// The machine is shared, so give async queries and tests more room than the defaults.
configure({asyncUtilTimeout: 5000});
vi.setConfig({testTimeout: 30000});

useMockServer();
afterEach(() => cleanup());

const PIZZA = 'biz_pizza_01';

function renderScreen(businessId = PIZZA, name = 'Demo Pizza Co.') {
  const qc = createApiQueryClient();
  const view = render(
    <QueryClientProvider client={qc}>
      <BusinessProvider>
        <PricesScreen businessId={businessId} businessName={name} timezone="America/Los_Angeles" />
      </BusinessProvider>
    </QueryClientProvider>,
  );
  return {...view, qc};
}

/** The list row for one variation. Items are in fixture order: Margherita, then Pepperoni; sizes Small, Medium, Large. */
async function row(index: number): Promise<HTMLElement> {
  await screen.findAllByText('Current price in Square:');
  const rows = screen.getAllByRole('listitem').filter((li) => /price in Square:|Last synced price:/.test(li.textContent ?? ''));
  return rows[index];
}
/** A button by its exact text. Cheaper than a role query on this large DOM, which is slow in jsdom. */
async function button(text: string): Promise<HTMLElement> {
  return waitFor(() => {
    const el = screen.getAllByText(text).map((n) => n.closest('button')).find((b): b is HTMLButtonElement => !!b && !b.disabled);
    if (!el) throw new Error(`No enabled button "${text}"`);
    return el;
  });
}

const MARG_LG = 2;
/** Pepperoni Medium ($18.00). Pepperoni Large has the shared pending price edit (apv_demo_p01, 2200 to 1900). */
const PEP_MD = 4;
const PEP_LG = 5;

/** The price_edit approval this test created, not the seeded pending one. */
const createdPriceEdit = () =>
  getState().approvals.find((a) => a.bundleType === 'price_edit' && a.state === 'PENDING' && a.id !== approvalPriceEditPending.id)!;

const proposeRequests = () => requests.filter((r) => r.method === 'POST' && r.url.includes('/catalog/prices/propose'));

async function propose(rowIndex: number, value: string) {
  fireEvent.click(within(await row(rowIndex)).getByRole('button', {name: 'Change price'}));
  const field = await screen.findByLabelText(/New price in dollars/);
  fireEvent.change(field, {target: {value}});
  fireEvent.click(screen.getByRole('button', {name: 'Review the change'}));
}

/** What the live feed does on each event: refetch the affected queries. The test feed has no live source. */
async function refetch(qc: QueryClient, resource: 'activity' | 'catalog' | 'approvals') {
  await act(async () => {
    await qc.invalidateQueries({queryKey: queryKeys.resource(PIZZA, resource)});
  });
}

describe('PricesScreen', () => {
  it('lists every variation with its sandbox price and the sync time', async () => {
    renderScreen();
    const marg = await row(MARG_LG);
    expect(within(marg).getByText('$20.00')).toBeTruthy();
    expect(within(marg).getAllByText('Sandbox').length).toBeGreaterThan(0);
    expect(screen.getByText(/Last synced from Square/)).toBeTruthy();
    expect(screen.getAllByText('Current price in Square:')).toHaveLength(6);
  });

  it('shows the open uploaded price conflict on its row and does not resolve it', async () => {
    renderScreen();
    const marg = await row(MARG_LG);
    await within(marg).findByText('Your uploaded menu says');
    expect(within(marg).getByText('$21.00')).toBeTruthy();
    expect(within(marg).getByText(/To prefer the uploaded price, change the price here/)).toBeTruthy();
    expect(within(await row(PEP_MD)).queryByText('Your uploaded menu says')).toBeNull();
    expect(requests.some((r) => r.url.includes('/resolve'))).toBe(false);
  });

  it('validates the new price before sending anything', async () => {
    renderScreen();
    fireEvent.click(within(await row(MARG_LG)).getByRole('button', {name: 'Change price'}));
    const field = await screen.findByLabelText(/New price in dollars/);
    fireEvent.change(field, {target: {value: '20.00'}});
    fireEvent.click(screen.getByRole('button', {name: 'Review the change'}));
    expect(await screen.findByText('This is already the current price.')).toBeTruthy();
    fireEvent.change(field, {target: {value: '19.999'}});
    expect(await screen.findByText('Use at most two digits after the decimal point.')).toBeTruthy();
    fireEvent.change(field, {target: {value: '0'}});
    expect(await screen.findByText('The price must be more than $0.00.')).toBeTruthy();
    expect(proposeRequests()).toHaveLength(0);
  });

  it('proposes in minor units and opens the decision dialog for the returned approval', async () => {
    renderScreen();
    await propose(MARG_LG, '19.99');
    await screen.findByText('Price change request');
    expect(proposeRequests()).toHaveLength(1);
    expect(await proposeRequests()[0].json()).toEqual({variationId: 'SQ_VAR_MARG_LG', newPriceMinor: 1999, currency: 'USD'});
    const created = createdPriceEdit();
    expect(created.payload).toMatchObject({fromPriceMinor: 2000, newPriceMinor: 1999});
    // The dialog shows the approval the server returned, old and new price.
    expect(await screen.findByText(created.id)).toBeTruthy();
    expect(screen.getByText('Old price')).toBeTruthy();
    expect(screen.getByText('$19.99')).toBeTruthy();
    // Nothing changed in the catalog.
    expect(getState().catalog.find((c) => c.squareItemId === 'SQ_ITEM_MARG')!.variations[2].priceMinor).toBe(2000);
  });

  it('keeps the old price until the refetched catalog returns the new one', async () => {
    const {qc} = renderScreen();
    await propose(MARG_LG, '21.00');
    fireEvent.click(await button('Approve'));
    await screen.findByText('Change approved, updating Square');
    let marg = await row(MARG_LG);
    expect(within(marg).getByText('$20.00')).toBeTruthy();
    expect(within(marg).getByText('Current price in Square:')).toBeTruthy();

    // The mock runs both steps. The server catalog now has 2100.
    await act(async () => {
      await whenIdle();
    });
    expect(getState().catalog.find((c) => c.squareItemId === 'SQ_ITEM_MARG')!.variations[2].priceMinor).toBe(2100);

    // The step events arrive, the catalog has not been refetched yet: the old price stays.
    await refetch(qc, 'activity');
    marg = await row(MARG_LG);
    await within(marg).findByText(/Square accepted \$21\.00 \(sandbox\)\. Waiting for the catalog/);
    expect(within(marg).getByText('$20.00')).toBeTruthy();
    expect(within(marg).queryByText('Price updated in Square (sandbox)')).toBeNull();

    await refetch(qc, 'catalog');
    marg = await row(MARG_LG);
    await within(marg).findByText('Price updated in Square (sandbox)');
    expect(within(marg).getByText('Current price in Square:')).toBeTruthy();
    expect(within(marg).getAllByText('$21.00').length).toBeGreaterThan(0);
    // The conflict is not closed by this screen. The owner is sent to Business Knowledge.
    expect(within(marg).getByText(/conflict with your uploaded menu is still open/)).toBeTruthy();
    expect(within(marg).getByText('Open Business Knowledge').closest('a')?.getAttribute('href')).toBe('/knowledge');
  });

  it('leaves the price unchanged when the owner rejects', async () => {
    renderScreen();
    await propose(PEP_MD, '23.50');
    fireEvent.click(await button('Reject'));
    fireEvent.click(await button('Reject request'));
    const pep = await row(PEP_MD);
    await within(pep).findByText('Rejected, price unchanged');
    expect(within(pep).getByText('$18.00')).toBeTruthy();
    expect(within(pep).getByText(/The price is unchanged/)).toBeTruthy();
    expect(getState().catalog.find((c) => c.squareItemId === 'SQ_ITEM_PEP')!.variations[1].priceMinor).toBe(1800);
  });

  it('shows a pending confirmation with a button that reopens the dialog, and expiry leaves the price unchanged', async () => {
    const {qc} = renderScreen();
    await propose(PEP_MD, '23.50');
    await screen.findByText('Price change request');
    fireEvent.click(screen.getAllByRole('button', {name: /close/i})[0]);
    const pep = await row(PEP_MD);
    await within(pep).findByText('Waiting for your confirmation');
    fireEvent.click(within(pep).getByRole('button', {name: 'Review and confirm'}));
    await screen.findByText('Price change request');
    fireEvent.click(screen.getAllByRole('button', {name: /close/i})[0]);

    const apv = createdPriceEdit();
    apv.state = 'EXPIRED';
    apv.decidedAt = new Date().toISOString(); // contract: decidedAt is present on every state but PENDING
    await refetch(qc, 'approvals');
    await within(await row(PEP_MD)).findByText('Expired, price unchanged');
    expect(within(await row(PEP_MD)).getByText('$18.00')).toBeTruthy();
  });

  it('shows the seeded pending price edit on its row, with the price unchanged until it is approved', async () => {
    renderScreen();
    const pep = await row(PEP_LG);
    await within(pep).findByText('Waiting for your confirmation');
    expect(within(pep).getByText('$22.00')).toBeTruthy();
    expect(within(pep).getByRole('button', {name: 'Review and confirm'})).toBeTruthy();
  });

  it('shows each documented propose error with its own message', async () => {
    const cases: [string, number, Record<string, unknown>, RegExp][] = [
      ['NOT_FOUND', 404, {}, /This variation is not in the catalog/],
      ['INTEGRATION_UNAVAILABLE', 503, {provider: 'square'}, /Square is not responding/],
      ['ENVIRONMENT_MISMATCH', 409, {}, /Square is not in sandbox/],
    ];
    for (const [code, status, details, text] of cases) {
      server.use(
        http.post('*/api/businesses/:id/catalog/prices/propose', () =>
          HttpResponse.json({code, message: code, details, correlationId: 'cor_test', retryable: code !== 'ENVIRONMENT_MISMATCH'}, {status}),
        ),
      );
      renderScreen();
      await propose(MARG_LG, '21.00');
      expect(await screen.findByText(text)).toBeTruthy();
      expect(screen.queryByText('Price change request')).toBeNull();
      cleanup();
    }
  });

  it('shows an empty state for the barbershop, which has no Square catalog', async () => {
    renderScreen('biz_barber_01', 'Demo Barbershop');
    expect(await screen.findByText('No Square catalog for this business')).toBeTruthy();
    expect(screen.queryByRole('button', {name: 'Change price'})).toBeNull();
  });

  it('shows an error with retry when the catalog cannot be loaded', async () => {
    server.use(
      http.get('*/api/businesses/:id/catalog', () =>
        HttpResponse.json({code: 'INTERNAL', message: 'Server error', correlationId: 'cor_x', retryable: true}, {status: 500}),
      ),
    );
    renderScreen();
    expect(await screen.findByText('The catalog could not be loaded')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', {name: 'Try again'})).toBeTruthy());
  });
});
