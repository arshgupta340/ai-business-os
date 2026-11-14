// Review finding 8: every registered /api route declares an auth policy, and a route that declares
// none is still authenticated. The inventory is of the routes the app actually registered, not of
// ENDPOINTS.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, type World } from './world';

let w: World;
beforeAll(async () => {
  // Voice on, so its routes are in the inventory too.
  w = await createWorld({}, { TWILIO_AUTH_TOKEN: 'test-twilio-token', TWILIO_ACCOUNT_SID: 'ACtest', OPENAI_API_KEY: 'test-openai-key' });
}, 120_000);
afterAll(async () => { await w?.close(); });

describe('route auth policies', () => {
  it('every registered /api route has an auth policy; builder routes delegate, none is public', async () => {
    await w.app.ready();
    const routes = w.app.routeInventory();
    const api = routes.filter((r) => r.url === '/api' || r.url.startsWith('/api/'));
    expect(api.length).toBeGreaterThan(20);
    const missing = api.filter((r) => r.auth === undefined).map((r) => `${r.method} ${r.url}`);
    expect(missing).toEqual([]);
    expect(api.filter((r) => r.auth === 'public')).toEqual([]);
    for (const r of api.filter((x) => x.url.startsWith('/api/builder/'))) expect(r.auth).toBe('builder');
    for (const url of ['/api/approvals', '/api/agents/:id/sim-call', '/api/telemetry']) expect(api.find((r) => r.url === url)?.auth).toBe('owner');
  });

  it('an /api route registered with no policy is authenticated by default', async () => {
    const { buildApp } = await import('../../src/app');
    const { parseEnv } = await import('../../src/env');
    const { verifier } = await import('./world');
    const app = await buildApp(parseEnv({}), { db: w.t.db, verifier });
    let reached = 0;
    app.get('/api/new-owner-resource', async () => { reached++; return { ok: true }; });
    try {
      const res = await app.inject({ url: '/api/new-owner-resource' });
      expect(res.statusCode).toBe(401);
      expect((await app.inject({ url: '/api/new-owner-resource', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
      expect((await app.inject({ url: '/api/new-owner-resource', headers: { authorization: 'Bearer owner' } })).statusCode).toBe(200);
      expect((await app.inject({ url: '/api/new-owner-resource?businessId=biz_other_01', headers: { authorization: 'Bearer owner' } })).statusCode).toBe(403);
      expect(reached).toBe(1);
    } finally { await app.close(); }
  });
});
