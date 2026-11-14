// Issue #93 "smaller": repeats were made safe by memory held in one process. A repeat of a proposal
// was remembered by operation ID in a Map (compose/ports.ts), and a repeat of a decision by
// Idempotency-Key in a Map (api/routes.ts). Both are empty after a restart. These tests run the repeat
// on a second server composed on the same database, which shares no memory with the first.
//
// What the database gives, with no new migration:
// - an order proposal is unique per business, call and cart (orders constraint, migration 0002), and
//   the engine looks the pending one up before it creates one;
// - a booking proposal is unique per business, call, service and start
//   (bookings_one_proposal_per_call_slot, 0002), but the engine did not look it up: a repeat hit the
//   constraint and was refused. It now returns the stored proposal, as an order repeat does;
// - a decision is recorded once by private.decide_and_enqueue, and an identical repeat changes nothing.
// What a restart still loses is pinned in the last test and written in API.md section 1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Cart, Quote, ToolResult } from '@abos/contracts';
import { buildApp } from '../../src/app';
import { parseEnv } from '../../src/env';
import { CALENDAR_ID, OWNER, PHONE, PUBLIC_URL, createWorld, nextLocalDate, verifier, zonedIso, type World } from './world';

const PIZZA = 'biz_pizza_01';
const BARBER = 'biz_barber_01';
const TZ = 'America/Los_Angeles';
const CART: Cart = { lines: [{ catalogItemId: 'SQ_ITEM_PEP', variationId: 'SQ_VAR_PEP_LG', quantity: 1, modifierIds: [] }] };

let w: World;
const restarted: FastifyInstance[] = [];
beforeAll(async () => { w = await createWorld(); }, 120_000);
afterAll(async () => { for (const app of restarted) await app.close(); await w?.close(); });

/** A second server on the same database and the same fake providers: a restart, as far as memory goes. */
async function restart() {
  const env = parseEnv({ TWILIO_PHONE_NUMBER: PHONE, MESSAGE_CHANNEL: 'surge', SURGE_API_KEY: 'test-key', SURGE_ACCOUNT_ID: 'test-account', GOOGLE_CALENDAR_ID: CALENDAR_ID, PUBLIC_SERVER_URL: PUBLIC_URL });
  const app = await buildApp(env, { db: w.t.db, verifier, agentModel: w.model, providers: w.app.composed.providers });
  restarted.push(app);
  return app;
}
async function liveCall(businessId: string, agentId: string) {
  const v = (await w.t.db.query('select active_version_id from agents where id = $1', [agentId])).rows[0] as { active_version_id: string };
  const { callId } = await w.app.composed.calls.startSimulatedCall({ businessId, agentId, agentVersionId: v.active_version_id });
  return { callId, agentVersionId: v.active_version_id };
}
const n = async (sql: string, params: unknown[]) => Number(((await w.t.db.query(`select count(*)::int as n from ${sql}`, params)).rows[0] as { n: number }).n);
const getApproval = async (app: FastifyInstance, businessId: string, id: string) => (await app.inject({ url: `/api/approvals/${id}?businessId=${businessId}`, headers: OWNER })).json() as { id: string; state: string; payloadHash: string; decidedAt?: string };

