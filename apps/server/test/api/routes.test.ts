import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ENDPOINTS, ERROR_CODE_INFO, ApiErrorSchema, type EndpointDefinition, type ErrorCode } from '@abos/contracts';
import { buildApp } from '../../src/app';
import { parseEnv } from '../../src/env';
import { createInMemoryEngine, type EnginePorts } from '../../src/api/ports';
import { CORE_ENDPOINTS } from '../../src/api/routes';
import { createHarness, headers, verifier, HASH } from './harness';

const env = parseEnv({ TWILIO_PHONE_NUMBER: '+15555550199' });

describe('core REST authentication', () => {
  it('requires a token on every B-08 route before input validation', async () => {
    const app = await buildApp(parseEnv({}));
    try {
      for (const [name, endpoint] of CORE_ENDPOINTS) {
        const res = await app.inject({ method: endpoint.method, url: endpoint.path.replace(':id', 'biz_other') });
        expect(res.statusCode, name).toBe(401);
        expect(res.json().code).toBe('UNAUTHENTICATED');
        expect(res.json().correlationId).toBe(res.headers['x-correlation-id']);
        if (endpoint.method === 'GET') {
          const head = await app.inject({ method: 'HEAD', url: endpoint.path.replace(':id', 'biz_other') });
          expect(head.statusCode, `${name} HEAD`).toBe(401);
        }
      }
    } finally { await app.close(); }
  });
});

