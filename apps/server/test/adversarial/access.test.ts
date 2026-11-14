// B-23 groups 5 and 6: tenant isolation and authentication. The list of routes is the server's own
// (app.routeInventory()), never a hand-written table: a route added later is checked at once, and a
// route with an ID that this file has no victim resource for fails the coverage test.
//
// Cast: OWNER owns the pizza shop and the barbershop and has every resource. OTHER is a second,
// correctly signed-in owner with one empty business (biz_other_01), and is the attacker.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { multipartBody, pdf, PIZZA_MENU_TEXT } from '../../src/builder/extraction/test-samples';
import type { TokenVerifier } from '../../src/auth/verify';
import { currentRole } from '../support/db';
import { OTHER, OTHER_AUTH, OWNER, OWNER_AUTH, createWorld, type World } from '../e2e/world';
import {
  BARBER, NONE, OTHER_BIZ, PIZZA, RECIPIENT, VOICE_ENV, approve, bookingProposal, count, counts, delta, filterCalendarListByProperty, getApproval, order, pizzaOrder, statusOf,
} from './helpers';

type Route = { method: string; url: string; auth: string | undefined };
type Res = { statusCode: number; body: string; headers: Record<string, unknown> };
type Target = { business: string; otherOwned: string; id: string; body?: () => unknown; multipart?: true };

const CUSTOMER = 'Zebulon Quartermaine';
const FILE_NAME = 'victim-menu-adv.pdf';

let w: World;
let routes: Route[] = [];
let api: Route[] = [];
/** One victim resource per route pattern that carries an ID. */
let targets: Record<string, Target> = {};
/** Strings that belong to the victim. None may appear in a response to anyone else. */
let leaks: string[] = [];
let ids: { approvalId: string; orderId: string; callId: string; paidOrderId: string; bookingId: string; bookingApprovalId: string; sessionId: string; fileId: string; conflictId: string; payloadHash: string; executionId: string };

const keyOf = (r: Route) => `${r.method} ${r.url}`;
const json = (res: Res): Record<string, unknown> => { try { return JSON.parse(res.body) as Record<string, unknown>; } catch { return {}; } };

/** Sends one request to a route, with its `:id` filled in and the scope given as path or query. */
async function send(route: Route, opts: { id?: string; businessId?: string | string[] | undefined; headers?: Record<string, string>; body?: unknown; multipart?: boolean; query?: string }): Promise<Res> {
  const path = route.url.replace(':id', encodeURIComponent(opts.id ?? 'x'));
  const scope = route.url.startsWith('/api/businesses/:id') || opts.businessId === undefined ? []
    : (Array.isArray(opts.businessId) ? opts.businessId : [opts.businessId]).map((b) => `businessId=${encodeURIComponent(b)}`);
  const query = [...scope, ...(opts.query ? [opts.query] : [])].join('&');
  const hasBody = !['GET', 'HEAD', 'DELETE', 'OPTIONS'].includes(route.method);
  const upload = opts.multipart ? multipartBody({ fileName: 'attack.pdf', mime: 'application/pdf', bytes: pdf('attack') }) : undefined;
  const res = await w.app.inject({
    method: route.method as 'GET', url: `${path}${query ? `?${query}` : ''}`,
    headers: { ...(opts.headers ?? {}), ...(upload ? { 'content-type': upload.contentType } : {}) },
    ...(upload ? { payload: upload.payload } : hasBody ? { payload: (opts.body ?? {}) as object } : {}),
  });
  return { statusCode: res.statusCode, body: res.body, headers: res.headers };
}

function leaked(res: Res): string[] {
  return leaks.filter((s) => res.body.includes(s));
}

