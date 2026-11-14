// The composition root: a server with no optional keys still starts, reports each missing
// provider as not connected, refuses the features that need it, keeps the executor and webhook
// seams closed, and gives the builder real auth only when tokens can be verified.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENDPOINTS } from '@abos/contracts';
import { buildApp } from '../../src/app';
import { parseEnv } from '../../src/env';
import { createHarness, headers, verifier } from '../api/harness';

describe('composition without optional keys', () => {
  it('treats an empty value in .env.local as absent instead of refusing to start', () => {
    const env = parseEnv({ SQUARE_ACCESS_TOKEN: '', PUBLIC_SERVER_URL: '', GOOGLE_SERVICE_ACCOUNT_JSON: ' ', ANDROID_GATEWAY_URL: '' });
    expect(env.SQUARE_ACCESS_TOKEN).toBeUndefined();
    expect(env.PUBLIC_SERVER_URL).toBeUndefined();
    expect(() => parseEnv({ SQUARE_ENVIRONMENT: 'production' })).toThrow(/sandbox/);
  });

  it('starts, reports every provider as not connected and keeps webhooks closed', async () => {
    const app = await buildApp(parseEnv({}));
    try {
      expect((await app.inject({ url: '/health' })).statusCode).toBe(200);
      expect(app.composed.voice).toMatchObject({ ok: false });
      expect(app.composed.providers.square).toBeUndefined();
      expect(Object.values(app.composed.providers.status).every((s) => !s.configured)).toBe(true);
      for (const url of ['/webhooks/square', '/webhooks/twilio/status']) {
        const res = await app.inject({ method: 'POST', url, payload: { event_id: 'forged' } });
        expect(res.statusCode).toBe(503);
      }
      // Builder keeps its own fail-closed default when nothing can verify a token.
      const builder = await app.inject({ method: 'POST', url: '/api/builder/sessions?businessId=biz_a', headers, payload: {} });
      expect(builder.statusCode).toBe(401);
    } finally { await app.close(); }
  });
});

describe('composition with a database and a verifier', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  beforeAll(async () => { h = await createHarness(); }, 60_000);
  afterAll(async () => { await h?.close(); });

  it('health shows missing keys as disconnected, sync answers INTEGRATION_UNAVAILABLE, builder uses verified auth', async () => {
    const app = await buildApp(parseEnv({ MESSAGE_CHANNEL: 'qr_only', TWILIO_PHONE_NUMBER: '+15555550199' }), { db: h.db, verifier });
    try {
      const health = ENDPOINTS.getIntegrationsHealth.response.parse((await app.inject({ url: '/api/integrations/health?businessId=biz_a', headers })).json());
      expect(health.square.state).toBe('disconnected');
      expect(health.google_calendar.state).toBe('disconnected');
      expect(health.message_channel.state).toBe('connected');
      const sync = await app.inject({ method: 'POST', url: '/api/businesses/biz_a/catalog/sync', headers, payload: {} });
      expect(sync.json()).toMatchObject({ code: 'INTEGRATION_UNAVAILABLE' });
      // Builder auth now comes from the same JWT check: a bad token and a foreign business are refused.
      expect((await app.inject({ method: 'POST', url: '/api/builder/sessions?businessId=biz_a', headers: { authorization: 'Bearer nope' }, payload: {} })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/api/builder/sessions?businessId=biz_b', headers, payload: {} })).statusCode).toBe(403);
      // Past auth and scope, the session lands in builder_sessions through the database store.
      const created = await app.inject({ method: 'POST', url: '/api/builder/sessions?businessId=biz_a', headers, payload: {} });
      expect(created.statusCode).toBe(201);
      expect((await h.db.query('select business_id, owner_id from builder_sessions where id = $1', [created.json().id])).rows[0]).toEqual({ business_id: 'biz_a', owner_id: 'usr_a' });
    } finally { await app.close(); }
  });
});
