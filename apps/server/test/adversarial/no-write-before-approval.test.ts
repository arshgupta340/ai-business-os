// B-23 group 2 (AGENTS rule 1): a proposal, a rejection and an expiry cause zero external writes.
// The executor, the webhooks and the reconcile poll are all wired and are asked to run after every
// step, so "zero" means they had the chance and did nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APPROVAL_EXPIRY_MS, type ToolResult } from '@abos/contracts';
import { ageApproval, currentRole } from '../support/db';
import { createWorld, nextLocalDate, type World } from '../e2e/world';
import {
  BARBER, CART, NONE, filterCalendarListByProperty, PIZZA, RECIPIENT, VOICE_ENV, bookingProposal, count, counts, decide, delta, getApproval, phoneCall, pickupAt, pizzaOrder, statusOf, steps,
} from './helpers';

let w: World;
beforeAll(async () => { w = await createWorld({}, VOICE_ENV);  filterCalendarListByProperty(w); }, 120_000);
afterAll(async () => { await w?.close(); });

/** Everything that could run a step or verify a payment gets a turn. */
async function runEverything() {
  for (const businessId of [PIZZA, BARBER]) {
    await w.settle();
    w.app.composed.executor.kick(businessId);
    await w.app.composed.webhooks?.reconcileNow();
    await w.app.composed.webhooks?.recoverNow();
    await w.settle();
  }
}

async function noTraceOfWork(approvalId: string) {
  expect(await steps(w, approvalId)).toEqual([]);
  expect(await count(w, 'message_dispatches where approval_id = $1', [approvalId])).toBe(0);
  expect(await count(w, 'sync_jobs where approval_id = $1', [approvalId])).toBe(0);
}

it('runs as abos_app with phone voice composed', async () => {
  expect(await currentRole(w.t.db)).toBe('abos_app');
  expect(w.app.composed.voice.ok).toBe(true);
});

describe('proposals', () => {
  it('an order proposed through the phone toolset: PENDING approval, zero external writes', async () => {
    const before = counts(w);
    const phone = await phoneCall(w, PIZZA, 'CA_adv_order_1');
    try {
      const quoted = await phone.call('quote_order', { cart: CART }) as ToolResult<'quote_order'>;
      if (!quoted.ok) throw new Error(`quote failed: ${quoted.reason}`);
      const input = { cart: CART, quoteId: quoted.quote.quoteId, fulfillment: { type: 'pickup', pickupAt: pickupAt() },
        contact: { name: 'Sam', messageRecipient: RECIPIENT, messageConsent: true, consentAt: new Date().toISOString() } };
      // Since B-15 the deployed toolset proposes qr_only and stores the proposal on the first call
      // (no read-back step). Adapted after the merge; the suite was written against the read-back.
      const proposed = await phone.call('propose_order', input) as { ok: true; proposalId: string; approvalId: string };
      expect(proposed).toMatchObject({ ok: true, missingFields: [] });
      await runEverything();
      expect(await statusOf(w, 'orders', proposed.proposalId)).toBe('AWAITING_OWNER_APPROVAL');
      expect(await getApproval(w, PIZZA, proposed.approvalId)).toMatchObject({ state: 'PENDING', actorType: 'deployed_agent', bundleType: 'order_bundle' });
      expect((await w.t.db.query('select channel, status from calls where id = $1', [phone.callId])).rows).toEqual([{ channel: 'phone', status: 'IN_PROGRESS' }]);
      await noTraceOfWork(proposed.approvalId);
      // Proposing again, or asking for the status, still writes nothing.
      expect(await phone.call('propose_order', input)).toMatchObject({ ok: false });
      expect(await phone.call('get_order_status', { orderId: proposed.proposalId })).toMatchObject({ ok: true, status: 'AWAITING_OWNER_APPROVAL', paid: false, checkoutLinkSent: false });
      await runEverything();
      expect(await count(w, 'approval_requests where subject_id = $1', [proposed.proposalId])).toBe(1);
      expect(delta(w, before)).toEqual(NONE);
    } finally { phone.toolset.dispose(); }
  });

  it('a booking proposed through the phone toolset: PENDING approval, zero external writes', async () => {
    const before = counts(w);
    const phone = await phoneCall(w, BARBER, 'CA_adv_booking_1');
    try {
      const slots = await phone.call('read_calendar_availability', { serviceId: 'svc_haircut', date: nextLocalDate([3, 4], 4) }) as ToolResult<'read_calendar_availability'>;
      if (!slots.ok) throw new Error(`no slots: ${slots.reason}`);
      const input = { serviceId: 'svc_haircut', startUtc: slots.slots[0]!.startUtc, customer: { name: 'Ana', messageRecipient: '+15555550124', messageConsent: true } };
      // Since B-15 the toolset stores the proposal (qr_only) on the first call; adapted after the merge.
      const proposed = await phone.call('propose_booking', input) as { ok: true; proposalId: string; approvalId: string };
      expect(proposed).toMatchObject({ ok: true, missingFields: [] });
      await runEverything();
      expect(await statusOf(w, 'bookings', proposed.proposalId)).toBe('AWAITING_OWNER_APPROVAL');
      expect(await statusOf(w, 'approval_requests', proposed.approvalId)).toBe('PENDING');
      await noTraceOfWork(proposed.approvalId);
      expect(delta(w, before)).toEqual(NONE);
      const hash = (await getApproval(w, BARBER, proposed.approvalId)).payloadHash;
      expect((await decide(w, BARBER, proposed.approvalId, 'reject', hash)).statusCode).toBe(200);
    } finally { phone.toolset.dispose(); }
  });

  it('an order and a booking proposed through the simulated call: zero external writes, with or without consent', async () => {
    const before = counts(w);
    const withConsent = await pizzaOrder(w);
    const declined = await pizzaOrder(w, { consent: false });
    const booking = await bookingProposal(w, { minDays: 5 });
    await runEverything();
    for (const p of [withConsent, declined]) {
      expect(await statusOf(w, 'orders', p.orderId)).toBe('AWAITING_OWNER_APPROVAL');
      expect(await statusOf(w, 'approval_requests', p.approvalId)).toBe('PENDING');
      await noTraceOfWork(p.approvalId);
    }
    expect(await statusOf(w, 'bookings', booking.bookingId)).toBe('AWAITING_OWNER_APPROVAL');
    await noTraceOfWork(booking.approvalId);
    expect(w.square.orders.size).toBe(0);
    expect(w.calendar.events.size).toBe(0);
    expect(delta(w, before)).toEqual(NONE);
    expect((await decide(w, BARBER, booking.approvalId, 'reject', (await getApproval(w, BARBER, booking.approvalId)).payloadHash)).statusCode).toBe(200);
  });
});

