// Issue #54 on migration 0008: the owner's retry or abandon through POST /api/executions/:id/resolve,
// on the in-process Postgres as abos_app, with the real engine, executor and recovery ports, and fake
// providers. Each test counts the external writes it caused.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RECOVERY_MESSAGES } from '../../src/api/recovery/index';
import { BOOKING_PROPERTY_KEY, bookingPropertyValue } from '../../src/adapters/calendar/index';
import { currentRole } from '../support/db';
import { OWNER, OTHER, createWorld, type World } from './world';
import { BARBER, PIZZA, approve, bookingProposal, count, counts, delta, order, pizzaOrder, statusOf, steps, type Booked } from '../adversarial/helpers';

const resolve = (w: World, id: string, action: 'retry' | 'abandon', headers = OWNER, businessId = PIZZA) =>
  w.app.inject({ method: 'POST', url: `/api/executions/${id}/resolve?businessId=${businessId}`, headers, payload: { action } });
const dispatchOf = async (w: World, approvalId: string) =>
  (await w.t.db.query('select status, provider_message_id from message_dispatches where approval_id = $1', [approvalId])).rows as { status: string; provider_message_id: string | null }[];

describe('a message whose delivery is unknown', () => {
  let w: World;
  beforeAll(async () => { w = await createWorld(); }, 120_000);
  afterAll(async () => { await w?.close(); });

  it('runs as abos_app', async () => { expect(await currentRole(w.t.db)).toBe('abos_app'); });

  it('retry is refused with a plain sentence and sends nothing; abandon marks the dispatch and the step FAILED, once', async () => {
    const providers = w.app.composed.providers;
    const original = providers.message;
    const sends: string[] = [];
    providers.message = { channel: original!.channel, send: async (input) => { sends.push(input.idempotencyKey); return { status: 'UNKNOWN', errorCode: 'INTEGRATION_UNAVAILABLE' }; } };
    let ids: { orderId: string; approvalId: string };
    try {
      ids = await pizzaOrder(w);
      await approve(w, PIZZA, ids.approvalId);
      await w.settle();
    } finally { providers.message = original; }
    const message = (await steps(w, ids.approvalId))[1]!;
    expect(message).toMatchObject({ action_type: 'message.checkout.send', status: 'NEEDS_REVIEW' });
    expect(await dispatchOf(w, ids.approvalId)).toEqual([{ status: 'UNKNOWN', provider_message_id: null }]);
    expect(sends).toEqual([message.idempotency_key]);
    const before = counts(w);

    const retry = await resolve(w, message.id, 'retry');
    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toMatchObject({ code: 'INVALID_STATE', message: RECOVERY_MESSAGES.messageNotResent });
    expect((await steps(w, ids.approvalId))[1]!.status).toBe('NEEDS_REVIEW');

    expect((await resolve(w, message.id, 'abandon', OTHER)).statusCode).toBeGreaterThanOrEqual(403);
    const events = await count(w, 'activity_events where business_id = $1', [PIZZA]);
    const abandon = await resolve(w, message.id, 'abandon');
    expect(abandon.statusCode, abandon.body).toBe(200);
    expect(abandon.json().execution).toMatchObject({ id: message.id, status: 'FAILED', idempotencyKey: message.idempotency_key });
    expect(await dispatchOf(w, ids.approvalId)).toEqual([{ status: 'FAILED', provider_message_id: null }]);
    expect(await count(w, 'activity_events where business_id = $1', [PIZZA])).toBe(events + 2);
    expect(await count(w, "activity_events where type = 'message.failed' and actor_type = 'owner' and payload->>'status' = 'FAILED' and payload->>'subjectId' = $1", [ids.orderId])).toBe(1);
    // The identical repeat answers what the first request answered (0008 recovery_decisions) and writes nothing.
    const repeat = await resolve(w, message.id, 'abandon');
    expect(repeat.statusCode, repeat.body).toBe(200);
    expect(repeat.json()).toEqual(abandon.json());
    expect(await count(w, 'activity_events where business_id = $1', [PIZZA])).toBe(events + 2);
    expect(await count(w, 'recovery_decisions where execution_id = $1', [message.id])).toBe(1);
    // The opposite action for the same attempt is refused.
    expect((await resolve(w, message.id, 'retry')).statusCode).toBe(409);
    w.app.composed.executor.kick(PIZZA);
    await w.settle();
    expect(sends).toHaveLength(1);
    expect(delta(w, before)).toEqual({ square: 0, messages: 0, calendar: 0, sheets: 0 });
    expect((await order(w, ids.orderId)).status).toBe('PAYMENT_PENDING');
  });
});

