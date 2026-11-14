import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatSmokeOutput, runSmoke, type SmokeOptions } from '../../../../scripts/smoke-lib';

const markers = ['KEY_MARKER', 'EMAIL_MARKER', 'PASSWORD_MARKER', 'TOKEN_MARKER'];
const options = {
  baseUrl: 'http://server.test', supabaseUrl: 'https://auth.test',
  anonKey: markers[0]!, email: markers[1]!, password: markers[2]!, now: () => 0,
};
const entry = { state: 'connected', lastCheckedAt: '2026-11-14T00:00:00Z' };
const health = {
  square: { ...entry, environment: 'sandbox' }, twilio: entry, openai: entry,
  google_calendar: entry, google_sheets: entry, message_channel: entry,
};
const error = { code: 'UNAUTHENTICATED', message: markers.join(' '), correlationId: 'test', retryable: false };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
type Override = (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;
function fakeFetch(override?: Override) {
  return vi.fn<SmokeOptions['fetch']>(async (input, init = {}) => {
    const url = new URL(String(input));
    const replacement = override?.(url, init);
    if (replacement) return replacement;
    if (url.origin === options.supabaseUrl) return json({ access_token: markers[3] });
    if (url.pathname === '/health') return json({ squareEnvironment: 'sandbox' });
    const authorization = new Headers(init.headers).get('authorization');
    if (authorization !== `Bearer ${markers[3]}`) return json(error, 401);
    switch (url.pathname) {
      case '/api/businesses': return json({ items: [{ id: 'biz_test', name: 'Test', category: 'restaurant', timezone: 'America/Los_Angeles' }] });
      case '/api/businesses/biz_test/facts': return json({ items: [], conflicts: [] });
      case '/api/approvals':
        expect(url.searchParams.get('businessId')).toBe('biz_test');
        return json({ items: [] });
      case '/api/integrations/health':
        expect(url.search).toBe('?businessId=biz_test');
        return json(health);
      case '/api/live-agent':
        expect(url.search).toBe('');
        return json({ phoneNumber: '+15555550100', businessId: 'biz_test' });
      default: throw new Error('Unexpected request');
    }
  });
}

afterEach(() => vi.useRealTimers());
describe('read-only smoke checks', () => {
  it('passes all checks in order and reports stored integration states', async () => {
    const fetch = fakeFetch();
    const results = await runSmoke({ ...options, fetch });
    expect(results).toHaveLength(9);
    expect(results.every((check) => check.ok === true)).toBe(true);
    expect(formatSmokeOutput(results).at(-1)).toContain('square=connected');
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/health', '/auth/v1/token', '/api/businesses', '/api/businesses/biz_test/facts',
      '/api/approvals', '/api/integrations/health', '/api/live-agent', '/api/businesses', '/api/businesses',
    ]);
  });
  it('reports health down and skips dependent checks', async () => {
    const fetch = fakeFetch((url) => url.pathname === '/health' ? json({}, 503) : undefined);
    const results = await runSmoke({ ...options, fetch });
    expect(results[0]).toMatchObject({ ok: false, status: 503 });
    expect(results.slice(1).every((check) => check.ok === null)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('skips authenticated reads when sign-in is refused but still checks auth guards', async () => {
    const fetch = fakeFetch((url) => url.origin === options.supabaseUrl ? json(error, 400) : undefined);
    const results = await runSmoke({ ...options, fetch });
    expect(results[1]).toMatchObject({ ok: false, status: 400 });
    expect(results.slice(2, 7).every((check) => check.ok === null)).toBe(true);
    expect(results.slice(7).every((check) => check.ok === true)).toBe(true);
  });
  it('fails a response that does not match its contract and continues independent reads', async () => {
    const results = await runSmoke({ ...options, fetch: fakeFetch((url) => url.pathname.endsWith('/facts') ? json({ items: 'wrong' }) : undefined) });
    expect(results[3]).toMatchObject({ ok: false, status: 200, detail: 'Response schema failed.' });
    expect(results[4]?.ok).toBe(true);
  });
  it('fails when the unauthenticated request incorrectly returns 200', async () => {
    const results = await runSmoke({ ...options, fetch: fakeFetch((url, init) =>
      url.pathname === '/api/businesses' && !new Headers(init.headers).has('authorization') ? json({ items: [] }) : undefined) });
    expect(results[7]).toMatchObject({ ok: false, status: 200 });
  });
  it('rejects a non-sandbox health response', async () => {
    const results = await runSmoke({ ...options, fetch: fakeFetch((url) =>
      url.pathname === '/health' ? json({ squareEnvironment: 'production' }) : undefined) });
    expect(results[0]?.ok).toBe(false);
    expect(results.slice(1).every((check) => check.ok === null)).toBe(true);
  });
  it('requires at least one business and skips business reads when none exists', async () => {
    const results = await runSmoke({ ...options, fetch: fakeFetch((url, init) =>
      url.pathname === '/api/businesses' && new Headers(init.headers).get('authorization') === `Bearer ${markers[3]}`
        ? json({ items: [] }) : undefined) });
    expect(results[2]?.ok).toBe(false);
    expect(results.slice(3, 7).every((check) => check.ok === null)).toBe(true);
    expect(results.slice(7).every((check) => check.ok === true)).toBe(true);
  });
  it('requires the contract error code on a missing-token response', async () => {
    const results = await runSmoke({ ...options, fetch: fakeFetch((url, init) =>
      url.pathname === '/api/businesses' && !new Headers(init.headers).has('authorization')
        ? json({ ...error, code: 'NOT_FOUND' }, 401) : undefined) });
    expect(results[7]?.ok).toBe(false);
  });
  it('rejects malformed-token access that incorrectly returns 200', async () => {
    const results = await runSmoke({ ...options, fetch: fakeFetch((_url, init) =>
      new Headers(init.headers).get('authorization') === 'Bearer malformed-token' ? json({ items: [] }) : undefined) });
    expect(results[8]?.ok).toBe(false);
  });
  it('refuses a Supabase origin that would POST credentials to the server', async () => {
    const fetch = fakeFetch();
    const results = await runSmoke({ ...options, supabaseUrl: options.baseUrl, fetch });
    expect(results[1]).toMatchObject({ ok: false, detail: 'Invalid Supabase origin.' });
    expect(fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
  it('times out even if fetch ignores the abort signal', async () => {
    vi.useFakeTimers();
    const fetch = fakeFetch(() => new Promise<Response>(() => undefined));
    const pending = runSmoke({ ...options, fetch });
    await vi.advanceTimersByTimeAsync(10_001);
    const results = await pending;
    expect(results[0]).toMatchObject({ ok: false, detail: 'Request timed out.' });
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
  it('times out while reading a body and ignores its late schema failure', async () => {
    vi.useFakeTimers();
    let finish: ((value: unknown) => void) | undefined;
    const response = json({});
    vi.spyOn(response, 'json').mockImplementation(() => new Promise<unknown>((resolve) => { finish = resolve; }));
    const pending = runSmoke({ ...options, fetch: fakeFetch(() => response) });
    await vi.advanceTimersByTimeAsync(10_001);
    const results = await pending;
    expect(results[0]).toMatchObject({ ok: false, status: 200, detail: 'Request timed out.' });
    finish?.({});
    await vi.advanceTimersByTimeAsync(1);
    expect(results).toHaveLength(9);
  });
  it('never prints secret markers from successful responses, error bodies, or exceptions', async () => {
    for (const fetch of [fakeFetch(), fakeFetch((url) => {
      if (url.pathname.endsWith('/facts')) throw new Error(markers.join(' '));
      if (url.pathname.endsWith('/health')) return json({ ...health, square: { ...health.square, detail: markers.join(' ') } });
      return undefined;
    })]) {
      const lines = formatSmokeOutput(await runSmoke({ ...options, fetch }));
      for (const line of lines) for (const marker of markers) expect(line).not.toContain(marker);
    }
  });
  it('uses only GET on the server and only the password token POST on Supabase', async () => {
    const fetch = fakeFetch();
    await runSmoke({ ...options, fetch });
    for (const [input, init] of fetch.mock.calls) {
      const url = new URL(String(input));
      expect(init?.redirect).toBe('error');
      if (url.origin === options.baseUrl) expect(init?.method).toBe('GET');
      else {
        expect(url.href).toBe('https://auth.test/auth/v1/token?grant_type=password');
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({ email: options.email, password: options.password });
      }
    }
  });
});
