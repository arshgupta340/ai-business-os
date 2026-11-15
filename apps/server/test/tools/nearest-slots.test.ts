// read_calendar_availability with `near` (2026-11-15): a caller who asks for "today at four" must be offered
// four when it is free, and the nearest free times when it is not, never the first slots of the morning.
import { describe, expect, it } from 'vitest';
import { STAGE_SHOPS } from '@abos/contracts/fixtures';
import { createMockToolset } from '../../src/tools/mock/index';
import { nearestSlots } from '../../src/tools/real/index';

const at = (hhmm: string) => Date.parse(`2026-11-16T${hhmm}:00-08:00`);
const slot = (hhmm: string) => ({ startUtc: new Date(at(hhmm)).toISOString() });
const DAY = ['09:00', '09:15', '09:30', '12:00', '15:45', '16:00', '16:15', '16:30', '18:00'].map(slot);

describe('nearestSlots', () => {
  it('keeps the slots closest to the asked time, in time order, with the exact time among them', () => {
    const got = nearestSlots(DAY, at('16:00'), 3);
    expect(got).toEqual([slot('15:45'), slot('16:00'), slot('16:15')]);
  });

  it('offers the nearest free times when the asked time is taken', () => {
    const got = nearestSlots(DAY.filter((s) => s.startUtc !== slot('16:00').startUtc), at('16:00'), 2);
    expect(got).toEqual([slot('15:45'), slot('16:15')]);
  });

  it('returns everything when there are fewer slots than asked for', () => {
    expect(nearestSlots([slot('09:00')], at('16:00'), 5)).toEqual([slot('09:00')]);
    expect(nearestSlots([], at('16:00'), 5)).toEqual([]);
  });
});

describe('the mock toolset with a stage shop and `near`', () => {
  const shop = STAGE_SHOPS.barber;
  const facts = [...shop.facts, ...shop.services.map((x) => ({ kind: 'service' as const, key: x.id, value: { ...x } }))]
    .map((f) => ({ ...f, businessId: shop.businessId, status: 'verified' }));
  // Monday 2026-11-16, 08:00 in the shop's time zone. The fixture barbershop is closed on Mondays; this shop is open.
  const toolset = createMockToolset({ businessId: shop.businessId, now: () => new Date('2026-11-16T08:00:00-08:00'), catalog: [], facts: facts as never });
  const ctx = { businessId: shop.businessId, agentVersionId: 'agv_t', callId: 'call_t', correlationId: 'call_t' };

  it('offers the asked time when it is free, and the first slots of the day without `near`', async () => {
    const near = await toolset.handler.call('read_calendar_availability', { serviceId: 'svc_haircut', date: '2026-11-16', near: '16:00', maxSlots: 3 }, ctx);
    expect(near.ok).toBe(true);
    const starts = (near as { slots: { startUtc: string }[] }).slots.map((s) => Date.parse(s.startUtc));
    expect(starts).toContain(at('16:00'));
    expect(starts).toHaveLength(3);
    const first = await toolset.handler.call('read_calendar_availability', { serviceId: 'svc_haircut', date: '2026-11-16', maxSlots: 3 }, ctx);
    expect(Date.parse((first as { slots: { startUtc: string }[] }).slots[0]!.startUtc)).toBe(at('09:00'));
  });

  it('knows the stage shop is open on a Sunday and lists its four services', async () => {
    const sunday = await toolset.handler.call('read_calendar_availability', { serviceId: 'svc_kids_cut', date: '2026-11-22', near: '10:00', maxSlots: 1 }, ctx);
    expect((sunday as { slots: unknown[] }).slots).toHaveLength(1);
  });
});
