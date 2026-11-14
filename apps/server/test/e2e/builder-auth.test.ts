// Web app audit (Phase 3) and review finding 8: through the composed app, a signed-in owner reaches the
// builder routes; without a token verifier the builder answers INTEGRATION_UNAVAILABLE (a server
// problem, so the web app does not sign the owner out); every delegated /api route but the ping
// refuses a request without a token.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { parseEnv } from '../../src/env';
import { OWNER, PHONE, createWorld, type World } from './world';

const PIZZA = 'biz_pizza_01';

describe('builder routes through the composed app', () => {
  let w: World;
  beforeAll(async () => { w = await createWorld(); }, 120_000);
  afterAll(async () => { await w?.close(); });

  it('an authenticated owner reaches the builder routes', async () => {
    const list = await w.app.inject({ url: `/api/agents?businessId=${PIZZA}`, headers: OWNER });
    expect(list.statusCode, list.body).toBe(200);
    const session = await w.app.inject({ method: 'POST', url: `/api/builder/sessions?businessId=${PIZZA}`, headers: OWNER, payload: {} });
    expect(session.statusCode, session.body).toBe(201);
  });

  // Review finding 8: GET /api/builder/ping is still open. The builder's own test (builder/auth.test.ts)
  // requires it open and that directory is the UI lead's, so it is left to her (needs:saina).
  it('every delegated /api route except the builder ping refuses a request without a token', async () => {
    await w.app.ready();
    const delegated = w.app.routeInventory().filter((r) => r.url.startsWith('/api/') && r.url !== '/api/builder/ping' && r.auth === 'builder' && (r.method === 'GET' || r.method === 'POST'));
    expect(delegated.length).toBeGreaterThan(5);
    for (const r of delegated) {
      const url = r.url.replace(/:[A-Za-z]+/g, 'x_missing') + `?businessId=${PIZZA}`;
      const res = await w.app.inject({ method: r.method as 'GET' | 'POST', url, ...(r.method === 'POST' ? { payload: {} } : {}) });
      // The upload route parses its multipart body first and refuses this JSON body before any handler runs.
      if (r.method === 'POST' && r.url.endsWith('/files')) expect([400, 401], r.url).toContain(res.statusCode);
      else expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
    }
  });

  it('with no token verifier, the builder answers INTEGRATION_UNAVAILABLE, not UNAUTHENTICATED', async () => {
    const env = parseEnv({ TWILIO_PHONE_NUMBER: PHONE, MESSAGE_CHANNEL: 'qr_only' });
    // The world's database, no verifier option and no SUPABASE_URL.
    const app = await buildApp(env, { db: w.t.db });
    try {
      const res = await app.inject({ url: `/api/agents?businessId=${PIZZA}`, headers: OWNER });
      expect(res.json()).toMatchObject({ code: 'INTEGRATION_UNAVAILABLE' });
    } finally { await app.close(); }
  });
});

describe('the live agent routes without TWILIO_PHONE_NUMBER', () => {
  let w: World;
  beforeAll(async () => { w = await createWorld({}, { TWILIO_PHONE_NUMBER: '' }); }, 120_000);
  afterAll(async () => { await w?.close(); });

  it('GET and PUT answer the contract error INTEGRATION_UNAVAILABLE with a plain message', async () => {
    const get = await w.app.inject({ url: '/api/live-agent', headers: OWNER });
    expect(get.json()).toMatchObject({ code: 'INTEGRATION_UNAVAILABLE', message: 'Phone number is not configured.' });
    const put = await w.app.inject({ method: 'PUT', url: '/api/live-agent', headers: OWNER, payload: { agentId: 'agt_pizza_01' } });
    expect(put.json()).toMatchObject({ code: 'INTEGRATION_UNAVAILABLE', message: 'Phone number is not configured.' });
  });
});

describe('issue #96 item 3: a database conflict on the in-memory extraction route', () => {
  let w: World;
  beforeAll(async () => { w = await createWorld(); }, 120_000);
  afterAll(async () => { await w?.close(); });

  it('answers a contract error that names the working path, not a 404', async () => {
    const row = (await w.t.db.query("select id, business_id from fact_conflicts where state = 'open' limit 1", [])).rows[0] as { id: string; business_id: string } | undefined;
    if (!row) {
      await w.t.admin((q) => q.query(`insert into public.fact_conflicts (id, business_id, kind, key, candidates, required, state) values ('cfl_e2e_96', $1, 'policy', 'parking', '[{"value":"a"},{"value":"b"}]'::jsonb, true, 'open')`, [PIZZA]));
    }
    const id = row?.id ?? 'cfl_e2e_96';
    const biz = row?.business_id ?? PIZZA;
    const res = await w.app.inject({ method: 'POST', url: `/api/conflicts/${id}/resolve?businessId=${biz}`, headers: OWNER, payload: { value: 'x' } });
    expect(res.json()).toMatchObject({ code: 'INTEGRATION_UNAVAILABLE', details: { use: 'POST /api/businesses/:id/facts/propose with resolvesConflictId' } });
  });
});