beforeAll(async () => {
  w = await createWorld({}, VOICE_ENV);
  filterCalendarListByProperty(w);
  await w.app.ready();
  routes = w.app.routeInventory();
  api = routes.filter((r) => r.url === '/api' || r.url.startsWith('/api/'));

  // The victim's resources, all made through the server's own routes.
  const pending = await pizzaOrder(w, { name: CUSTOMER });
  const paid = await pizzaOrder(w, { name: CUSTOMER, recipient: '+15555550166' });
  await approve(w, PIZZA, paid.approvalId);
  const booking = await bookingProposal(w, { recipient: '+15555550167' });
  const session = await w.app.inject({ method: 'POST', url: `/api/builder/sessions?businessId=${PIZZA}`, headers: OWNER, payload: {} });
  expect(session.statusCode).toBe(201);
  const upload = multipartBody({ fileName: FILE_NAME, mime: 'application/pdf', bytes: pdf(PIZZA_MENU_TEXT) });
  const uploaded = await w.app.inject({ method: 'POST', url: `/api/businesses/${PIZZA}/files`, headers: { ...OWNER, 'content-type': upload.contentType }, payload: upload.payload });
  expect(uploaded.statusCode).toBe(202);
  const fileId = (uploaded.json() as { file: { id: string } }).file.id;
  let file: { extractionState: string; conflictIds?: string[] } = { extractionState: 'PENDING' };
  for (let i = 0; i < 200 && file.extractionState !== 'EXTRACTED' && file.extractionState !== 'FAILED'; i++) {
    await new Promise((r) => setTimeout(r, 10));
    file = (await w.app.inject({ url: `/api/files/${fileId}?businessId=${PIZZA}`, headers: OWNER })).json() as typeof file;
  }
  expect(file.extractionState).toBe('EXTRACTED');
  const approval = await getApproval(w, PIZZA, pending.approvalId);
  const paidRow = await order(w, paid.orderId);
  const executionId = ((await w.t.db.query('select id from action_executions where approval_id = $1 order by step_index limit 1', [paid.approvalId])).rows[0] as { id: string }).id;
  ids = { approvalId: pending.approvalId, orderId: pending.orderId, callId: pending.callId, paidOrderId: paid.orderId, bookingId: booking.bookingId, bookingApprovalId: booking.approvalId,
    sessionId: (session.json() as { id: string }).id, fileId, conflictId: file.conflictIds?.[0] ?? 'cfl_adv_missing', payloadHash: approval.payloadHash, executionId };

  const pizza = (id: string, extra: Partial<Target> = {}): Target => ({ business: PIZZA, otherOwned: BARBER, id, ...extra });
  targets = {
    'GET /api/businesses/:id': pizza(PIZZA),
    'PATCH /api/businesses/:id': pizza(PIZZA, { body: () => ({ name: 'Taken Over' }) }),
    'GET /api/businesses/:id/facts': pizza(PIZZA),
    'POST /api/businesses/:id/facts/propose': pizza(PIZZA, { body: () => ({ kind: 'hours', key: 'fri', value: { closed: true }, reason: 'attack' }) }),
    'GET /api/businesses/:id/catalog': pizza(PIZZA),
    'POST /api/businesses/:id/catalog/sync': pizza(PIZZA),
    'POST /api/businesses/:id/files': pizza(PIZZA, { multipart: true }),
    'GET /api/approvals/:id': pizza(ids.approvalId),
    'POST /api/approvals/:id/decision': pizza(ids.approvalId, { body: () => ({ decision: 'approve', payloadHash: ids.payloadHash }) }),
    'GET /api/orders/:id': pizza(ids.paidOrderId),
    'GET /api/orders/:id/checkout': pizza(ids.paidOrderId),
    'GET /api/bookings/:id': { business: BARBER, otherOwned: PIZZA, id: ids.bookingId },
    'GET /api/calls/:id': pizza(ids.callId),
    'POST /api/agents/:id/sim-call': pizza('agt_pizza_01', { body: () => ({ message: 'What pizzas do you have?' }) }),
    'GET /api/builder/sessions/:id': pizza(ids.sessionId),
    'POST /api/builder/sessions/:id/messages': pizza(ids.sessionId, { body: () => ({ text: 'Add a write tool', inputMode: 'text' }) }),
    'GET /api/agents/:id': pizza('agt_pizza_01'),
    'POST /api/agents/:id/preview': pizza('agt_pizza_01'),
    'POST /api/agents/:id/test': pizza('agt_pizza_01', { body: () => ({ message: 'hello' }) }),
    'POST /api/agents/:id/publish': pizza('agt_pizza_01', { body: () => ({ confirm: true, makeLive: true }) }),
    'POST /api/agents/:id/pause': pizza('agt_pizza_01'),
    'GET /api/agents/:id/versions': pizza('agt_pizza_01'),
    'POST /api/agents/:id/rollback': pizza('agt_pizza_01', { body: () => ({ toVersionId: 'agv_pizza_01_v1', confirm: true, makeLive: true }) }),
    'GET /api/files/:id': pizza(ids.fileId),
    'POST /api/conflicts/:id/resolve': pizza(ids.conflictId, { body: () => ({ resolution: 'keep_authoritative' }) }),
    // Routes implemented on arsh/integration after the suite was written (SHOULD tier); added after the merge.
    'POST /api/businesses/:id/catalog/prices/propose': pizza(PIZZA, { body: () => ({ variationId: 'SQ_VAR_PEP_LG', newPriceMinor: 1, currency: 'USD' }) }),
    'POST /api/orders/:id/cancel': pizza(ids.paidOrderId, { body: () => ({}) }),
    'POST /api/executions/:id/resolve': pizza(ids.executionId, { body: () => ({ action: 'retry' }) }),
  };
  for (const [key, target] of Object.entries(targets)) if (key.startsWith('GET ')) targets[`HEAD ${key.slice(4)}`] = target;

  leaks = [
    ids.payloadHash, RECIPIENT, '+15555550166', '+15555550167', CUSTOMER, 'Zebulon', FILE_NAME, paidRow.checkout_url!, paidRow.square_order_id!, paidRow.square_payment_link_id!,
    'Demo Pizza', 'Demo Barbershop', 'Pizza Order Assistant', 'Booking Assistant', 'Pepperoni', 'Margherita', 'SQ_VAR_', 'thanks for calling',
    ids.approvalId, ids.orderId, ids.paidOrderId, ids.callId, ids.bookingId, ids.bookingApprovalId, ids.sessionId, ids.fileId, ids.executionId, 'agv_pizza', 'agv_barber', 'usr_owner_01', OWNER_AUTH, 'owner@example.com',
  ];
}, 120_000);
afterAll(async () => { await w?.close(); });

