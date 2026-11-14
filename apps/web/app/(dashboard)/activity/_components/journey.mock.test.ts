/**
 * Drives the scripted mock timelines (FLOWS.md Flow B and C) and checks the
 * journey the screen derives at every event, using the same REST reads the
 * screen makes.
 */
import {describe, expect, it} from 'vitest';
import * as api from '@/lib/api/client';
import {subscribeMockActivity} from '@/lib/api/mock-bridge';
import type {ActivityEvent} from '@/lib/api';
import {getState, mockControls, whenIdle} from '@/mocks/server';
import {useMockServer} from '@/mocks/test-setup';
import {deriveJourney, groupByCall} from './journey';

useMockServer();

const PIZZA = 'biz_pizza_01';
const BARBER = 'biz_barber_01';

async function journeyFor(businessId: string, callId: string) {
  const events = (await api.listActivity(businessId, {correlationId: callId, limit: 200})).items;
  const call = await api.getCall(businessId, callId);
  const order = (await api.listOrders(businessId, {callId})).items[0];
  const booking = order ? undefined : (await api.listBookings(businessId, {})).items.find((b) => b.callId === callId);
  const checkout = order ? await api.getOrderCheckout(businessId, order.id) : undefined;
  return deriveJourney({callId, events, call, order, booking, checkout});
}

describe('pizza call on the mock timeline', () => {
  it('reaches paid verified, and no derived state is paid before payment.verified', async () => {
    // Snapshot the journey as the screen would see it at each event, from the in-memory state.
    const snapshots: {type: string; paid: boolean; headlineTone: string}[] = [];
    const seen: ActivityEvent[] = [];
    const stop = subscribeMockActivity(PIZZA, (event) => {
      seen.push(event);
      const callId = event.correlationId;
      const state = getState();
      const j = deriveJourney({
        callId,
        events: groupByCall([...seen].reverse()).get(callId) ?? [],
        call: state.calls.find((c) => c.id === callId),
        order: state.orders.find((o) => o.callId === callId),
      });
      snapshots.push({type: event.type, paid: j.paidVerified, headlineTone: j.headline.tone});
    });

    const {callId, approvalId} = await mockControls.startPizzaCall();
    const pending = await journeyFor(PIZZA, callId);
    expect(pending.approval).toMatchObject({id: approvalId, state: 'PENDING'});
    expect(pending.activeStep).toBe(2);

    const apv = await api.getApproval(PIZZA, approvalId);
    await api.decideApproval(PIZZA, approvalId, {decision: 'approve', payloadHash: apv.payloadHash});
    await whenIdle();
    stop();

    const firstPaid = snapshots.findIndex((s) => s.paid);
    const verifiedAt = snapshots.findIndex((s) => s.type === 'payment.verified');
    expect(verifiedAt).toBeGreaterThan(-1);
    expect(firstPaid).toBeGreaterThanOrEqual(verifiedAt);
    for (const s of snapshots.slice(0, verifiedAt)) expect(s.headlineTone).not.toBe('success');

    const done = await journeyFor(PIZZA, callId);
    expect(done.paidVerified).toBe(true);
    expect(done.activeStep).toBe(5);
    expect(done.message?.status).toBe('SENT');
    expect(done.sync?.status).toBe('DONE');
    expect(done.finished).toBe(true);
  });

  it('ends in payment failed', async () => {
    mockControls.simulatePaymentFailed();
    const {callId, approvalId} = await mockControls.startPizzaCall();
    const apv = await api.getApproval(PIZZA, approvalId);
    await api.decideApproval(PIZZA, approvalId, {decision: 'approve', payloadHash: apv.payloadHash});
    await whenIdle();
    const j = await journeyFor(PIZZA, callId);
    expect(j.paidVerified).toBe(false);
    expect(j.steps[4].view?.tone).toBe('danger');
    expect(j.notices.map((n) => n.key)).toContain('payment_failed');
  });

  it('shows the Sheets retry with its attempt number', async () => {
    mockControls.simulateSyncRetry();
    const {callId, approvalId} = await mockControls.startPizzaCall();
    const apv = await api.getApproval(PIZZA, approvalId);
    await api.decideApproval(PIZZA, approvalId, {decision: 'approve', payloadHash: apv.payloadHash});
    await whenIdle();
    const events = (await api.listActivity(PIZZA, {correlationId: callId})).items;
    const failedIdx = [...events].reverse().findIndex((e) => e.type === 'sync.failed');
    expect(failedIdx).toBeGreaterThan(-1);
    const upToFailure = [...events].reverse().slice(0, failedIdx + 1).reverse();
    const order = (await api.listOrders(PIZZA, {callId})).items[0];
    const mid = deriveJourney({callId, events: upToFailure, order});
    expect(mid.sync).toEqual({status: 'RETRYING', attempts: 1});
    expect((await journeyFor(PIZZA, callId)).sync?.status).toBe('DONE');
  });

  it('shows a lost call with no order', async () => {
    const {callId} = await mockControls.simulateCallLost();
    await whenIdle();
    const j = await journeyFor(PIZZA, callId);
    expect(j.kind).toBe('call_only');
    expect(j.headline.label).toBe('Call lost');
    expect(j.notices.map((n) => n.key)).toContain('call_lost');
  });
});

describe('booking call on the mock timeline', () => {
  it('reaches booked verified', async () => {
    const {callId, approvalId} = await mockControls.startBookingCall();
    const apv = await api.getApproval(BARBER, approvalId);
    await api.decideApproval(BARBER, approvalId, {decision: 'approve', payloadHash: apv.payloadHash});
    await whenIdle();
    const j = await journeyFor(BARBER, callId);
    expect(j.kind).toBe('booking');
    expect(j.bookedVerified).toBe(true);
    expect(j.steps[4].view?.tone).toBe('success');
  });

  it('ends in a slot conflict with alternatives', async () => {
    const {callId, approvalId} = await mockControls.startBookingCall({slotConflict: true});
    const apv = await api.getApproval(BARBER, approvalId);
    await api.decideApproval(BARBER, approvalId, {decision: 'approve', payloadHash: apv.payloadHash});
    await whenIdle();
    const j = await journeyFor(BARBER, callId);
    expect(j.slotConflict?.alternatives).toHaveLength(3);
    expect(j.bookedVerified).toBe(false);
    expect(j.steps.some((s) => s.view?.tone === 'success')).toBe(false);
  });
});

describe('seeded history', () => {
  it('derives a journey for every seeded call without throwing, and green only where the server confirmed it', async () => {
    for (const businessId of [PIZZA, BARBER]) {
      const calls = (await api.listCalls(businessId, {limit: 200})).items;
      for (const call of calls) {
        const j = await journeyFor(businessId, call.id);
        const green = j.steps.filter((s) => s.view?.tone === 'success').map((s) => s.key);
        // Green only for a verified payment or booking, or a calendar step whose execution succeeded.
        for (const key of green) {
          if (key === 'paid') expect(j.paidVerified).toBe(true);
          else if (key === 'booked') expect(j.bookedVerified).toBe(true);
          else {
            expect(key).toBe('calendar');
            expect(j.executions.find((e) => e.actionType === 'calendar.event.create')?.status).toBe('SUCCEEDED');
          }
        }
      }
    }
  });
});
