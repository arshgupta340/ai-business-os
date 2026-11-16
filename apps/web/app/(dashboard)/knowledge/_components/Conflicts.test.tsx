// @vitest-environment jsdom
import type {ReactNode} from 'react';
import {afterEach, describe, expect, it} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {QueryClientProvider} from '@tanstack/react-query';
import {http, HttpResponse} from 'msw';
import {ApiError, createApiQueryClient} from '@/lib/api';
import * as db from '@/mocks/db';
import {server} from '@/mocks/server';
import {requests, useMockServer} from '@/mocks/test-setup';
import {ApiErrorBanner, errorText, isResolveOnFactsList} from './ApiErrorBanner';
import {KnowledgeScreen} from './KnowledgeScreen';

useMockServer();
afterEach(() => cleanup());

// The real server's answer for a conflict that lives only in the database
// (apps/server/src/app.ts lines 117 to 130 on origin/arsh/integration). AppError
// takes retryable from ERROR_CODE_INFO, so the body says retryable: true.
const RESOLVE_ON_FACTS_LIST = {
  code: 'INTEGRATION_UNAVAILABLE',
  message: 'This conflict is resolved from the facts list on this server.',
  correlationId: 'cor_cfl_1',
  retryable: true,
  details: {use: 'POST /api/businesses/:id/facts/propose with resolvesConflictId'},
};

const asApiError = () =>
  new ApiError({
    code: 'INTEGRATION_UNAVAILABLE',
    message: RESOLVE_ON_FACTS_LIST.message,
    status: 503,
    retryable: true,
    details: RESOLVE_ON_FACTS_LIST.details,
    kind: 'http',
    correlationId: 'cor_cfl_1',
  });

function wrap(children: ReactNode) {
  return <QueryClientProvider client={createApiQueryClient()}>{children}</QueryClientProvider>;
}

function renderPizza() {
  return render(
    wrap(<KnowledgeScreen businessId="biz_pizza_01" businessName="Demo Pizza Co." category="restaurant" timezone="America/Los_Angeles" />),
  );
}

describe('ApiErrorBanner for a conflict resolved from the facts list', () => {
  it('recognises the answer and never tells the owner to try again', () => {
    const error = asApiError();
    expect(isResolveOnFactsList(error)).toBe(true);
    expect(errorText(error)).not.toMatch(/try again|not responding/i);
    render(<ApiErrorBanner error={error} onRetry={() => {}} />);
    expect(screen.queryByRole('button', {name: 'Try again'})).toBeNull();
  });

  it('names an ordinary provider outage with the Integrations label', () => {
    const outage = new ApiError({code: 'INTEGRATION_UNAVAILABLE', message: 'x', status: 503, retryable: true, details: {provider: 'square'}, kind: 'http'});
    expect(isResolveOnFactsList(outage)).toBe(false);
    expect(errorText(outage)).toBe('Square is not responding.');
  });
});

describe('ConflictCard for a menu price conflict shaped like a real server one', () => {
  it('finds the catalog variation by item and variation name when the conflict has no variationId', async () => {
    // CONTRACTS 3: a real menu_item conflict has no value.variationId, and its key is the two names.
    const conflict = db.getState().conflicts.find((c) => c.id === 'cfl_pizza_01')!;
    conflict.candidates = conflict.candidates.map((c) => {
      const {variationId: _drop, ...value} = c.value as Record<string, unknown>;
      return {...c, value};
    });
    expect(conflict.key).toBe('margherita:large');
    expect(conflict.candidates.some((c) => 'variationId' in (c.value as object))).toBe(false);

    renderPizza();
    expect(await screen.findByRole('heading', {level: 3, name: 'Margherita, Large'})).toBeTruthy();
    // Only a matched catalog variation gives the card its current Square price.
    expect(await screen.findByText(/^Catalog price now: \$20\.00/)).toBeTruthy();
  });
});

describe('ConflictCard when resolve points at facts/propose', () => {
  it('proposes the kept value with resolvesConflictId and shows the confirmation waiting in Approvals', async () => {
    server.use(http.post('*/api/conflicts/:id/resolve', () => HttpResponse.json(RESOLVE_ON_FACTS_LIST, {status: 503})));
    renderPizza();
    expect(await screen.findByText('2 conflicts are open')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: 'Keep the current value'}));

    const notice = await screen.findByText(/A confirmation is waiting in Approvals/);
    const propose = requests.find((r) => r.url.includes('/facts/propose'));
    // The link sits next to the notice and points at the approval facts/propose created.
    const link = within(notice.parentElement as HTMLElement).getByRole('link', {name: 'Open the confirmation'});
    expect(link.getAttribute('href')).toMatch(/^\/approvals\?id=apv_/);

    expect(propose).toBeTruthy();
    const body = await propose!.clone().json();
    expect(body).toMatchObject({resolvesConflictId: 'cfl_pizza_02'});
    expect(Object.keys(body).sort()).toEqual(['reason', 'resolvesConflictId', 'value']);

    // Not resolved until the owner confirms: both conflicts are still open, no error banner, no retry.
    expect(screen.getByText('2 conflicts are open')).toBeTruthy();
    expect(screen.queryByText('The conflict was not resolved')).toBeNull();
    expect(screen.queryByRole('button', {name: 'Try again'})).toBeNull();
  });

  it('does not propose a price for a price conflict and says how to resolve it instead', async () => {
    server.use(http.post('*/api/conflicts/:id/resolve', () => HttpResponse.json(RESOLVE_ON_FACTS_LIST, {status: 503})));
    renderPizza();
    fireEvent.click(await screen.findByRole('button', {name: 'Keep the Square price'}));
    const banner = await screen.findByText('The conflict was not resolved');
    await waitFor(() => expect(requests.some((r) => r.url.includes('/api/conflicts/cfl_pizza_01/resolve'))).toBe(true));
    expect(requests.some((r) => r.url.includes('/facts/propose'))).toBe(false);
    const card = banner.closest('[role="alert"], section, div')!;
    expect(within(card as HTMLElement).queryByRole('button', {name: 'Try again'})).toBeNull();
    expect(screen.getByText(/price conflict cannot be resolved from this screen on this server/)).toBeTruthy();
    expect(screen.getByText('2 conflicts are open')).toBeTruthy();
  });
});
