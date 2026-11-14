// Review finding 5: integration health keeps "configured" apart from "connected". A provider is
// connected only after a bounded read-only probe confirmed access; refresh=1 runs the probes and the
// results are cached with the time they were taken.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENDPOINTS } from '@abos/contracts';
import { buildApp } from '../../src/app';
import { buildProviders } from '../../src/compose/providers';
import { parseEnv } from '../../src/env';
import { createHarness, headers, verifier } from '../api/harness';

const configured = { configured: true, detail: 'configured' };

describe('integration health', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  beforeAll(async () => { h = await createHarness(); }, 60_000);
  afterAll(async () => { await h?.close(); });

  it('reports configured providers disconnected until a probe confirms them; refresh runs probes and caches results', async () => {
    const calls: string[] = [];
    const app = await buildApp(parseEnv({ MESSAGE_CHANNEL: 'surge' }), {
      db: h.db, verifier, healthProbeTimeoutMs: 50,
      providers: {
        status: { square: configured, twilio: configured, openai: configured, google_calendar: configured, google_sheets: configured, message_channel: configured },
        probes: {
          square: async () => { calls.push('square'); return { ok: true, detail: 'sandbox reachable' }; },
          google_calendar: async () => { calls.push('calendar'); return { ok: false, detail: 'calendar not readable by the service account' }; },
          google_sheets: () => { calls.push('sheets'); return new Promise(() => {}); },
          openai: async () => { calls.push('openai'); throw new Error('raw provider error with secret-looking text'); },
        },
      },
    });
    try {
      const url = '/api/integrations/health?businessId=biz_a';
      const before = ENDPOINTS.getIntegrationsHealth.response.parse((await app.inject({ url, headers })).json());
      expect(calls).toEqual([]);
      for (const entry of Object.values(before)) expect(entry.state).toBe('disconnected');
      expect(before.square.detail).toMatch(/not checked yet/);
      expect(before.message_channel.detail).toMatch(/no read-only check/);

      const refreshed = ENDPOINTS.getIntegrationsHealth.response.parse((await app.inject({ url: `${url}&refresh=1`, headers })).json());
      expect(calls.sort()).toEqual(['calendar', 'openai', 'sheets', 'square']);
      expect(refreshed.square).toMatchObject({ state: 'connected', detail: 'sandbox reachable', environment: 'sandbox' });
      expect(refreshed.google_calendar).toMatchObject({ state: 'disconnected', detail: 'calendar not readable by the service account' });
      expect(refreshed.google_sheets).toMatchObject({ state: 'disconnected', detail: 'check timed out' });
      expect(refreshed.openai).toMatchObject({ state: 'disconnected', detail: 'check failed' });
      expect(JSON.stringify(refreshed)).not.toMatch(/secret-looking/);
      // twilio has no probe here: configured, but never reported connected.
      expect(refreshed.twilio.state).toBe('disconnected');

      // Without refresh, the stored results come back unchanged and no probe runs.
      const cached = ENDPOINTS.getIntegrationsHealth.response.parse((await app.inject({ url, headers })).json());
      expect(calls).toHaveLength(4);
      expect(cached.square).toEqual(refreshed.square);
      expect(cached.square.lastCheckedAt).toBe(refreshed.square.lastCheckedAt);
    } finally { await app.close(); }
  });

  it('refuses service-account credentials with empty or malformed fields', () => {
    for (const json of [JSON.stringify({ client_email: '', private_key: '' }), JSON.stringify({ client_email: 'not-an-email', private_key: 'x' }), '{bad']) {
      const p = buildProviders(parseEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: json, GOOGLE_CALENDAR_ID: 'cal', GOOGLE_SHEET_ID: 'sheet' }), () => new Date());
      expect(p.status.google_calendar).toEqual({ configured: false, detail: 'GOOGLE_SERVICE_ACCOUNT_JSON is not usable' });
      expect(p.status.google_sheets.configured).toBe(false);
      expect(p.calendar).toBeUndefined();
      expect(p.probes?.google_calendar).toBeUndefined();
    }
  });

  it('qr_only needs no provider and is connected without a probe', async () => {
    const app = await buildApp(parseEnv({ MESSAGE_CHANNEL: 'qr_only' }), { db: h.db, verifier });
    try {
      const health = ENDPOINTS.getIntegrationsHealth.response.parse((await app.inject({ url: '/api/integrations/health?businessId=biz_a', headers })).json());
      expect(health.message_channel).toMatchObject({ state: 'connected', channel: 'qr_only' });
      expect(health.square.state).toBe('disconnected');
    } finally { await app.close(); }
  });
});