/** The victim's data must be exactly as it was, whatever the attacker sent. */
async function victimSnapshot() {
  const q = async (sql: string, params: unknown[] = []) => JSON.stringify((await w.t.db.query(sql, params)).rows);
  return {
    writes: counts(w),
    businesses: await q("select id, name, contact, settings, owner_id from businesses where id in ($1, $2) order by id", [PIZZA, BARBER]),
    facts: await q('select id, status, version, value from business_facts where business_id in ($1, $2) order by id', [PIZZA, BARBER]),
    agents: await q('select id, state, active_version_id, draft_spec, spec_revision from agents where business_id in ($1, $2) order by id', [PIZZA, BARBER]),
    versions: await count(w, 'agent_versions where business_id in ($1, $2)', [PIZZA, BARBER]),
    liveAgent: await q('select phone_number, business_id, agent_id, agent_version_id from live_agent order by phone_number'),
    approvals: await q('select id, state, decided_by from approval_requests where business_id in ($1, $2) order by id', [PIZZA, BARBER]),
    orders: await q('select id, status from orders order by id'),
    bookings: await q('select id, status from bookings order by id'),
    calls: await count(w, 'calls where business_id in ($1, $2)', [PIZZA, BARBER]),
    executions: await count(w, 'action_executions'),
    conflicts: await q('select id, state from fact_conflicts order by id'),
    sessions: await q('select id, status, jsonb_array_length(messages) as n from builder_sessions order by id'),
    files: await count(w, 'files'),
    session: (await w.app.inject({ url: `/api/builder/sessions/${ids.sessionId}?businessId=${PIZZA}`, headers: OWNER })).body.length,
  };
}

it('runs as abos_app; every registered route with an ID has a victim resource in this file', async () => {
  expect(await currentRole(w.t.db)).toBe('abos_app');
  expect(api.length).toBeGreaterThan(50);
  const withId = api.filter((r) => r.url.includes(':')).map(keyOf).sort();
  expect(withId.filter((k) => !targets[k])).toEqual([]);
  expect(Object.keys(targets).filter((k) => !withId.includes(k))).toEqual([]);
  // The only parameter name in use is :id, which is what send() fills in.
  expect(api.filter((r) => /:(?!id\b)/.test(r.url))).toEqual([]);
  expect(ids.conflictId).toMatch(/^cfl_/);
});