describe('a calendar step whose insert outcome is unknown: the owner retries after a real calendar read', () => {
  // The fake Google Calendar answers the recovery read with the event (found), with nothing (not found),
  // or with an error. Only "not found" requeues; "found" completes through 0005's resolve_execution.
  let w: World;
  beforeAll(async () => { w = await createWorld(); }, 120_000);
  afterAll(async () => { await w?.close(); });

  async function stuckBooking() {
    const events = w.calendar.client.events;
    // The insert is sent and its answer is lost; the adapter's follow-up read finds nothing yet, so the
    // outcome is unknown (SPEC 2.9) and the step goes to review.
    const saved = { insert: events.insert };
    events.insert = async (): Promise<never> => { w.calendarWrites.push('events.insert'); throw Object.assign(new Error('backend error'), { code: 503 }); };
    let booked: Booked;
    try {
      booked = await bookingProposal(w);
      await approve(w, BARBER, booked.approvalId);
      await w.settle();
    } finally { Object.assign(events, saved); }
    const calendarStep = (await steps(w, booked.approvalId))[0]!;
    expect(calendarStep).toMatchObject({ action_type: 'calendar.event.create', status: 'NEEDS_REVIEW', attempts: 1 });
    expect(await statusOf(w, 'bookings', booked.bookingId)).toBe('RETRY_REQUIRED');
    return { ...booked, step: calendarStep };
  }

  it('found: the event under the step key at the approved slot completes the step, with no second insert; a repeat answers the same', async () => {
    const b = await stuckBooking();
    const approved = (await w.t.db.query('select payload_canonical from approval_requests where id = $1', [b.approvalId])).rows[0] as { payload_canonical: string };
    const slot = JSON.parse(approved.payload_canonical) as { startUtc: string; endUtc: string };
    // The insert had landed at Google before the answer was lost.
    w.calendar.events.set(b.step.idempotency_key, { id: b.step.idempotency_key, summary: 'Haircut', description: '', start: { dateTime: slot.startUtc }, end: { dateTime: slot.endUtc },
      transparency: 'opaque', extendedProperties: { private: { [BOOKING_PROPERTY_KEY]: await bookingPropertyValue(b.bookingId) } } });
    const writes = w.calendarWrites.length;
    const res = await resolve(w, b.step.id, 'retry', OWNER, BARBER);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().execution).toMatchObject({ status: 'SUCCEEDED', externalRef: b.step.idempotency_key });
    expect(await statusOf(w, 'bookings', b.bookingId)).toBe('BOOKED_VERIFIED');
    expect(await count(w, "recovery_decisions where execution_id = $1 and provider_read = 'calendar_event_found' and result_status = 'SUCCEEDED'", [b.step.id])).toBe(1);
    const again = await resolve(w, b.step.id, 'retry', OWNER, BARBER);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(res.json());
    expect(w.calendarWrites.length).toBe(writes);
  });

  it('not found: the step is requeued with its key and the next attempt inserts once with that key', async () => {
    const b = await stuckBooking();
    const writes = w.calendarWrites.length;
    const res = await resolve(w, b.step.id, 'retry', OWNER, BARBER);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().execution).toMatchObject({ status: 'QUEUED', attempts: 1, idempotencyKey: b.step.idempotency_key });
    expect(await count(w, "recovery_decisions where execution_id = $1 and provider_read = 'calendar_event_absent' and result_status = 'QUEUED'", [b.step.id])).toBe(1);
    w.app.composed.executor.kick(BARBER);
    await w.settle();
    expect((await steps(w, b.approvalId))[0]).toMatchObject({ status: 'SUCCEEDED', attempts: 2, idempotency_key: b.step.idempotency_key, external_ref: b.step.idempotency_key });
    expect(await statusOf(w, 'bookings', b.bookingId)).toBe('BOOKED_VERIFIED');
    expect(w.calendarWrites.length).toBe(writes + 1);
    expect(w.calendar.events.has(b.step.idempotency_key)).toBe(true);
  });

  it('error: a calendar read that fails is unknown, so retry and abandon are refused and nothing changes', async () => {
    const b = await stuckBooking();
    const events = w.calendar.client.events;
    const get = events.get;
    events.get = async (): Promise<never> => { throw Object.assign(new Error('backend error'), { code: 500 }); };
    try {
      for (const action of ['retry', 'abandon'] as const) {
        const res = await resolve(w, b.step.id, action, OWNER, BARBER);
        expect(res.json()).toMatchObject({ code: 'INVALID_STATE', message: RECOVERY_MESSAGES.outcomeUnknown });
      }
    } finally { events.get = get; }
    expect((await steps(w, b.approvalId))[0]).toMatchObject({ status: 'NEEDS_REVIEW', attempts: 1 });
    expect(await statusOf(w, 'bookings', b.bookingId)).toBe('RETRY_REQUIRED');
    expect(await count(w, 'recovery_decisions where execution_id = $1', [b.step.id])).toBe(0);
  });
});

describe('a checkout whose link may or may not exist', () => {
  let w: World;
  beforeAll(async () => { w = await createWorld(); }, 120_000);
  afterAll(async () => { await w?.close(); });

  it('cannot be retried or abandoned, because no Square read proves absence; the owner cancels the order', async () => {
    w.square.mode.create = 'timeout';
    let ids: { orderId: string; approvalId: string };
    try {
      ids = await pizzaOrder(w);
      await approve(w, PIZZA, ids.approvalId);
      await w.settle();
    } finally { w.square.mode.create = 'ok'; }
    const checkout = (await steps(w, ids.approvalId))[0]!;
    expect(checkout).toMatchObject({ status: 'NEEDS_REVIEW', external_ref: null });
    for (const action of ['retry', 'abandon'] as const) {
      expect((await resolve(w, checkout.id, action)).json()).toMatchObject({ code: 'INVALID_STATE', message: RECOVERY_MESSAGES.outcomeUnknown });
    }
    const writes = w.squareWrites.length;
    const cancelled = await w.app.inject({ method: 'POST', url: `/api/orders/${ids.orderId}/cancel?businessId=${PIZZA}`, headers: OWNER, payload: {} });
    expect(cancelled.statusCode).toBe(200);
    expect((await order(w, ids.orderId)).status).toBe('CANCELLED');
    expect(w.squareWrites.length).toBe(writes);
  });
});
