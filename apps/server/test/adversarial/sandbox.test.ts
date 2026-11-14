// B-23 group 9 (AGENTS rule 4, AC-19): the server refuses to start with SQUARE_ENVIRONMENT other than
// `sandbox`, refuses payment work if that check is somehow bypassed, and labels payment data sandbox.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENDPOINTS } from '@abos/contracts';
import { createSquareAdapterForTest } from '../../src/adapters/square/testing';
import { SQUARE_SANDBOX_BASE_URL } from '../../src/adapters/square/client';
import { buildApp } from '../../src/app';
import { parseEnv, type Env } from '../../src/env';
import { currentRole } from '../support/db';
import { LOCATION_ID, OWNER, createWorld, fakeSquareClient, verifier, type World } from '../e2e/world';
import { NONE, PIZZA, approve, count, counts, decide, delta, getApproval, order, paymentEvent, pizzaOrder, pizzaToPaymentPending, postSquare, statusOf, steps } from './helpers';

const NOT_SANDBOX = ['production', 'PRODUCTION', 'prod', 'live', 'Sandbox', 'SANDBOX', 'sandbox ', ' sandbox', 'sandbox\n', 'sandbox,production', 'sandbox2', 'true', '0', 'undefined', 'null'];
/** Markers standing for secrets in the environment. A startup error must not print them. */
const SECRETS = { SQUARE_ACCESS_TOKEN: 'MARKER_SQUARE_TOKEN_91ab', OPENAI_API_KEY: 'MARKER_OPENAI_KEY_77cd', TWILIO_AUTH_TOKEN: 'MARKER_TWILIO_TOKEN_52ef', SQUARE_WEBHOOK_SIGNATURE_KEY: 'MARKER_SIGNING_KEY_30aa' };

describe('startup', () => {
  it.each(NOT_SANDBOX)('parseEnv refuses SQUARE_ENVIRONMENT=%j and names the variable, not a secret', (value) => {
    let message = '';
    try { parseEnv({ ...SECRETS, SQUARE_ENVIRONMENT: value }); } catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).toContain('SQUARE_ENVIRONMENT');
    expect(message).toContain('sandbox');
    for (const secret of Object.values(SECRETS)) expect(message).not.toContain(secret);
  });

  it('parseEnv accepts sandbox, and an absent or empty value means sandbox', () => {
    expect(parseEnv({ SQUARE_ENVIRONMENT: 'sandbox' }).SQUARE_ENVIRONMENT).toBe('sandbox');
    expect(parseEnv({}).SQUARE_ENVIRONMENT).toBe('sandbox');
    expect(parseEnv({ SQUARE_ENVIRONMENT: '' }).SQUARE_ENVIRONMENT).toBe('sandbox');
  });

  it('the Square adapter cannot be built for another environment, and the SDK client is pinned to the sandbox host', () => {
    for (const environment of ['production', 'Production', '', undefined]) {
      expect(() => createSquareAdapterForTest(fakeSquareClient().client, { locationId: LOCATION_ID, environment: environment as 'sandbox', now: () => new Date() })).toThrow();
    }
    expect(SQUARE_SANDBOX_BASE_URL).toMatch(/^https:\/\/connect\.squareupsandbox\.com/);
  });

  it.each(['production', 'Sandbox'])('the server process exits with an error before it listens when SQUARE_ENVIRONMENT=%s', async (value) => {
    const root = resolve(import.meta.dirname, '../../../..');
    const entry = resolve(root, 'apps/server/src/index.ts');
    // A minimal environment: no provider key is real, no database URL is set, and the port is never opened.
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', PORT: '0', ...SECRETS, SQUARE_ENVIRONMENT: value };
    const child = spawn(process.execPath, ['--import', 'tsx', entry], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    const code = await new Promise<number | null>((done, fail) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new Error(`the server did not exit. stdout: ${stdout} stderr: ${stderr}`)); }, 45_000);
      child.on('exit', (c) => { clearTimeout(timer); done(c); });
      child.on('error', (e) => { clearTimeout(timer); fail(e); });
    });
    expect(code).toBe(1);
    expect(stderr).toContain('SQUARE_ENVIRONMENT must be "sandbox"');
    expect(stdout).not.toMatch(/listening/i);
    for (const secret of Object.values(SECRETS)) expect(stdout + stderr).not.toContain(secret);
  }, 60_000);
});

