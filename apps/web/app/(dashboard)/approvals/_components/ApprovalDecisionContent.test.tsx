// @vitest-environment jsdom
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {http, HttpResponse} from 'msw';
import type {ReactNode} from 'react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import * as api from '@/lib/api/client';
import {BusinessProvider} from '@/lib/session';
import {advanceMockClock, getState, mockControls, server, setApprovalExpiry} from '@/mocks/server';
import {requests, useMockServer} from '@/mocks/test-setup';
import {ApprovalDecisionContent} from './ApprovalDecisionContent';

useMockServer();

afterEach(() => {
  cleanup();
});

const PIZZA = 'biz_pizza_01';
const BARBER = 'biz_barber_01';

function renderDecision(approvalId: string, businessId = PIZZA, onDecided = vi.fn()) {
  const qc = new QueryClient({defaultOptions: {queries: {retry: false, staleTime: 0}, mutations: {retry: false}}});
  const wrapper = ({children}: {children: ReactNode}) => (
    <QueryClientProvider client={qc}>
      <BusinessProvider>{children}</BusinessProvider>
    </QueryClientProvider>
  );
  const view = render(<ApprovalDecisionContent businessId={businessId} approvalId={approvalId} onClose={() => {}} onDecided={onDecided} />, {
    wrapper,
  });
  return {...view, onDecided};
}

const decisionRequests = () => requests.filter((r) => r.method === 'POST' && r.url.includes('/decision'));

const button = (name: string) => screen.getByRole('button', {name});

describe('order bundle', () => {
  it('shows the itemized order, sandbox total, recipient, steps and the immutable IDs', async () => {
    renderDecision('apv_pizza_pending');
    await screen.findByText('Order request');
    const apv = getState().approvals.find((a) => a.id === 'apv_pizza_pending')!;
    await screen.findByText('Subtotal');
    expect(screen.getAllByText('Sandbox').length).toBeGreaterThan(0);
    expect(screen.getByText(apv.id)).toBeTruthy();
    expect(screen.getByText(apv.payloadHash)).toBeTruthy();
    expect(screen.getByText('Square (sandbox)')).toBeTruthy();
    expect(screen.getByText('Google Sheets')).toBeTruthy();
    expect(screen.getAllByText(/phone ending 0136/).length).toBeGreaterThan(0);
    expect(screen.getByText(/^Expires in \d+:\d\d$/)).toBeTruthy();
  });

  it('sends one request for two fast presses, with the stored hash, and shows Approved only from the server', async () => {
    const {onDecided} = renderDecision('apv_pizza_pending');
    const approve = await screen.findByRole('button', {name: 'Approve'});
    expect(screen.queryByText('The actions are now running.')).toBeNull();
    fireEvent.click(approve);
    fireEvent.click(approve);
    await screen.findByText('The actions are now running.');
    expect(decisionRequests()).toHaveLength(1);
    const body = (await decisionRequests()[0].json()) as {decision: string; payloadHash: string};
    const stored = getState().approvals.find((a) => a.id === 'apv_pizza_pending')!;
    expect(body).toEqual({decision: 'approve', payloadHash: stored.payloadHash});
    expect(decisionRequests()[0].headers.get('Idempotency-Key')).toBeTruthy();
    expect(onDecided).toHaveBeenCalledWith(expect.objectContaining({approvalId: 'apv_pizza_pending', state: 'APPROVED'}));
    expect(screen.getByRole('link', {name: 'Open Live operations'}).getAttribute('href')).toBe('/activity');
  });

  it('rejects with an optional reason', async () => {
    renderDecision('apv_pizza_pending');
    fireEvent.click(await screen.findByRole('button', {name: 'Reject'}));
    fireEvent.change(screen.getByLabelText(/Reason/), {target: {value: 'Kitchen closed early'}});
    fireEvent.click(button('Reject request'));
    await screen.findByText('Nothing was sent or charged.');
    const body = (await decisionRequests()[0].json()) as {decision: string; reason?: string};
    expect(body).toMatchObject({decision: 'reject', reason: 'Kitchen closed early'});
  });
});