describe('a repeated booking proposal on one call', () => {
  const slot = () => zonedIso(nextLocalDate([3, 4], 3), '14:00', TZ);
  const input = (callId: string, agentVersionId: string, startUtc: string, name = 'Ana', to = '+15555550124') => ({
    businessId: BARBER, callId, agentVersionId, serviceId: 'svc_haircut', serviceName: 'Haircut', calendarId: CALENDAR_ID,
    startUtc, endUtc: new Date(Date.parse(startUtc) + 30 * 60_000).toISOString(), timezone: TZ,
    customer: { name, messageRecipient: to, messageConsent: true }, messageChannel: 'surge' as const });

  it('returns the stored proposal: one booking, one approval, one set of events', async () => {
    const { callId, agentVersionId } = await liveCall(BARBER, 'agt_barber_01');
    const startUtc = slot();
    const first = await w.app.composed.engine.createBookingProposal(input(callId, agentVersionId, startUtc));
    const again = await w.app.composed.engine.createBookingProposal(input(callId, agentVersionId, startUtc));
    expect(again.booking.id).toBe(first.booking.id);
    expect(again.approval.id).toBe(first.approval.id);
    expect(await n('bookings where call_id = $1', [callId])).toBe(1);
    expect(await n('approval_requests where subject_id = $1', [first.booking.id])).toBe(1);
    expect(await n("activity_events where correlation_id = $1 and type in ('proposal.created','approval.requested')", [callId])).toBe(2);
  });

  it('with a changed name or number is refused, and the pending proposal is unchanged', async () => {
    const { callId, agentVersionId } = await liveCall(BARBER, 'agt_barber_01');
    const startUtc = zonedIso(nextLocalDate([3, 4], 3), '14:30', TZ);
    const first = await w.app.composed.engine.createBookingProposal(input(callId, agentVersionId, startUtc));
    await expect(w.app.composed.engine.createBookingProposal(input(callId, agentVersionId, startUtc, 'Ana', '+15555550199'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(w.app.composed.engine.createBookingProposal(input(callId, agentVersionId, startUtc, 'Mallory'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await n('bookings where call_id = $1', [callId])).toBe(1);
    const pending = (await w.t.db.query("select payload from approval_requests where subject_id = $1 and state = 'PENDING'", [first.booking.id])).rows as { payload: { messageRecipient: string } }[];
    expect(pending.map((p) => p.payload.messageRecipient)).toEqual(['+15555550124']);
  });

  it('another slot on the same call, and the same slot on another call, are new proposals', async () => {
    const a = await liveCall(BARBER, 'agt_barber_01');
    const b = await liveCall(BARBER, 'agt_barber_01');
    const startUtc = zonedIso(nextLocalDate([3, 4], 3), '15:00', TZ);
    const other = zonedIso(nextLocalDate([3, 4], 3), '15:30', TZ);
    const first = await w.app.composed.engine.createBookingProposal(input(a.callId, a.agentVersionId, startUtc));
    const moved = await w.app.composed.engine.createBookingProposal(input(a.callId, a.agentVersionId, other));
    const elsewhere = await w.app.composed.engine.createBookingProposal(input(b.callId, b.agentVersionId, startUtc, 'Bo', '+15555550125'));
    expect(new Set([first.approval.id, moved.approval.id, elsewhere.approval.id]).size).toBe(3);
  });

  it('once the first one is approved, the same slot on the same call is refused: no second proposal for a slot being booked', async () => {
    const { callId, agentVersionId } = await liveCall(BARBER, 'agt_barber_01');
    const startUtc = zonedIso(nextLocalDate([3, 4], 4), '11:00', TZ);
    const first = await w.app.composed.engine.createBookingProposal(input(callId, agentVersionId, startUtc));
    const a = await getApproval(w.app, BARBER, first.approval.id);
    const decided = await w.app.inject({ method: 'POST', url: `/api/approvals/${a.id}/decision?businessId=${BARBER}`, headers: OWNER, payload: { decision: 'approve', payloadHash: a.payloadHash } });
    expect(decided.statusCode, decided.body).toBe(200);
    await w.settle();
    await expect(w.app.composed.engine.createBookingProposal(input(callId, agentVersionId, startUtc))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await n('bookings where call_id = $1', [callId])).toBe(1);
  });
});

describe('a repeat after a restart', () => {
  it('a booking proposal: the restarted server returns the proposal the first one stored', async () => {
    const { callId, agentVersionId } = await liveCall(BARBER, 'agt_barber_01');
    const startUtc = zonedIso(nextLocalDate([3, 4], 5), '14:00', TZ);
    const request = { businessId: BARBER, agentVersionId, callId, correlationId: callId, operationId: 'op-restart-booking', signal: new AbortController().signal, serviceId: 'svc_haircut', startUtc,
      customer: { name: 'Ana', messageRecipient: '+15555550124', messageConsent: true }, messageChannel: 'surge' as const };
    const first = await w.app.composed.toolsetPorts.proposals.createBookingProposal(request);
    expect(first).toMatchObject({ ok: true });
    const again = await (await restart()).composed.toolsetPorts.proposals.createBookingProposal(request);
    expect(again).toMatchObject({ ok: true });
    if (!first.ok || !again.ok) throw new Error('proposal failed');
    expect(again.bookingId).toBe(first.bookingId);
    expect(again.approvalId).toBe(first.approvalId);
    expect(await n('bookings where call_id = $1', [callId])).toBe(1);
    expect(await n('approval_requests where subject_id = $1', [first.bookingId])).toBe(1);
  });

  it('an order proposal: the restarted server returns the stored proposal while it is pending, and refuses a second one once it is decided', async () => {
    let quote: Quote | undefined;
    w.model.push(async ({ executeTool }) => { const r = await executeTool('quote_order', { cart: CART }) as ToolResult<'quote_order'>; if (r.ok) quote = r.quote; return 'quoted'; });
    const sim = (await w.app.inject({ method: 'POST', url: `/api/agents/agt_pizza_01/sim-call?businessId=${PIZZA}`, headers: OWNER, payload: { message: 'One large' } })).json() as { callId: string };
    const call = (await w.t.db.query('select agent_version_id from calls where id = $1', [sim.callId])).rows[0] as { agent_version_id: string };
    const request = { businessId: PIZZA, agentVersionId: call.agent_version_id, callId: sim.callId, correlationId: sim.callId, operationId: 'op-restart-order', signal: new AbortController().signal,
      cart: CART, quote: quote!, contact: { name: 'Sam', messageConsent: false }, fulfillment: { type: 'pickup' as const, pickupAt: zonedIso(nextLocalDate([0, 1, 2, 3, 4, 5, 6]), '18:00', TZ) }, messageChannel: 'qr_only' as const };
    const first = await w.app.composed.toolsetPorts.proposals.createOrderProposal(request);
    expect(first).toMatchObject({ ok: true });
    const second = await restart();
    const again = await second.composed.toolsetPorts.proposals.createOrderProposal(request);
    if (!first.ok || !again.ok) throw new Error('proposal failed');
    expect(again).toEqual(first);
    expect(await n('orders where call_id = $1', [sim.callId])).toBe(1);
    expect(await n('approval_requests where subject_id = $1', [first.orderId])).toBe(1);

    // Once the owner has decided, the same cart on the same call cannot become a second order.
    const a = await getApproval(w.app, PIZZA, first.approvalId);
    expect((await w.app.inject({ method: 'POST', url: `/api/approvals/${a.id}/decision?businessId=${PIZZA}`, headers: OWNER, payload: { decision: 'reject', payloadHash: a.payloadHash } })).statusCode).toBe(200);
    // (A new attempt, so a new operation ID: the same ID in the same process only replays its stored result.)
    expect(await second.composed.toolsetPorts.proposals.createOrderProposal({ ...request, operationId: 'op-restart-order-after-decision' })).toMatchObject({ ok: false });
    expect(await (await restart()).composed.toolsetPorts.proposals.createOrderProposal(request)).toMatchObject({ ok: false });
    expect(await n('orders where call_id = $1', [sim.callId])).toBe(1);
    expect(await n('approval_requests where subject_id = $1', [first.orderId])).toBe(1);
  });

  it('a decision sent again with the same Idempotency-Key: the restarted server answers 200 with the same approval and writes nothing twice', async () => {
    const { callId, agentVersionId } = await liveCall(BARBER, 'agt_barber_01');
    const startUtc = zonedIso(nextLocalDate([3, 4], 6), '14:00', TZ);
    const made = await w.app.composed.engine.createBookingProposal({ businessId: BARBER, callId, agentVersionId, serviceId: 'svc_haircut', serviceName: 'Haircut', calendarId: CALENDAR_ID,
      startUtc, endUtc: new Date(Date.parse(startUtc) + 30 * 60_000).toISOString(), timezone: TZ, customer: { name: 'Ana', messageConsent: false }, messageChannel: 'qr_only' });
    const a = await getApproval(w.app, BARBER, made.approval.id);
    const send = (app: FastifyInstance, body: Record<string, unknown>, key = 'key-restart-01') => app.inject({ method: 'POST', url: `/api/approvals/${a.id}/decision?businessId=${BARBER}`, headers: { ...OWNER, 'idempotency-key': key }, payload: body });
    const body = { decision: 'approve', payloadHash: a.payloadHash };
    const calendarBefore = w.calendarWrites.length;
    const first = await send(w.app, body);
    expect(first.statusCode, first.body).toBe(200);
    await w.settle();
    const steps = await n('action_executions where approval_id = $1', [a.id]);
    const events = await n("activity_events where type = 'approval.decided' and payload->>'approvalId' = $1", [a.id]);
    expect(events).toBe(1);

    const second = await restart();
    const repeat = await send(second, body);
    expect(repeat.statusCode, repeat.body).toBe(200);
    expect(repeat.json().approval).toMatchObject({ id: a.id, state: 'APPROVED', decidedAt: first.json().approval.decidedAt });
    await second.composed.executor.idle?.();
    await w.settle();
    expect(await n('action_executions where approval_id = $1', [a.id])).toBe(steps);
    expect(await n("activity_events where type = 'approval.decided' and payload->>'approvalId' = $1", [a.id])).toBe(1);
    // One Calendar event for this booking, whichever server's executor ran the step.
    expect(w.calendarWrites.length - calendarBefore).toBe(1);

    // The limit, stated in API.md section 1: the key is remembered per process. In the process that
    // saw the first request, the same key with another body is a reuse of the key (VALIDATION_FAILED).
    expect((await send(w.app, { decision: 'reject', payloadHash: a.payloadHash })).json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    // After a restart that memory is gone, so a third server judges the request on its own: the other
    // decision for a decided approval is refused by the database, with a different code. Nothing is written.
    const third = await restart();
    expect((await send(third, { decision: 'reject', payloadHash: a.payloadHash })).json()).toMatchObject({ code: 'APPROVAL_ALREADY_DECIDED' });
    expect((await getApproval(w.app, BARBER, a.id)).state).toBe('APPROVED');
    expect(await n("activity_events where type = 'approval.decided' and payload->>'approvalId' = $1", [a.id])).toBe(1);
  });
});
