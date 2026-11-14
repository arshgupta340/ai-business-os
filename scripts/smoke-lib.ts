import { ApiErrorSchema, ENDPOINTS } from '@abos/contracts';
import { z } from 'zod';

export interface SmokeOptions {
  baseUrl: string;
  supabaseUrl: string;
  anonKey: string;
  email: string;
  password: string;
  fetch: typeof globalThis.fetch;
  now: () => number | Date;
}

export interface SmokeResult {
  name: string;
  // A null result means that a prerequisite failed.
  ok: boolean | null;
  status: number | null;
  detail: string;
}

const TIMEOUT_MS = 10_000;
const HealthSchema = z.object({ squareEnvironment: z.literal('sandbox') });
const TokenSchema = z.object({ access_token: z.string().min(1) });

export async function runSmoke(options: SmokeOptions): Promise<SmokeResult[]> {
  const results: SmokeResult[] = [];
  const skip = (name: string, detail: string) => results.push({ name, ok: null, status: null, detail });
  async function check<T>(name: string, url: string, init: RequestInit, schema: z.ZodType<T>,
    expectedStatus = 200, validate: (data: T) => boolean = () => true,
    describe: (data: T) => string = () => 'Response verified.'): Promise<T | undefined> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let status: number | null = null;
    let timedOut = false;
    const started = Number(options.now());
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error('timeout'));
        }, TIMEOUT_MS);
      });
      // The deadline includes reading the body, even if an injected fetch ignores abort.
      const request = async () => {
        const response = await options.fetch(url, { ...init, signal: controller.signal, redirect: 'error' });
        if (timedOut) return undefined;
        status = response.status;
        if (status !== expectedStatus) {
          results.push({ name, ok: false, status, detail: `Expected HTTP ${expectedStatus}.` });
          return undefined;
        }
        const data: unknown = await response.json();
        if (timedOut) return undefined;
        const parsed = schema.safeParse(data);
        if (!parsed.success) {
          results.push({ name, ok: false, status, detail: 'Response schema failed.' });
          return undefined;
        }
        if (!validate(parsed.data)) {
          results.push({ name, ok: false, status, detail: 'Response requirement failed.' });
          return undefined;
        }
        return parsed.data;
      };
      // Do not let a late response append another result after the deadline.
      const data = await Promise.race([request(), timeout]);
      if (data !== undefined) {
        const elapsed = Math.max(0, Number(options.now()) - started);
        results.push({ name, ok: true, status, detail: `${describe(data)} (${elapsed} ms)` });
      }
      return data;
    } catch {
      results.push({ name, ok: false, status, detail: timedOut ? 'Request timed out.' : 'Request or JSON parsing failed.' });
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  const get = (token?: string): RequestInit => ({ method: 'GET', headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const serverUrl = (path: string) => new URL(path, options.baseUrl).href;
  const healthy = await check('health', serverUrl('/health'), get(), HealthSchema);
  let token: string | undefined;
  if (healthy) {
    // Refuse to send credentials to the server, including through redirects.
    const authUrl = new URL('/auth/v1/token?grant_type=password', options.supabaseUrl);
    if (authUrl.origin === new URL(options.baseUrl).origin || authUrl.username || authUrl.password
      || !['http:', 'https:'].includes(authUrl.protocol)) {
      results.push({ name: 'sign-in', ok: false, status: null, detail: 'Invalid Supabase origin.' });
    } else {
      const session = await check('sign-in', authUrl.href, {
        method: 'POST', headers: { apikey: options.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: options.email, password: options.password }),
      }, TokenSchema);
      token = session?.access_token;
    }
  } else skip('sign-in', 'Health check failed.');

  const businesses = token ? await check('businesses', serverUrl(ENDPOINTS.listBusinesses.path), get(token),
    ENDPOINTS.listBusinesses.response, 200, (data) => data.items.length > 0) : undefined;
  if (!token) skip('businesses', 'Sign-in unavailable.');
  const businessId = businesses?.items[0]?.id;
  const reads = [
    { name: 'facts', endpoint: ENDPOINTS.listFacts },
    { name: 'approvals', endpoint: ENDPOINTS.listApprovals },
    { name: 'integration health', endpoint: ENDPOINTS.getIntegrationsHealth },
    { name: 'live agent', endpoint: ENDPOINTS.getLiveAgent },
  ] as const;
  for (const { name, endpoint } of reads) {
    if (!token || !businessId) {
      skip(name, 'Business selection unavailable.');
      continue;
    }
    const url = new URL(endpoint.path.replace(':id', encodeURIComponent(businessId)), options.baseUrl);
    if ('query' in endpoint && name !== 'facts') url.searchParams.set('businessId', businessId);
    // All these responses use the schema attached to their endpoint definition.
    await check<unknown>(name, url.href, get(token), endpoint.response, 200, () => true, (data) => {
      if (name !== 'integration health') return 'Response verified.';
      const health = ENDPOINTS.getIntegrationsHealth.response.parse(data);
      // Print only contract enums, never free-form provider details or identifiers.
      return Object.entries(health).map(([provider, entry]) => `${provider}=${entry.state}`).join(', ');
    });
  }
  for (const [name, credential] of [['no token', undefined], ['malformed token', 'malformed-token']] as const) {
    if (!healthy) skip(name, 'Health check failed.');
    else await check(name, serverUrl(ENDPOINTS.listBusinesses.path), get(credential), ApiErrorSchema,
      401, (data) => data.code === 'UNAUTHENTICATED');
  }
  return results;
}

export function formatSmokeOutput(results: readonly SmokeResult[]): string[] {
  const lines = results.map((result) => `${result.name} | ${result.status ?? '-'} | ${result.ok === null ? 'skipped' : result.ok ? 'pass' : 'fail'} | ${result.detail}`);
  const passed = results.filter((result) => result.ok === true).length;
  const failed = results.filter((result) => result.ok === false).length;
  const skipped = results.filter((result) => result.ok === null).length;
  const integrations = results.find((result) => result.name === 'integration health');
  lines.push(`Summary: ${passed} passed, ${failed} failed, ${skipped} skipped. Integration health: ${integrations?.ok ? integrations.detail : 'unavailable'}`);
  return lines;
}