describe('with the server running', () => {
  let w: World;
  beforeAll(async () => { w = await createWorld(); }, 120_000);
  afterAll(async () => { await w?.close(); });

  it('runs as abos_app with SQUARE_ENVIRONMENT sandbox', async () => {
    expect(await currentRole(w.t.db)).toBe('abos_app');
    expect(w.app.composed.env.SQUARE_ENVIRONMENT).toBe('sandbox');
  });

  it('a server whose environment check was bypassed still refuses to approve an order: 503 ENVIRONMENT_MISMATCH, zero writes', async () => {
    const before = counts(w);
    const { orderId, approvalId } = await pizzaOrder(w);
    const hash = (await getApproval(w, PIZZA, approvalId)).payloadHash;
    // The same database and the same fake providers, composed with an environment parseEnv would never return.
    const rogueEnv = { ...w.app.composed.env, SQUARE_ENVIRONMENT: 'production' } as unknown as Env;
    const rogue = await buildApp(rogueEnv, { db: w.t.db, verifier, providers: w.app.composed.providers, agentModel: w.model, now: w.clock.now });
    try {
      const res = await rogue.inject({ method: 'POST', url: `/api/approvals/${approvalId}/decision?businessId=${PIZZA}`, headers: OWNER, payload: { decision: 'approve', payloadHash: hash } });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: 'ENVIRONMENT_MISMATCH', retryable: false });
      rogue.composed.executor.kick(PIZZA);
      await rogue.composed.executor.idle?.();
      expect(await statusOf(w, 'approval_requests', approvalId)).toBe('PENDING');
      expect(await statusOf(w, 'orders', orderId)).toBe('AWAITING_OWNER_APPROVAL');
      expect(await steps(w, approvalId)).toEqual([]);
      expect(delta(w, before)).toEqual(NONE);

      // A rejection involves no payment work, so it is still allowed, and it writes nothing.
      const second = await pizzaOrder(w, { recipient: '+15555550151' });
      const secondHash = (await getApproval(w, PIZZA, second.approvalId)).payloadHash;
      const rejected = await rogue.inject({ method: 'POST', url: `/api/approvals/${second.approvalId}/decision?businessId=${PIZZA}`, headers: OWNER, payload: { decision: 'reject', payloadHash: secondHash } });
      expect(rejected.statusCode).toBe(200);
      expect(await statusOf(w, 'orders', second.orderId)).toBe('REJECTED');
      expect(delta(w, before)).toEqual(NONE);
    } finally { await rogue.close(); }
    // The healthy server can still approve the first order.
    expect((await decide(w, PIZZA, approvalId, 'approve', hash)).statusCode).toBe(200);
    await w.settle();
    expect(delta(w, before)).toEqual({ square: 1, messages: 1, calendar: 0, sheets: 0 });
  });

  it('payment data in responses, events, the message and the sheet is labelled sandbox', async () => {
    const before = counts(w);
    const paid = await pizzaToPaymentPending(w, { recipient: '+15555550152' });
    const declined = await pizzaToPaymentPending(w, { recipient: '+15555550153' });
    w.square.addPayment({ id: 'PAY_ADV_SBX_OK', orderId: paid.squareOrderId, amountMinor: paid.totalMinor, status: 'COMPLETED' });
    w.square.addPayment({ id: 'PAY_ADV_SBX_BAD', orderId: declined.squareOrderId, amountMinor: declined.totalMinor, status: 'FAILED' });
    expect((await postSquare(w, paymentEvent('evt_adv_sbx_1', 'PAY_ADV_SBX_OK', paid.squareOrderId))).statusCode).toBe(200);
    expect((await postSquare(w, paymentEvent('evt_adv_sbx_2', 'PAY_ADV_SBX_BAD', declined.squareOrderId))).statusCode).toBe(200);
    expect((await order(w, paid.orderId)).status).toBe('FULFILLMENT_READY');
    expect((await order(w, declined.orderId)).status).toBe('PAYMENT_FAILED');

    // The checkout view, for an order with a link and for one without.
    for (const id of [paid.orderId, declined.orderId]) {
      const checkout = ENDPOINTS.getOrderCheckout.response.parse((await w.app.inject({ url: `/api/orders/${id}/checkout?businessId=${PIZZA}`, headers: OWNER })).json());
      expect(checkout).toMatchObject({ ready: true, environment: 'sandbox' });
    }
    const pending = await pizzaOrder(w, { recipient: '+15555550154' });
    expect((await w.app.inject({ url: `/api/orders/${pending.orderId}/checkout?businessId=${PIZZA}`, headers: OWNER })).json()).toMatchObject({ ready: false, environment: 'sandbox' });
    // Integration health.
    const health = (await w.app.inject({ url: `/api/integrations/health?businessId=${PIZZA}`, headers: OWNER })).json() as { square: { environment: string }; squareEnvironment: string };
    expect(health.square.environment).toBe('sandbox');
    expect(health.squareEnvironment).toBe('sandbox');
    // Every event that carries payment data, as stored and as the API returns it.
    const PAYMENT_EVENTS = ['checkout.created', 'payment.verified', 'payment.failed'];
    const stored = (await w.t.db.query('select type, payload from activity_events where business_id = $1 and type = any($2::text[])', [PIZZA, PAYMENT_EVENTS])).rows as { type: string; payload: { sandbox?: unknown } }[];
    expect(new Set(stored.map((e) => e.type))).toEqual(new Set(PAYMENT_EVENTS));
    for (const e of stored) expect(e.payload.sandbox, e.type).toBe(true);
    const listed = ENDPOINTS.listActivity.response.parse((await w.app.inject({ url: `/api/activity?businessId=${PIZZA}&limit=200&types=${PAYMENT_EVENTS.join(',')}`, headers: OWNER })).json());
    expect(listed.items.length).toBeGreaterThanOrEqual(3);
    for (const e of listed.items.filter((i) => PAYMENT_EVENTS.includes(i.type))) expect((e.payload as { sandbox?: unknown }).sandbox, e.type).toBe(true);
    // The customer message and the reporting row.
    for (const m of w.messages.sent.filter((s) => s.body.includes('pay for your pickup order'))) expect(m.body).toContain('Sandbox test payment');
    expect(w.sheets.appended.find((a) => a.recordId === paid.orderId)!.row).toContain('sandbox');
    // The integration row the seed wrote for Square.
    expect(await count(w, "integrations where provider = 'square' and config->>'environment' <> 'sandbox'")).toBe(0);
    expect(delta(w, before)).toEqual({ square: 2, messages: 2, calendar: 0, sheets: 1 });
    await approve(w, PIZZA, pending.approvalId);
  });
});