describe('tenant isolation', () => {
  it('another owner naming the victim business gets 403 FORBIDDEN_BUSINESS on every route with an ID, and nothing leaks or changes', async () => {
    const before = await victimSnapshot();
    const violations: string[] = [];
    for (const route of api.filter((r) => r.url.includes(':id'))) {
      const t = targets[keyOf(route)]!;
      const res = await send(route, { id: t.id, businessId: t.business, headers: OTHER, body: t.body?.(), ...(t.multipart ? { multipart: true } : {}) });
      if (res.statusCode !== 403) violations.push(`${keyOf(route)}: status ${res.statusCode}`);
      else if (route.method !== 'HEAD' && json(res).code !== 'FORBIDDEN_BUSINESS') violations.push(`${keyOf(route)}: code ${String(json(res).code)}`);
      const found = leaked(res);
      if (found.length) violations.push(`${keyOf(route)}: leaked ${found.join(', ')}`);
    }
    expect(violations).toEqual([]);
    await w.settle();
    expect(await victimSnapshot()).toEqual(before);
  });

  it('another owner using their own business scope with the victim resource ID gets 404 NOT_FOUND, and nothing leaks or changes', async () => {
    const before = await victimSnapshot();
    const violations: string[] = [];
    // Routes under /api/businesses/:id carry no second ID: the path is the scope, covered by the test above.
    for (const route of api.filter((r) => r.url.includes(':id') && !r.url.startsWith('/api/businesses/:id'))) {
      const t = targets[keyOf(route)]!;
      const res = await send(route, { id: t.id, businessId: OTHER_BIZ, headers: OTHER, body: t.body?.() });
      if (res.statusCode !== 404) violations.push(`${keyOf(route)}: status ${res.statusCode}`);
      else if (route.method !== 'HEAD' && json(res).code !== 'NOT_FOUND') violations.push(`${keyOf(route)}: code ${String(json(res).code)}`);
      const found = leaked(res);
      if (found.length) violations.push(`${keyOf(route)}: leaked ${found.join(', ')}`);
    }
    expect(violations).toEqual([]);
    await w.settle();
    expect(await victimSnapshot()).toEqual(before);
    expect(await count(w, 'calls where business_id = $1', [OTHER_BIZ])).toBe(0);
  });

  it('the owner of two businesses cannot reach a resource of one through the scope of the other: 404 NOT_FOUND', async () => {
    const before = await victimSnapshot();
    const violations: string[] = [];
    for (const route of api.filter((r) => r.url.includes(':id') && !r.url.startsWith('/api/businesses/:id'))) {
      const t = targets[keyOf(route)]!;
      const res = await send(route, { id: t.id, businessId: t.otherOwned, headers: OWNER, body: t.body?.() });
      if (res.statusCode !== 404) violations.push(`${keyOf(route)}: status ${res.statusCode}`);
      else if (route.method !== 'HEAD' && json(res).code !== 'NOT_FOUND') violations.push(`${keyOf(route)}: code ${String(json(res).code)}`);
      // The owner may see their own business names; the resource itself must not come back.
      for (const s of [ids.payloadHash, RECIPIENT, '+15555550166', '+15555550167', CUSTOMER, FILE_NAME]) if (res.body.includes(s)) violations.push(`${keyOf(route)}: leaked ${s}`);
    }
    expect(violations).toEqual([]);
    await w.settle();
    expect(await victimSnapshot()).toEqual(before);
  });

  it('a scope that is missing, repeated or malformed never opens the victim resource', async () => {
    const before = await victimSnapshot();
    const violations: string[] = [];
    const scopes: (string | string[] | undefined)[] = [undefined, [OTHER_BIZ, PIZZA], [PIZZA, OTHER_BIZ], '', `${OTHER_BIZ}' or '1'='1`, '%', '*', ` ${PIZZA}`, PIZZA.toUpperCase()];
    for (const route of api.filter((r) => r.url.includes(':id') && !r.url.startsWith('/api/businesses/:id') && r.method !== 'HEAD')) {
      const t = targets[keyOf(route)]!;
      for (const businessId of scopes) {
        const res = await send(route, { id: t.id, businessId, headers: OTHER, body: t.body?.() });
        if (res.statusCode < 400 || res.statusCode >= 500) violations.push(`${keyOf(route)} scope ${JSON.stringify(businessId)}: status ${res.statusCode}`);
        const found = leaked(res);
        if (found.length) violations.push(`${keyOf(route)} scope ${JSON.stringify(businessId)}: leaked ${found.join(', ')}`);
      }
    }
    // The business in the path, in forms that are not exactly an owned ID.
    for (const id of [`${PIZZA}/`, `${PIZZA}%2F..%2F${OTHER_BIZ}`, `${OTHER_BIZ}%2F..%2F${PIZZA}`, '%2e%2e', '*']) {
      const res = await w.app.inject({ url: `/api/businesses/${id}/facts`, headers: OTHER });
      if (res.statusCode < 400 || res.statusCode >= 500) violations.push(`GET /api/businesses/${id}/facts: status ${res.statusCode}`);
      if (leaks.some((s) => res.body.includes(s))) violations.push(`GET /api/businesses/${id}/facts: leaked`);
    }
    expect(violations).toEqual([]);
    await w.settle();
    expect(await victimSnapshot()).toEqual(before);
  });

  // Was DEFECT 7 in the pull request (a NUL byte reached the ownership query and answered 500). Fixed
  // after the merge: the auth guard validates the path ID and the business scope against the contract.
  it('a NUL byte in the business scope is refused with a 4xx, not a 500', async () => {
    const statuses: number[] = [];
    for (const url of [`/api/approvals/${ids.approvalId}?businessId=${PIZZA}%00`, `/api/orders?businessId=${PIZZA}%00`, `/api/businesses/${PIZZA}%00/facts`]) {
      const res = await w.app.inject({ url, headers: OTHER });
      expect(leaks.filter((s) => res.body.includes(s))).toEqual([]);
      statuses.push(res.statusCode);
    }
    expect(statuses.filter((code) => code >= 500)).toEqual([]);
    expect(statuses).toEqual([400, 400, 400]);
  });
  it('a NUL byte in the business scope leaks nothing and changes nothing', async () => {
    const before = await victimSnapshot();
    for (const route of api.filter((r) => r.url.includes(':id') && r.method !== 'HEAD')) {
      const t = targets[keyOf(route)]!;
      const res = route.url.startsWith('/api/businesses/:id')
        ? await send(route, { id: `${PIZZA}\u0000`, headers: OTHER, body: t.body?.() })
        : await send(route, { id: t.id, businessId: `${PIZZA}\u0000`, headers: OTHER, body: t.body?.() });
      expect(res.statusCode, keyOf(route)).toBeGreaterThanOrEqual(400);
      expect(leaked(res), keyOf(route)).toEqual([]);
    }
    await w.settle();
    expect(await victimSnapshot()).toEqual(before);
  });

  it('list routes: 403 for the victim scope, and only own rows in the own scope', async () => {
    const lists = api.filter((r) => r.method === 'GET' && !r.url.includes(':id'));
    expect(lists.map((r) => r.url)).toEqual(expect.arrayContaining(['/api/businesses', '/api/approvals', '/api/orders', '/api/bookings', '/api/calls', '/api/activity', '/api/agents', '/api/telemetry', '/api/live-agent', '/api/integrations/health']));
    const violations: string[] = [];
    for (const route of lists) {
      // Naming the victim business.
      const scoped = await send(route, { businessId: PIZZA, headers: OTHER, query: 'limit=200' });
      // Owner-scoped routes ignore businessId, and a health ping has no scope. Whatever they answer, nothing of the victim may be in it.
      if (scoped.statusCode !== 403 && !['/api/builder/ping'].includes(route.url)) violations.push(`${keyOf(route)} in the victim scope: status ${scoped.statusCode}`);
      if (leaked(scoped).length) violations.push(`${keyOf(route)} in the victim scope: leaked ${leaked(scoped).join(', ')}`);
      // The attacker's own, empty business.
      const own = await send(route, { businessId: OTHER_BIZ, headers: OTHER, query: 'limit=200' });
      if (own.statusCode >= 500) violations.push(`${keyOf(route)} in the own scope: status ${own.statusCode}`);
      if (leaked(own).length) violations.push(`${keyOf(route)} in the own scope: leaked ${leaked(own).join(', ')}`);
      const items = json(own).items;
      if (Array.isArray(items)) for (const item of items as { businessId?: string; id?: string }[]) {
        if ((item.businessId ?? item.id) !== OTHER_BIZ && item.businessId !== OTHER_BIZ) violations.push(`${keyOf(route)} in the own scope: returned a row of ${String(item.businessId ?? item.id)}`);
      }
    }
    expect(violations).toEqual([]);
    // GET /api/businesses is owner-scoped: exactly the attacker's one business.
    const mine = (await w.app.inject({ url: '/api/businesses', headers: OTHER })).json() as { items: { id: string }[] };
    expect(mine.items.map((b) => b.id)).toEqual([OTHER_BIZ]);
  });

  it('the owner sees each business only in its own scope: every listed row carries the scope it was asked for', async () => {
    const lists = ['/api/approvals', '/api/orders', '/api/bookings', '/api/calls', '/api/activity', '/api/agents'];
    for (const [scope, foreign] of [[PIZZA, BARBER], [BARBER, PIZZA]] as const) {
      for (const url of lists) {
        const variants = url === '/api/approvals' ? ['', '&state=PENDING', '&state=APPROVED', '&state=REJECTED'] : [''];
        for (const extra of variants) {
          const res = await w.app.inject({ url: `${url}?businessId=${scope}&limit=200${extra}`, headers: OWNER });
          expect(res.statusCode, `${url} ${scope}${extra}`).toBe(200);
          const items = (res.json() as { items: { businessId: string }[] }).items;
          expect(items.filter((i) => i.businessId !== scope), `${url} ${scope}${extra}`).toEqual([]);
          expect(res.body, `${url} ${scope}`).not.toContain(`"businessId":"${foreign}"`);
        }
      }
    }
    // Sanity: the lists are not empty, so the check above is not vacuous.
    expect(((await w.app.inject({ url: `/api/orders?businessId=${PIZZA}`, headers: OWNER })).json() as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(2);
    expect(((await w.app.inject({ url: `/api/bookings?businessId=${BARBER}`, headers: OWNER })).json() as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(1);
  });

  it('filters and cursors cannot pull rows across businesses', async () => {
    // A filter naming a victim call, order or correlation ID, in the attacker's own scope.
    for (const url of [`/api/orders?businessId=${OTHER_BIZ}&callId=${ids.callId}`, `/api/activity?businessId=${OTHER_BIZ}&correlationId=${ids.callId}`,
      `/api/calls?businessId=${OTHER_BIZ}&agentId=agt_pizza_01`, `/api/activity?businessId=${OTHER_BIZ}&correlationId=${ids.approvalId}`]) {
      const res = await w.app.inject({ url, headers: OTHER });
      expect(res.statusCode, url).toBe(200);
      expect((res.json() as { items: unknown[] }).items, url).toEqual([]);
      expect(leaks.filter((s) => res.body.includes(s)), url).toEqual([]);
    }
    // The same owner, barbershop scope, pizza call: still nothing.
    expect(((await w.app.inject({ url: `/api/orders?businessId=${BARBER}&callId=${ids.callId}`, headers: OWNER })).json() as { items: unknown[] }).items).toEqual([]);
    // A cursor taken from the victim's list is refused in another scope.
    const page = (await w.app.inject({ url: `/api/activity?businessId=${PIZZA}&limit=1`, headers: OWNER })).json() as { nextCursor?: string };
    expect(page.nextCursor).toBeTypeOf('string');
    for (const [headers, scope] of [[OTHER, OTHER_BIZ], [OWNER, BARBER]] as const) {
      const res = await w.app.inject({ url: `/api/activity?businessId=${scope}&limit=1&cursor=${page.nextCursor}`, headers });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(res.body).not.toContain(ids.callId);
    }
    // A forged cursor is refused too.
    const forged = Buffer.from(JSON.stringify({ id: 'evt_0', time: '2030-01-01T00:00:00.000Z', scope: 'x' })).toString('base64url');
    expect((await w.app.inject({ url: `/api/activity?businessId=${OTHER_BIZ}&cursor=${forged}`, headers: OTHER })).statusCode).toBe(400);
  });

  it('the live agent cannot be read or taken over by another owner', async () => {
    const before = await victimSnapshot();
    const read = await w.app.inject({ url: '/api/live-agent', headers: OTHER });
    expect(read.body).not.toContain('agt_pizza_01');
    expect(read.body).not.toContain(PIZZA);
    for (const agentId of ['agt_pizza_01', 'agt_barber_01']) {
      const res = await w.app.inject({ method: 'PUT', url: '/api/live-agent', headers: OTHER, payload: { agentId } });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'NOT_FOUND' });
      // Naming the victim business as the scope does not help.
      expect((await w.app.inject({ method: 'PUT', url: `/api/live-agent?businessId=${PIZZA}`, headers: OTHER, payload: { agentId } })).statusCode).toBe(403);
    }
    expect(await victimSnapshot()).toEqual(before);
  });

  it('after all of it: the pending approval is still pending and no external write happened', async () => {
    expect(await statusOf(w, 'approval_requests', ids.approvalId)).toBe('PENDING');
    expect(await statusOf(w, 'approval_requests', ids.bookingApprovalId)).toBe('PENDING');
    expect(await statusOf(w, 'orders', ids.orderId)).toBe('AWAITING_OWNER_APPROVAL');
    // Exactly the one approved order of the setup: one link, one message.
    expect(delta(w, NONE)).toEqual({ square: 1, messages: 1, calendar: 0, sheets: 0 });
  });
});

describe('authentication', () => {
  // An unsigned JWT that names the real owner. A verifier that trusted it would be the bug.
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const ALG_NONE = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: OWNER_AUTH, aud: 'authenticated', role: 'authenticated', exp: 4102444800 })}.`;
  /** Routes that answer without a token today. Each is listed in the pull request under "Defects found". */
  const OPEN_ROUTES = ['GET /api/builder/ping', 'HEAD /api/builder/ping'];

  async function unauthenticated(route: Route, headers: Record<string, string>, query?: string): Promise<string[]> {
    const t = targets[keyOf(route)];
    const res = await send(route, { id: t?.id ?? 'x', businessId: t?.business ?? PIZZA, headers, body: t?.body?.(), ...(t?.multipart ? { multipart: true } : {}), ...(query ? { query } : {}) });
    const problems: string[] = [];
    if (res.statusCode !== 401) problems.push(`${keyOf(route)}: status ${res.statusCode}`);
    else if (route.method !== 'HEAD' && json(res).code !== 'UNAUTHENTICATED') problems.push(`${keyOf(route)}: code ${String(json(res).code)}`);
    const found = leaked(res);
    if (found.length) problems.push(`${keyOf(route)}: leaked ${found.join(', ')}`);
    return problems;
  }

  it.each([
    ['no Authorization header', {}],
    ['an empty Authorization header', { authorization: '' }],
    ['the scheme with no token', { authorization: 'Bearer' }],
    ['the scheme and a space', { authorization: 'Bearer ' }],
    ['a token that is not a JWT', { authorization: 'Bearer not-a-token' }],
    ['a valid token with a suffix', { authorization: 'Bearer owner.x' }],
    ['a valid token in the wrong case', { authorization: 'Bearer OWNER' }],
    ['two tokens', { authorization: 'Bearer nope owner' }],
    ['a valid token with no scheme', { authorization: 'owner' }],
    ['Basic auth with the token as the user', { authorization: `Basic ${Buffer.from('owner:').toString('base64')}` }],
    ['an unsigned JWT naming the owner', { authorization: `Bearer ${ALG_NONE}` }],
    ['the auth user ID as the token', { authorization: `Bearer ${OWNER_AUTH}` }],
    ['the token in a cookie', { cookie: 'access_token=owner; sb-access-token=owner' }],
    ['the token in another header', { 'x-access-token': 'owner', 'x-forwarded-user': 'usr_owner_01', 'x-owner-user-id': 'usr_owner_01' }],
  ] as const)('%s: 401 UNAUTHENTICATED on every registered /api route', async (_name, headers) => {
    const before = await victimSnapshot();
    const problems: string[] = [];
    for (const route of api.filter((r) => !OPEN_ROUTES.includes(keyOf(r)))) problems.push(...await unauthenticated(route, { ...headers }));
    expect(problems).toEqual([]);
    await w.settle();
    expect(await victimSnapshot()).toEqual(before);
  });

  it('a token in the query string is not a credential: 401 on every registered /api route', async () => {
    const problems: string[] = [];
    for (const route of api.filter((r) => !OPEN_ROUTES.includes(keyOf(r)))) problems.push(...await unauthenticated(route, {}, 'access_token=owner&token=owner&authorization=Bearer%20owner'));
    expect(problems).toEqual([]);
  });

  // DEFECT (see the pull request): the builder plugin registers GET /api/builder/ping with no auth
  // check, and the global guard skips routes whose policy is `builder`. It answers 200 to anyone.
  it.fails('GET /api/builder/ping without a token returns 401 like every other /api route', async () => {
    const res = await w.app.inject({ url: '/api/builder/ping' });
    expect(res.statusCode).toBe(401);
  });
  it('the route that answers without a token returns nothing about any business', async () => {
    const res = await w.app.inject({ url: '/api/builder/ping' });
    expect(res.json()).toEqual({ ok: true, lane: 'builder' });
    expect(leaks.filter((s) => res.body.includes(s))).toEqual([]);
  });

  it('an unregistered /api path and an unknown method are refused without a token and never reach a handler', async () => {
    for (const [method, url] of [['GET', '/api/secrets'], ['GET', '/api/approvals/x/decision'], ['DELETE', `/api/approvals/${ids.approvalId}?businessId=${PIZZA}`], ['DELETE', `/api/businesses/${PIZZA}`],
      ['POST', `/api/orders/${ids.orderId}/pay?businessId=${PIZZA}`], ['PUT', `/api/approvals/${ids.approvalId}?businessId=${PIZZA}`], ['GET', '/api/../api/approvals'], ['GET', '/API/approvals']] as const) {
      const res = await w.app.inject({ method, url });
      expect([401, 404, 405], `${method} ${url}`).toContain(res.statusCode);
      // A 404 may repeat the path that was asked for. Nothing else of the victim may be in it.
      expect(leaks.filter((s) => res.body.includes(s) && !url.includes(s)), `${method} ${url}`).toEqual([]);
    }
    expect(await statusOf(w, 'approval_requests', ids.approvalId)).toBe('PENDING');
  });

  it('a 401 never says whether the resource exists: the body is the same for a real ID and a made-up one', async () => {
    const real = await w.app.inject({ url: `/api/approvals/${ids.approvalId}?businessId=${PIZZA}` });
    const fake = await w.app.inject({ url: `/api/approvals/apv_does_not_exist?businessId=biz_nobody` });
    const strip = (body: string) => ({ ...(JSON.parse(body) as Record<string, unknown>), correlationId: '' });
    expect(strip(real.body)).toEqual(strip(fake.body));
    expect(real.headers['x-correlation-id']).toBeTypeOf('string');
  });
});

describe('authentication with a verifier that knows more token states', () => {
  // The world's verifier knows two tokens. This one adds what a real one can report: an expired
  // token (jose's JWTExpired), a bad signature, a token of a user with no owner profile, and an outage.
  const STRANGER_AUTH = '00000000-0000-4000-8000-0000000000aa';
  const verifier: TokenVerifier = {
    async verify(token) {
      if (token === 'owner') return { authUserId: OWNER_AUTH };
      if (token === 'other') return { authUserId: OTHER_AUTH };
      if (token === 'stranger') return { authUserId: STRANGER_AUTH };
      if (token === 'expired') throw Object.assign(new Error('"exp" claim timestamp check failed'), { name: 'JWTExpired', code: 'ERR_JWT_EXPIRED', claim: 'exp', payload: { sub: OWNER_AUTH } });
      if (token === 'forged') throw Object.assign(new Error('signature verification failed'), { name: 'JWSSignatureVerificationFailed', code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' });
      if (token === 'crash') throw new TypeError(`cannot read token for ${OWNER_AUTH}`);
      throw new Error('Invalid token');
    },
  };
  let x: World;
  beforeAll(async () => { x = await createWorld({ verifier }, VOICE_ENV); await x.app.ready(); }, 120_000);
  afterAll(async () => { await x?.close(); });

  it.each(['expired', 'forged', 'stranger', 'crash'])('a token that is %s: 401 UNAUTHENTICATED on every registered /api route, with no detail from the verifier', async (token) => {
    const problems: string[] = [];
    for (const route of x.app.routeInventory().filter((r) => r.url.startsWith('/api/') && r.url !== '/api/builder/ping')) {
      const hasBody = !['GET', 'HEAD'].includes(route.method);
      const path = route.url.replace(':id', route.url.startsWith('/api/businesses/:id') ? PIZZA : 'agt_pizza_01');
      const res = await x.app.inject({ method: route.method as 'GET', url: `${path}?businessId=${PIZZA}`, headers: { authorization: `Bearer ${token}` }, ...(hasBody ? { payload: {} } : {}) });
      if (res.statusCode !== 401) problems.push(`${route.method} ${route.url}: status ${res.statusCode}`);
      for (const s of [OWNER_AUTH, STRANGER_AUTH, 'exp', 'JWT', 'signature', 'cannot read', 'Demo Pizza']) if (res.body.includes(s)) problems.push(`${route.method} ${route.url}: body contains ${s}`);
    }
    expect(problems).toEqual([]);
    expect(await count(x, 'calls')).toBe(0);
    expect(counts(x)).toEqual(NONE);
  });

  it('the same routes answer the real owner, so the 401s above are not a dead server', async () => {
    expect((await x.app.inject({ url: `/api/approvals?businessId=${PIZZA}`, headers: OWNER })).statusCode).toBe(200);
    expect((await x.app.inject({ url: `/api/agents?businessId=${PIZZA}`, headers: OWNER })).statusCode).toBe(200);
  });
});
