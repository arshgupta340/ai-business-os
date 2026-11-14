// @vitest-environment jsdom
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {http, HttpResponse} from 'msw';
import {QueryClientProvider} from '@tanstack/react-query';
import {afterEach, describe, expect, it} from 'vitest';
import {createApiQueryClient} from '@/lib/api';
import {BusinessProvider} from '@/lib/session';
import {BUSINESS_STORAGE_KEY} from '@/lib/session/business-selection';
import {server} from '@/mocks/server';
import {requests, TEST_BASE_URL, useMockServer} from '@/mocks/test-setup';
import {TelemetryScreen} from './TelemetryScreen';

useMockServer();

const A = `${TEST_BASE_URL}/api`;

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function renderScreen() {
  const client = createApiQueryClient();
  render(
    <QueryClientProvider client={client}>
      <BusinessProvider>
        <TelemetryScreen />
      </BusinessProvider>
    </QueryClientProvider>,
  );
}

const telemetryUrls = () =>
  requests.filter((r) => new URL(r.url).pathname === '/api/telemetry').map((r) => new URL(r.url));

describe('TelemetryScreen', () => {
  it('shows every fixture metric with p50, p95 and its sample count', async () => {
    renderScreen();
    expect(await screen.findByRole('heading', {name: 'Time to first audio'})).toBeTruthy();
    expect(screen.getByRole('heading', {name: 'Time to answer a call'})).toBeTruthy();
    expect(screen.getByRole('heading', {name: 'Tool call time'})).toBeTruthy();
    expect(screen.getByRole('heading', {name: 'Owner approval time'})).toBeTruthy();
    expect(screen.getByRole('heading', {name: 'Payment webhook delay'})).toBeTruthy();
    expect(screen.getByText('Median (p50): 1.3 s')).toBeTruthy();
    expect(screen.getByText('p95: 2.3 s')).toBeTruthy();
    expect(screen.getByText('Median (p50): 48 s')).toBeTruthy();
    expect(screen.getByText('p95: 3 min 32 s')).toBeTruthy();
    expect(screen.getAllByText(/^Based on 14 samples. That is a small sample/)).toHaveLength(2);
    expect(screen.getByText(/^Based on 9 samples. That is a small sample/)).toBeTruthy();
    expect(screen.getByText('Based on 61 samples.')).toBeTruthy();
    // Goals only for first audio (p95) and tool latency (p50).
    expect(screen.getByText('p95 within goal')).toBeTruthy();
    expect(screen.getByText('p50 within goal')).toBeTruthy();
    expect(screen.getAllByText(/^PRD goal:/)).toHaveLength(2);
    expect(screen.getByRole('link', {name: 'Back to integrations'}).getAttribute('href')).toBe('/integrations');
  });

  it('sends businessId and a since for the chosen window, computed in the business time zone', async () => {
    window.localStorage.setItem(BUSINESS_STORAGE_KEY, 'biz_barber_01');
    renderScreen();
    await screen.findByRole('heading', {name: 'Tool call time'});
    const first = telemetryUrls().at(-1)!;
    expect(first.searchParams.get('businessId')).toBe('biz_barber_01');
    expect(first.searchParams.get('since')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);

    fireEvent.click(screen.getByRole('radio', {name: 'Last hour'}));
    await waitFor(() => expect(telemetryUrls().length).toBeGreaterThan(1));
    const since = Date.parse(telemetryUrls().at(-1)!.searchParams.get('since')!);
    expect(Math.abs(Date.now() - 60 * 60 * 1000 - since)).toBeLessThan(60_000);
  });

  it('says "No data yet" for a zero-count metric and shows an unknown name raw', async () => {
    server.use(
      http.get(`${A}/telemetry`, () =>
        HttpResponse.json({
          metrics: [
            {name: 'first_audio', p50Ms: 0, p95Ms: 0, count: 0},
            {name: 'tool_latency', p50Ms: 1600, p95Ms: 2000, count: 3},
          ],
        }),
      ),
    );
    renderScreen();
    expect(await screen.findByText('No data yet. Nothing was measured in this window.')).toBeTruthy();
    expect(screen.queryByText('p95 within goal')).toBeNull();
    expect(screen.queryByText('p95 over goal')).toBeNull();
    expect(screen.getByText('p50 over goal')).toBeTruthy();
    expect(screen.getByText(/^Based on 3 samples. That is a small sample/)).toBeTruthy();
  });

  it('shows the empty state when every metric has zero samples', async () => {
    server.use(
      http.get(`${A}/telemetry`, () =>
        HttpResponse.json({metrics: [{name: 'first_audio', p50Ms: 0, p95Ms: 0, count: 0}]}),
      ),
    );
    renderScreen();
    expect(await screen.findByText('No measurements yet')).toBeTruthy();
  });

  it('shows the error with a retry that loads the data', async () => {
    let failing = true;
    server.use(
      http.get(`${A}/telemetry`, () => {
        if (!failing) return undefined;
        return HttpResponse.json(
          {code: 'INTERNAL', message: 'Telemetry is not available.', correlationId: 'cor_tel', retryable: true},
          {status: 500},
        );
      }),
    );
    renderScreen();
    expect(await screen.findByText('Could not load telemetry', {}, {timeout: 8000})).toBeTruthy();
    expect(screen.getByText('Telemetry is not available.')).toBeTruthy();
    failing = false;
    fireEvent.click(screen.getByRole('button', {name: 'Try again'}));
    expect(await screen.findByRole('heading', {name: 'Time to first audio'})).toBeTruthy();
  });
});
