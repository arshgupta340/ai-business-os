import { describe, expect, it } from 'vitest';
import { materializeFixtures } from '@abos/contracts/fixtures';
import { BARBER_BUSINESS_ID, type ToolContext } from '@abos/contracts';
import { createMockToolset } from './index';

describe('materialized mock calendar', () => {
  it.each(['2026-11-15T07:59:00Z', '2026-11-15T20:00:00Z', '2027-03-14T09:59:00Z', '2026-11-01T09:01:00Z'])(
    'uses the shifted busy blocks at %s', async (iso) => {
      const now = new Date(iso);
      const W = await materializeFixtures(now);
      const mock = createMockToolset({ businessId: BARBER_BUSINESS_ID, now: () => now });
      const ctx: ToolContext = { businessId: BARBER_BUSINESS_ID, agentVersionId: W.barberVersionV1.id, correlationId: 'materialized-calendar' };
      const available = await mock.handler.call('read_calendar_availability', { serviceId: W.serviceHaircut.id, date: W.BOOKING_DEMO_DATE }, ctx);
      expect(available.ok).toBe(true);
      if (!available.ok) throw new Error(available.reason);
      expect(available.slots.length).toBeGreaterThan(0);
      for (const slot of available.slots) {
        expect(W.barberBusyBlocks.some((b) => Date.parse(b.startUtc) < Date.parse(slot.endUtc) + 300000 && Date.parse(b.endUtc) > Date.parse(slot.startUtc))).toBe(false);
      }
      for (const b of W.bookings.filter((x) => x.status === 'BOOKED_VERIFIED')) {
        const proposal = await mock.handler.call('propose_booking', { serviceId: b.serviceId, startUtc: b.startUtc, customer: b.customer }, ctx);
        expect(proposal).toMatchObject({ ok: false, reason: 'SLOT_CONFLICT' });
      }
      const free = available.slots[0];
      if (free === undefined) throw new Error('No free slot');
      expect(await mock.handler.call('propose_booking', { serviceId: free.serviceId, startUtc: free.startUtc, customer: { name: 'Demo', messageConsent: false } }, ctx)).toMatchObject({ ok: true, missingFields: [] });
    },
  );
});