describe('rejecting', () => {
  it('a rejected order and a rejected booking: zero external writes, no steps, terminal state', async () => {
    const before = counts(w);
    const o = await pizzaOrder(w);
    const b = await bookingProposal(w, { minDays: 6 });
    expect((await decide(w, PIZZA, o.approvalId, 'reject', (await getApproval(w, PIZZA, o.approvalId)).payloadHash)).statusCode).toBe(200);
    expect((await decide(w, BARBER, b.approvalId, 'reject', (await getApproval(w, BARBER, b.approvalId)).payloadHash)).statusCode).toBe(200);
    await runEverything();
    expect(await statusOf(w, 'orders', o.orderId)).toBe('REJECTED');
    expect(await statusOf(w, 'bookings', b.bookingId)).toBe('REJECTED');
    await noTraceOfWork(o.approvalId);
    await noTraceOfWork(b.approvalId);
    expect(delta(w, before)).toEqual(NONE);
  });
});

describe('expiry', () => {
  it('an expired order and an expired booking: zero external writes, before and after the sweep', async () => {
    const before = counts(w);
    const o = await pizzaOrder(w);
    const b = await bookingProposal(w, { minDays: 7 });
    await ageApproval(w.t, o.approvalId, APPROVAL_EXPIRY_MS + 1000);
    await ageApproval(w.t, b.approvalId, APPROVAL_EXPIRY_MS + 1000);
    // Past due, not swept: still nothing runs.
    await runEverything();
    expect(delta(w, before)).toEqual(NONE);
    const expired = await w.app.composed.engine.expireDue();
    expect(expired.map((e) => e.id).sort()).toEqual([o.approvalId, b.approvalId].sort());
    await runEverything();
    expect(await statusOf(w, 'approval_requests', o.approvalId)).toBe('EXPIRED');
    expect(await statusOf(w, 'approval_requests', b.approvalId)).toBe('EXPIRED');
    expect(await statusOf(w, 'orders', o.orderId)).toBe('APPROVAL_EXPIRED');
    expect(await statusOf(w, 'bookings', b.bookingId)).toBe('EXPIRED');
    await noTraceOfWork(o.approvalId);
    await noTraceOfWork(b.approvalId);
    // A second sweep finds nothing, and writes no second event.
    expect(await w.app.composed.engine.expireDue()).toEqual([]);
    expect(await count(w, "activity_events where type = 'approval.expired' and payload->>'approvalId' = any($1::text[])", [[o.approvalId, b.approvalId]])).toBe(2);
    expect(delta(w, before)).toEqual(NONE);
  });
});