describe('requests that cannot be acted on', () => {
  it('shows an expired request with no decision buttons', async () => {
    renderDecision('apv_pizza_expired');
    await screen.findByText('This request expired. Nothing was sent.');
    expect(screen.queryByRole('button', {name: 'Approve'})).toBeNull();
    expect(screen.queryByRole('button', {name: 'Reject'})).toBeNull();
  });

  it('shows a decided request with who and when and no decision buttons', async () => {
    renderDecision('apv_pizza_rejected');
    await screen.findByText('Nothing was sent or charged.');
    expect(screen.getByText(/^Decided .* by usr_owner_01\.$/)).toBeTruthy();
    expect(screen.queryByRole('button', {name: 'Approve'})).toBeNull();
  });

  it('locks the buttons when the countdown reaches zero while it is open', async () => {
    // createdAt, expiresAt and the hashed payload.expiresAt move together (contract cross-field rule).
    await setApprovalExpiry('apv_pizza_pending', Date.now() + 1500);
    renderDecision('apv_pizza_pending');
    await screen.findByRole('button', {name: 'Approve'});
    await screen.findByText('This request expired. Nothing was sent.', undefined, {timeout: 4000});
    expect(screen.queryByRole('button', {name: 'Approve'})).toBeNull();
    expect(decisionRequests()).toHaveLength(0);
  });
});

describe('decision errors', () => {
  it('payload hash mismatch: says the request changed, locks, and reloads the new payload', async () => {
    renderDecision('apv_pizza_pending');
    const approve = await screen.findByRole('button', {name: 'Approve'});
    const oldHash = getState().approvals.find((a) => a.id === 'apv_pizza_pending')!.payloadHash;
    await mockControls.simulatePayloadChanged('apv_pizza_pending');
    const newHash = getState().approvals.find((a) => a.id === 'apv_pizza_pending')!.payloadHash;
    fireEvent.click(approve);
    await screen.findByText('This request changed since you opened it');
    const sent = (await decisionRequests()[0].json()) as {payloadHash: string};
    expect(sent.payloadHash).toBe(oldHash);
    await screen.findByText(newHash);
    expect(button('Approve').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button('Reload the request'));
    await waitFor(() => expect(screen.queryByText('This request changed since you opened it')).toBeNull());
    await waitFor(() => expect(button('Approve').getAttribute('aria-disabled')).not.toBe('true'));
  });

  it('already decided: shows the recorded decision and no more actions', async () => {
    renderDecision('apv_barber_pending', BARBER);
    const approve = await screen.findByRole('button', {name: 'Approve'});
    const apv = await api.getApproval(BARBER, 'apv_barber_pending');
    await api.decideApproval(BARBER, apv.id, {decision: 'reject', payloadHash: apv.payloadHash});
    fireEvent.click(approve);
    await screen.findByText('Already decided');
    await screen.findByText(/Recorded decision: Rejected\./);
    await waitFor(() => expect(screen.queryByRole('button', {name: 'Approve'})).toBeNull());
  });

  it('expired on the server: says nothing was sent', async () => {
    renderDecision('apv_pizza_pending');
    const approve = await screen.findByRole('button', {name: 'Approve'});
    advanceMockClock(11 * 60_000);
    fireEvent.click(approve);
    await screen.findByText('Expired, nothing was sent');
  });

  it('network failure: offers a retry that reuses the same Idempotency-Key', async () => {
    renderDecision('apv_pizza_pending');
    const approve = await screen.findByRole('button', {name: 'Approve'});
    server.use(http.post('*/api/approvals/:id/decision', () => HttpResponse.error(), {once: true}));
    fireEvent.click(approve);
    await screen.findByText('Could not reach the server');
    fireEvent.click(button('Try again'));
    await screen.findByText('The actions are now running.');
    const keys = decisionRequests().map((r) => r.headers.get('Idempotency-Key'));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it('not found: says so and offers the way back', async () => {
    renderDecision('apv_does_not_exist');
    await screen.findByText('Not found in this business');
    expect(button('Back to the list')).toBeTruthy();
  });
});

describe('fact edit', () => {
  it('shows before and after and says the owner is confirming their own change', async () => {
    renderDecision('apv_pizza_fact_sun');
    await screen.findByText('Confirm your change');
    expect(screen.getByText(/You asked for this change/)).toBeTruthy();
    expect(screen.getByText('Before')).toBeTruthy();
    expect(screen.getByText('After')).toBeTruthy();
    expect(screen.getByText('12:00 to 22:00')).toBeTruthy();
    expect(screen.getByText('Sunday')).toBeTruthy();
    expect(button('Confirm change')).toBeTruthy();
  });
});
