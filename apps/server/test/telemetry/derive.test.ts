import { describe, expect, it } from 'vitest';
import type { ActivityEvent } from '@abos/contracts';
import { barberBookingTimeline, barberSlotConflictTimeline, pizzaOrderTimeline } from '@abos/contracts/fixtures';
import { DERIVATION_GAPS, deriveApprovalTimes } from '../../src/telemetry/derive';

const eventsOf = (t: { entries: { event: ActivityEvent }[] }) => t.entries.map((e) => e.event);

describe('deriveApprovalTimes', () => {
  it('pizza order timeline: requested at 185 s, decided at 250 s, so 65 s', () => {
    const r = deriveApprovalTimes(eventsOf(pizzaOrderTimeline), pizzaOrderTimeline.businessId);
    expect(r.samples).toHaveLength(1);
    expect(r.samples[0]).toMatchObject({ metric: 'approval_time', ms: 65_000, correlationId: pizzaOrderTimeline.correlationId });
    expect(r).toMatchObject({ expired: 0, pending: 0, unmatched: 0 });
  });

  it('barber booking timeline: requested at 120 s, decided at 180 s, so 60 s', () => {
    const r = deriveApprovalTimes(eventsOf(barberBookingTimeline), barberBookingTimeline.businessId);
    expect(r.samples.map((s) => s.ms)).toEqual([60_000]);
  });

  it('slot conflict timeline: 120 s to 240 s, so 120 s', () => {
    const r = deriveApprovalTimes(eventsOf(barberSlotConflictTimeline), barberSlotConflictTimeline.businessId);
    expect(r.samples.map((s) => s.ms)).toEqual([120_000]);
  });

  it('ignores another business, and works on shuffled input', () => {
    const events = [...eventsOf(pizzaOrderTimeline)].reverse();
    expect(deriveApprovalTimes(events, barberBookingTimeline.businessId).samples).toEqual([]);
    expect(deriveApprovalTimes(events, pizzaOrderTimeline.businessId).samples.map((s) => s.ms)).toEqual([65_000]);
  });

  it('counts a pending request, an expiry and an orphan decision without inventing durations', () => {
    const all = eventsOf(pizzaOrderTimeline);
    const requested = all.find((e) => e.type === 'approval.requested');
    const decided = all.find((e) => e.type === 'approval.decided');
    if (requested === undefined || decided === undefined) throw new Error('fixture changed');
    const biz = pizzaOrderTimeline.businessId;
    expect(deriveApprovalTimes([requested], biz)).toMatchObject({ samples: [], pending: 1 });
    expect(deriveApprovalTimes([decided], biz)).toMatchObject({ samples: [], unmatched: 1 });
    const expired = {
      ...requested,
      id: 'evt_exp',
      type: 'approval.expired',
      occurredAt: '2026-11-14T19:13:05Z',
      payload: { approvalId: requested.payload.approvalId, subjectId: requested.payload.subjectId },
    } as ActivityEvent;
    expect(deriveApprovalTimes([requested, expired], biz)).toMatchObject({ samples: [], expired: 1, pending: 0 });
  });

  it('webhook_delay is not derived: the events carry no provider or receipt time', () => {
    expect(DERIVATION_GAPS.webhook_delay).toMatch(/provider event time/);
    // The pizza timeline has checkout.created and payment.verified, and still yields only approval_time.
    const r = deriveApprovalTimes(eventsOf(pizzaOrderTimeline), pizzaOrderTimeline.businessId);
    expect(new Set(r.samples.map((s) => s.metric))).toEqual(new Set(['approval_time']));
  });
});
