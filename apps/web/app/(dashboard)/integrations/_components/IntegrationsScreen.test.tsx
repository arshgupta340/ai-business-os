// @vitest-environment jsdom
import {cleanup, configure, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {QueryClientProvider} from '@tanstack/react-query';
import {http, HttpResponse} from 'msw';
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {createApiQueryClient} from '@/lib/api';
import {BusinessProvider} from '@/lib/session';
import {BUSINESS_STORAGE_KEY} from '@/lib/session/business-selection';
import {getState, mockControls, server, whenIdle} from '@/mocks/server';
import {useMockServer} from '@/mocks/test-setup';
import {IntegrationsScreen} from './IntegrationsScreen';

// Render the tone next to the label so each test can read it. The real
// StatusBadge maps the tone to a Badge variant.
vi.mock('@/components/StatusBadge', () => ({
  StatusBadge: ({label, tone}: {label: string; tone?: string}) => <mark data-tone={tone ?? 'neutral'}>{label}</mark>,
}));

useMockServer();

// The full suite runs many screens at once; give async queries room.
configure({asyncUtilTimeout: 5_000});

beforeAll(() => {
  // useActivityFeed listens to the mock event bus only in mock mode.
  process.env.NEXT_PUBLIC_MOCK = '1';
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function renderScreen() {
  const client = createApiQueryClient();
  render(
    <QueryClientProvider client={client}>
      <BusinessProvider>
        <IntegrationsScreen />
      </BusinessProvider>
    </QueryClientProvider>,
  );
}

/** The card for one provider, found from its heading. */
async function card(name: string) {
  const heading = await screen.findByRole('heading', {name, level: 3});
  // Heading -> header HStack -> card VStack.
  return heading.parentElement!.parentElement as HTMLElement;
}

function badge(container: HTMLElement, label: string) {
  return within(container).getByText(label, {selector: 'mark'});
}

describe('IntegrationsScreen', {timeout: 20_000}, () => {
  it('shows each state with its tone and what the owner will notice', async () => {
    renderScreen();

    const sheets = await card('Google Sheets');
    expect(badge(sheets, 'Disconnected').dataset.tone).toBe('danger');
    expect(within(sheets).getByText(/The report sheet is not updated/)).toBeTruthy();
    expect(within(sheets).getByText(/will catch up/)).toBeTruthy();
    expect(within(sheets).getByText(/Server note: The sheet is not shared/)).toBeTruthy();

    const calendar = await card('Google Calendar');
    expect(badge(calendar, 'Degraded').dataset.tone).toBe('warning');
    expect(within(calendar).getByText(/bookings may take longer to confirm/)).toBeTruthy();

    const twilio = await card('Twilio');
    expect(badge(twilio, 'Connected').dataset.tone).toBe('success');
    expect(within(twilio).queryByText('What you will notice')).toBeNull();

    // No connect or reconnect control anywhere.
    expect(screen.queryByRole('button', {name: /connect/i})).toBeNull();
    expect(screen.getByText(/Mock mode: everything on this page is mock data/)).toBeTruthy();
  });

  it('shows the calendar consequence for a disconnected calendar', async () => {
    getState().health.google_calendar = {state: 'disconnected', lastCheckedAt: new Date().toISOString()};
    renderScreen();
    const calendar = await card('Google Calendar');
    expect(badge(calendar, 'Disconnected').dataset.tone).toBe('danger');
    expect(within(calendar).getByText(/Bookings cannot be created/)).toBeTruthy();
  });

  it('labels Square sandbox even when the environment field is missing', async () => {
    getState().health.square = {state: 'connected', lastCheckedAt: new Date().toISOString()};
    renderScreen();
    const square = await card('Square');
    expect(within(square).getByText('Sandbox')).toBeTruthy();
    expect(within(square).getByText('Sandbox only. No real money moves.')).toBeTruthy();
  });

  it('says plainly that qr_only sends no message', async () => {
    getState().health.message_channel = {state: 'connected', channel: 'qr_only', lastCheckedAt: new Date().toISOString()};
    renderScreen();
    const channel = await card('Message channel');
    expect(
      within(channel).getByText(
        'Active channel: QR code only. Links are shown as a QR code on the Live operations screen and no message is sent.',
      ),
    ).toBeTruthy();
  });

  it('shows the result of Check now only after the server answers', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.get('*/api/integrations/health', async ({request}) => {
        if (new URL(request.url).searchParams.get('refresh') !== '1') return HttpResponse.json(getState().health);
        await gate;
        return HttpResponse.json({
          ...getState().health,
          google_sheets: {state: 'connected', lastCheckedAt: new Date().toISOString()},
        });
      }),
    );
    renderScreen();
    const sheets = await card('Google Sheets');
    expect(badge(sheets, 'Disconnected')).toBeTruthy();

    const button = screen.getByRole('button', {name: 'Check now'});
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('button', {name: 'Checking'}).getAttribute('aria-disabled')).toBe('true'));
    // Still the stored result while the check runs.
    expect(badge(await card('Google Sheets'), 'Disconnected')).toBeTruthy();

    release();
    await waitFor(() => expect(within(sheets).queryByText('Disconnected', {selector: 'mark'})).toBeNull());
    expect(badge(await card('Google Sheets'), 'Connected').dataset.tone).toBe('success');
    expect(screen.getByRole('button', {name: 'Check now'})).toBeTruthy();
  });

  it('shows an error with a retry when Check now fails, and keeps the stored result', async () => {
    let fail = true;
    server.use(
      http.get('*/api/integrations/health', ({request}) => {
        if (new URL(request.url).searchParams.get('refresh') === '1' && fail) {
          return HttpResponse.json(
            {code: 'INTEGRATION_UNAVAILABLE', message: 'Provider check timed out', correlationId: 'cor_test_1', retryable: true, details: {provider: 'google_sheets'}},
            {status: 503},
          );
        }
        return HttpResponse.json(getState().health);
      }),
    );
    renderScreen();
    await card('Google Sheets');
    fireEvent.click(screen.getByRole('button', {name: 'Check now'}));
    expect(await screen.findByText('The check did not finish')).toBeTruthy();
    expect(screen.getByText('Google Sheets is not responding.')).toBeTruthy();
    expect(screen.getByText('Details')).toBeTruthy();
    expect(badge(await card('Google Sheets'), 'Disconnected')).toBeTruthy();

    fail = false;
    fireEvent.click(screen.getByRole('button', {name: 'Try again'}));
    await waitFor(() => expect(screen.queryByText('The check did not finish')).toBeNull());
  });

  it('shows a load error with a retry', async () => {
    let fail = true;
    server.use(
      http.get('*/api/integrations/health', () =>
        fail
          ? HttpResponse.json({code: 'INTERNAL', message: 'Server error', correlationId: 'cor_test_2', retryable: true}, {status: 500})
          : HttpResponse.json(getState().health),
      ),
    );
    renderScreen();
    // The query client retries a retryable error twice before it shows.
    expect(await screen.findByText('Could not load integration health', undefined, {timeout: 10_000})).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', {name: 'Try again'}));
    expect(await screen.findByRole('heading', {name: 'Square', level: 3})).toBeTruthy();
  });

  it('shows the phone number and the agent that answers it', async () => {
    renderScreen();
    const link = await screen.findByRole('link', {name: 'Pizza Order Assistant'});
    expect(link.getAttribute('href')).toBe('/agents/agt_pizza_01');
    expect(screen.getByText(getState().liveAgent.phoneNumber)).toBeTruthy();
    expect(screen.getByRole('link', {name: 'Choose the live agent'}).getAttribute('href')).toBe('/agents');
    expect(screen.getByRole('link', {name: 'Latency and cost'}).getAttribute('href')).toBe('/telemetry');
  });

  it('shows the empty case when no agent answers the number', async () => {
    mockControls.simulateNoLiveAgent();
    renderScreen();
    expect(await screen.findByText('No agent answers this number now')).toBeTruthy();
    expect(screen.getByRole('link', {name: 'Choose the live agent'}).getAttribute('href')).toBe('/agents');
  });

  it('says the number goes to the other business when the barbershop is selected', async () => {
    window.localStorage.setItem(BUSINESS_STORAGE_KEY, 'biz_barber_01');
    renderScreen();
    expect(await screen.findByText(/Calls to this number go to Demo Pizza Co, not to the business selected above\./)).toBeTruthy();
  });

  it('lists integration events and adds a new one without a reload', async () => {
    renderScreen();
    expect(await screen.findByText(/Rejected a Square webhook/)).toBeTruthy();
    const before = screen.getAllByText(/Rejected a Square webhook/).length;
    const square = await card('Square');
    expect(badge(square, 'Connected')).toBeTruthy();

    // A health change plus an event: the feed refetches health and the list.
    getState().health.square = {state: 'degraded', environment: 'sandbox', lastCheckedAt: new Date().toISOString()};
    mockControls.simulateRejectedWebhook();
    await whenIdle();

    await waitFor(() => expect(screen.getAllByText(/Rejected a Square webhook/).length).toBe(before + 1));
    await waitFor(() => expect(badge(square, 'Degraded').dataset.tone).toBe('warning'));
    expect(screen.getAllByRole('link', {name: /Rejected a Square webhook/})[0].getAttribute('href')).toBe('/activity');
  });

  it('shows the empty events state for a business with none', async () => {
    window.localStorage.setItem(BUSINESS_STORAGE_KEY, 'biz_barber_01');
    const state = getState();
    state.activity = state.activity.filter(
      (e) => e.businessId !== 'biz_barber_01' || !['webhook.rejected', 'sync.failed', 'message.failed', 'execution.failed'].includes(e.type),
    );
    renderScreen();
    expect(await screen.findByText('No integration problems recorded')).toBeTruthy();
  });
});