describe('core REST with migrated Postgres', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  let app: FastifyInstance;
  let ports: ReturnType<typeof createInMemoryEngine>;
  beforeAll(async () => {
    h = await createHarness();
    ports = createInMemoryEngine(h.approvals);
    app = await buildApp(env, { db: h.db, verifier, ports });
  }, 30_000);
  afterAll(async () => { await app?.close(); await h?.close(); });

  function assertError(res: { statusCode: number; json(): unknown; headers: Record<string, unknown> }, code: ErrorCode) {
    expect(res.statusCode).toBe(ERROR_CODE_INFO[code].httpStatus);
    const error = ApiErrorSchema.parse(res.json());
    expect(error.code).toBe(code);
    expect(error.correlationId).toBe(res.headers['x-correlation-id']);
  }

  it('rejects invalid tokens and unknown owner profiles', async () => {
    assertError(await app.inject({ url: '/api/businesses', headers: { authorization: 'Bearer invalid' } }), 'UNAUTHENTICATED');
    const isolated = await buildApp(env, { db: h.db, verifier: { async verify() { return { authUserId: '00000000-0000-4000-8000-000000000099' }; } } });
    try { assertError(await isolated.inject({ url: '/api/businesses', headers }), 'UNAUTHENTICATED'); } finally { await isolated.close(); }
  });

  it('lists only the owner businesses and returns contract profiles', async () => {
    const res = await app.inject({ url: '/api/businesses', headers });
    expect(ENDPOINTS.listBusinesses.response.parse(res.json()).items.map((b) => b.id)).toEqual(['biz_a']);
    const get = await app.inject({ url: '/api/businesses/biz_a', headers });
    expect(get.statusCode).toBe(200);
    expect(ENDPOINTS.getBusiness.response.parse(get.json()).id).toBe('biz_a');
  });

  it('AC-17 blocks every business route when the path or query names another owner business', async () => {
    for (const [name, endpoint] of CORE_ENDPOINTS) {
      if (['listBusinesses', 'getLiveAgent', 'putLiveAgent'].includes(name)) continue;
      const pathScoped = endpoint.path.startsWith('/api/businesses/');
      const url = endpoint.path.replace(':id', pathScoped ? 'biz_b' : name.includes('Approval') ? 'apv_b1' : name.includes('Booking') ? 'bkg_b1' : name.includes('Call') ? 'call_b1' : 'ord_b1');
      const res = await app.inject({ method: endpoint.method, url: `${url}${pathScoped ? '' : '?businessId=biz_b'}`, headers,
        ...(endpoint.bodyKind === 'json' ? { payload: {} } : {}) });
      expect(res.statusCode, name).toBe(403);
      assertError(res, 'FORBIDDEN_BUSINESS');
      expect(JSON.stringify(res.json())).not.toContain('Business b');
    }
    const res = await app.inject({ method: 'PUT', url: '/api/live-agent', headers, payload: { agentId: 'agt_b' } });
    assertError(res, 'NOT_FOUND');
  });

  it('does not confirm another business resource under an owned business query', async () => {
    for (const url of ['/api/orders/ord_b1', '/api/orders/ord_b1/checkout', '/api/approvals/apv_b1', '/api/bookings/bkg_b1', '/api/calls/call_b1']) {
      assertError(await app.inject({ url: `${url}?businessId=biz_a`, headers }), 'NOT_FOUND');
    }
    assertError(await app.inject({ method: 'POST', url: '/api/approvals/apv_b1/decision?businessId=biz_a', headers, payload: { decision: 'approve', payloadHash: HASH } }), 'NOT_FOUND');
  });

  for (const name of ['listOrders', 'listApprovals', 'listBookings', 'listCalls', 'listActivity'] as const) {
    it(`${name} scopes rows, paginates newest first and parses every response`, async () => {
      const endpoint = ENDPOINTS[name];
      let cursor: string | undefined;
      const ids: string[] = [];
      do {
        const res = await app.inject({ url: `${endpoint.path}?businessId=biz_a&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, headers });
        expect(res.statusCode).toBe(200);
        const page = endpoint.response.parse(res.json());
        expect(page.items).toHaveLength(1);
        expect(page.items[0]?.businessId).toBe('biz_a');
        ids.push(page.items[0]!.id);
        cursor = page.nextCursor;
        expect(ids.length).toBeLessThanOrEqual(3);
      } while (cursor);
      expect(new Set(ids).size).toBe(3);
      const last = await app.inject({ url: `${endpoint.path}?businessId=biz_a&limit=200`, headers });
      expect(endpoint.response.parse(last.json()).nextCursor).toBeUndefined();
    });
  }

  it('paginates businesses, facts and grouped catalog items with additive contract fields', async () => {
    await h.insert('businesses', { id: 'biz_a_second', owner_id: 'usr_a', name: 'Second business', category: 'restaurant', timezone: 'America/Los_Angeles' });
    await h.insert('catalog_items', { id: 'cat_a_second', business_id: 'biz_a', square_item_id: 'SECOND_ITEM', square_variation_id: 'SECOND_VAR',
      square_item_version: 1, square_variation_version: 1, item_name: 'Second pizza', variation_name: 'Regular', price_minor: 100, synced_at: '2026-11-13T00:00:00Z' });
    try {
      for (const [name, expected] of [['listBusinesses', 2], ['listFacts', 3], ['getCatalog', 2]] as const) {
        const endpoint = ENDPOINTS[name];
        const path = endpoint.path.replace(':id', 'biz_a');
        const ids: string[] = [];
        let cursor: string | undefined;
        do {
          const res = await app.inject({ url: `${path}?limit=1${cursor ? `&cursor=${cursor}` : ''}`, headers });
          expect(res.statusCode).toBe(200);
          expect(endpoint.response.safeParse(res.json()).success).toBe(true);
          const data = res.json() as { items: Record<string, unknown>[]; nextCursor?: string };
          expect(data.items, name).toHaveLength(1);
          ids.push(String(data.items[0]?.id ?? data.items[0]?.squareItemId));
          cursor = data.nextCursor;
          expect(ids.length).toBeLessThanOrEqual(expected);
        } while (cursor);
        expect(new Set(ids).size, name).toBe(expected);
      }
    } finally {
      await h.admin(async (q) => {
        await q.query('delete from public.catalog_items where id = $1', ['cat_a_second']);
        await q.query('delete from public.businesses where id = $1', ['biz_a_second']);
      });
    }
  });

  it('returns each single resource using its exact contract', async () => {
    for (const [name, id] of [['getApproval', 'apv_a1'], ['getOrder', 'ord_a1'], ['getBooking', 'bkg_a1'], ['getCall', 'call_a1']] as const) {
      const endpoint = ENDPOINTS[name];
      const res = await app.inject({ url: `${endpoint.path.replace(':id', id)}?businessId=biz_a`, headers });
      expect(res.statusCode, name).toBe(200);
      expect(endpoint.response.safeParse(res.json()).success, name).toBe(true);
    }
  });

  it('applies list filters and rejects invalid limits and cursors', async () => {
    for (const url of ['/api/orders?status=APPROVED', '/api/orders?callId=call_b1', '/api/bookings?status=REJECTED',
      '/api/bookings?from=2030-01-01T00:00:00Z', '/api/bookings?to=2020-01-01T00:00:00Z', '/api/calls?agentId=agt_b',
      '/api/calls?since=2030-01-01T00:00:00Z', '/api/activity?types=agent.paused', '/api/activity?correlationId=absent',
      '/api/activity?since=2030-01-01T00:00:00Z', '/api/approvals?bundleType=order_bundle', '/api/approvals?state=APPROVED']) {
      const res = await app.inject({ url: `${url}&businessId=biz_a`, headers });
      expect(res.statusCode, url).toBe(200);
      expect(res.json().items, url).toEqual([]);
    }
    const statuses = await app.inject({ url: '/api/orders?businessId=biz_a&status=APPROVED,AWAITING_OWNER_APPROVAL', headers });
    expect(statuses.statusCode).toBe(200);
    expect(statuses.json().items).toHaveLength(3);
    for (const query of ['limit=201', 'limit=0', 'cursor=bad', 'status=NOPE']) {
      assertError(await app.inject({ url: `/api/orders?businessId=biz_a&${query}`, headers }), 'VALIDATION_FAILED');
    }
    const first = await app.inject({ url: '/api/orders?businessId=biz_a&limit=1', headers });
    assertError(await app.inject({ url: `/api/calls?businessId=biz_a&cursor=${first.json().nextCursor}`, headers }), 'VALIDATION_FAILED');
  });

  it('patches only name, contact and settings and refuses fact fields', async () => {
    const patch = await app.inject({ method: 'PATCH', url: '/api/businesses/biz_a', headers, payload: { name: 'Updated', contact: { address: 'Main Street' }, settings: { nested_key: 1 } } });
    expect(patch.statusCode).toBe(200);
    expect(ENDPOINTS.updateBusiness.response.parse(patch.json())).toMatchObject({ name: 'Updated', settings: { nested_key: 1 } });
    for (const field of ['hours', 'facts', 'policy', 'timezone', 'ownerId']) {
      assertError(await app.inject({ method: 'PATCH', url: '/api/businesses/biz_a', headers, payload: { [field]: 'forbidden' } }), 'VALIDATION_FAILED');
    }
  });

  it('reads business facts without rewriting keys or nulls in their JSON', async () => {
    const res = await app.inject({ url: '/api/businesses/biz_a/facts', headers });
    const result = ENDPOINTS.listFacts.response.parse(res.json());
    expect(result.items).toHaveLength(3);
    expect(result.items.every((f) => f.businessId === 'biz_a')).toBe(true);
    expect(result.items[0]?.value).toEqual({ field_with_underscore: null });
    const filtered = await app.inject({ url: '/api/businesses/biz_a/facts?kind=hours', headers });
    expect(filtered.json().items).toEqual([]);
  });

  it('proposes a fact through the engine without writing fact rows', async () => {
    const spy = vi.spyOn(ports, 'proposeFactEdit');
    const before = (await h.db.query('select count(*)::int as n from public.business_facts')).rows;
    const res = await app.inject({ method: 'POST', url: '/api/businesses/biz_a/facts/propose', headers,
      payload: { kind: 'hours', key: 'fri', value: { closed: true }, reason: 'Holiday' } });
    expect(res.statusCode).toBe(201);
    ENDPOINTS.proposeFact.response.parse(res.json());
    expect(spy).toHaveBeenCalledWith({ businessId: 'biz_a', ownerUserId: 'usr_a', kind: 'hours', key: 'fri', value: { closed: true }, reason: 'Holiday' });
    expect((await h.db.query('select count(*)::int as n from public.business_facts')).rows).toEqual(before);
    spy.mockRestore();
  });

  it('groups catalog variations and leaves sync behind the adapter port', async () => {
    const res = await app.inject({ url: '/api/businesses/biz_a/catalog', headers });
    const result = ENDPOINTS.getCatalog.response.parse(res.json());
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.variations).toHaveLength(3);
    expect(result.items[0]?.businessId).toBe('biz_a');
    assertError(await app.inject({ method: 'POST', url: '/api/businesses/biz_a/catalog/sync', headers, payload: {} }), 'INTEGRATION_UNAVAILABLE');
  });

  it('returns checkout readiness only for provider-confirmed fields', async () => {
    const res = await app.inject({ url: '/api/orders/ord_a1/checkout?businessId=biz_a', headers });
    expect(ENDPOINTS.getOrderCheckout.response.parse(res.json())).toEqual({ orderId: 'ord_a1', ready: false, environment: 'sandbox' });
  });

  it('passes the exact payload hash and safely replays simultaneous identical decisions', async () => {
    const spy = vi.spyOn(ports, 'decide');
    const inject = () => app.inject({ method: 'POST', url: '/api/approvals/apv_a1/decision?businessId=biz_a',
      headers: { ...headers, 'idempotency-key': 'decision-one' }, payload: { decision: 'approve', payloadHash: h.hashOf('apv_a1'), reason: 'Confirmed' } });
    const [first, repeated] = await Promise.all([inject(), inject()]);
    expect(first.statusCode).toBe(200);
    expect(repeated.json()).toEqual(first.json());
    ENDPOINTS.decideApproval.response.parse(first.json());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ approvalId: 'apv_a1', businessId: 'biz_a', ownerUserId: 'usr_a', decision: 'approve', payloadHash: h.hashOf('apv_a1'), reason: 'Confirmed' });
    const noKey = await app.inject({ method: 'POST', url: '/api/approvals/apv_a1/decision?businessId=biz_a', headers, payload: { decision: 'approve', payloadHash: h.hashOf('apv_a1') } });
    expect(noKey.json()).toEqual(first.json());
    assertError(await app.inject({ method: 'POST', url: '/api/approvals/apv_a1/decision?businessId=biz_a', headers: { ...headers, 'idempotency-key': 'decision-one' }, payload: { decision: 'reject', payloadHash: h.hashOf('apv_a1') } }), 'VALIDATION_FAILED');
    spy.mockRestore();
  });

  for (const code of ['PAYLOAD_HASH_MISMATCH', 'APPROVAL_EXPIRED', 'APPROVAL_ALREADY_DECIDED', 'ENVIRONMENT_MISMATCH', 'NOT_FOUND', 'INVALID_STATE', 'INTEGRATION_UNAVAILABLE'] as const) {
    it(`maps typed engine error ${code} to the contract status and envelope`, async () => {
      const broken: EnginePorts = { ...ports, async decide() { throw Object.assign(new Error('secret provider response'), { code }); } };
      const isolated = await buildApp(env, { db: h.db, verifier, ports: broken });
      try {
        const res = await isolated.inject({ method: 'POST', url: '/api/approvals/apv_a2/decision?businessId=biz_a', headers,
          payload: { decision: 'approve', payloadHash: HASH } });
        assertError(res, code);
        expect(JSON.stringify(res.json())).not.toContain('secret');
      } finally { await isolated.close(); }
    });
  }

  it('reports integration configuration and sandbox through the contract', async () => {
    const res = await app.inject({ url: '/api/integrations/health?businessId=biz_a', headers });
    const health = ENDPOINTS.getIntegrationsHealth.response.parse(res.json());
    expect(health.square).toMatchObject({ state: 'disconnected', detail: 'unconfigured', environment: 'sandbox' });
    expect(res.json().squareEnvironment).toBe('sandbox');
    expect(Object.values(health).every((provider) => provider.lastCheckedAt.endsWith('Z'))).toBe(true);
  });

  it('returns empty live agent, then switches and reads the pinned version with an audit event', async () => {
    const empty = await app.inject({ url: '/api/live-agent', headers });
    expect(ENDPOINTS.getLiveAgent.response.parse(empty.json())).toMatchObject({ phoneNumber: '+15555550199', businessId: 'biz_a' });
    expect(empty.json().agentId).toBeUndefined();
    const put = await app.inject({ method: 'PUT', url: '/api/live-agent', headers, payload: { agentId: 'agt_a' } });
    expect(put.statusCode).toBe(200);
    expect(ENDPOINTS.putLiveAgent.response.parse(put.json())).toMatchObject({ agentId: 'agt_a', agentVersionId: 'agv_a', businessId: 'biz_a' });
    const get = await app.inject({ url: '/api/live-agent', headers });
    expect(get.json()).toEqual(put.json());
    const events = await h.pg.query<{ payload: Record<string, unknown> }>("select payload from public.activity_events where type = 'live_agent.changed' and business_id = 'biz_a'");
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.payload.phoneNumberLast4).toBe('0199');
    expect(JSON.stringify(events.rows)).not.toContain('+1555');
    const other = await app.inject({ url: '/api/live-agent', headers: { authorization: 'Bearer b' } });
    expect(other.json().agentId).toBeUndefined();
    assertError(await app.inject({ method: 'PUT', url: '/api/live-agent', headers: { authorization: 'Bearer b' }, payload: { agentId: 'agt_b' } }), 'FORBIDDEN_BUSINESS');
  });

  it('returns INTEGRATION_UNAVAILABLE when a required optional integration is missing', async () => {
    const isolated = await buildApp(parseEnv({}), { db: h.db, verifier, ports });
    try { assertError(await isolated.inject({ url: '/api/live-agent', headers }), 'INTEGRATION_UNAVAILABLE'); } finally { await isolated.close(); }
  });

  it('replaces invalid server responses with INTERNAL and logs the failure', async () => {
    const broken: EnginePorts = { ...ports, async decide(input) {
      const result = await ports.decide(input);
      return { ...result, approval: { ...result.approval, state: 'BROKEN' } } as unknown as Awaited<ReturnType<EnginePorts['decide']>>;
    } };
    const isolated = await buildApp(env, { db: h.db, verifier, ports: broken });
    const log = vi.spyOn(isolated.log, 'error');
    try {
      const res = await isolated.inject({ method: 'POST', url: '/api/approvals/apv_a3/decision?businessId=biz_a', headers, payload: { decision: 'reject', payloadHash: h.hashOf('apv_a3') } });
      assertError(res, 'INTERNAL');
      expect(JSON.stringify(res.json())).not.toContain('BROKEN');
      expect(log).toHaveBeenCalled();
    } finally { await isolated.close(); }
  });

  it('allows the web CORS preflight and exposes correlation headers', async () => {
    const res = await app.inject({ method: 'OPTIONS', url: '/api/businesses', headers: {
      origin: 'http://localhost:3000', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization',
    } });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(res.headers['x-correlation-id']).toBeTruthy();
  });

  it('uses canonical sanitized errors for unsupported or malformed request bodies', async () => {
    const unsupported = await app.inject({ method: 'PATCH', url: '/api/businesses/biz_a', headers: { ...headers, 'content-type': 'application/xml' }, payload: '<private>sensitive-value</private>' });
    assertError(unsupported, 'VALIDATION_FAILED');
    const malformed = await app.inject({ method: 'PATCH', url: '/api/businesses/biz_a', headers: { ...headers, 'content-type': 'application/json' }, payload: '{"private":"sensitive-value",' });
    assertError(malformed, 'VALIDATION_FAILED');
    expect(JSON.stringify(malformed.json())).not.toContain('sensitive-value');
  });
});
