// Review finding 9: routine status events are normalized with at most two subject queries per page,
// and the lookup stays inside each event's own business.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeActivity } from '../../src/api/routes';
import type { Db } from '../../src/db/index';
import { createHarness } from './harness';

let h: Awaited<ReturnType<typeof createHarness>>;
beforeAll(async () => { h = await createHarness(); }, 60_000);
afterAll(async () => { await h?.close(); });

function counting(db: Db) {
  let n = 0;
  const wrapped: Db = { query: (text, params) => { n++; return db.query(text, params); }, transaction: db.transaction };
  return { db: wrapped, count: () => n };
}

describe('normalizeActivity', () => {
  it('fills orderId, bookingId and callId for a 200-event page with at most two queries', async () => {
    const items: Record<string, unknown>[] = [];
    for (let i = 0; i < 200; i++) {
      const owner = i % 2 === 0 ? 'a' : 'b';
      const n = (i % 3) + 1;
      const order = i % 4 < 2;
      items.push({ id: `evt_n${i}`, businessId: `biz_${owner}`, type: order ? 'order.status_changed' : 'booking.status_changed', correlationId: 'apv_x', actorType: 'system', occurredAt: '2026-11-13T12:00:00.000Z',
        payload: { subjectId: order ? `ord_${owner}${n}` : `bkg_${owner}${n}`, from: 'AWAITING_OWNER_APPROVAL', to: order ? 'APPROVED' : 'RECHECKING_SLOT' } });
    }
    // Cross-business: an event of biz_a naming a subject of biz_b gets no callId from it.
    items.push({ id: 'evt_cross', businessId: 'biz_a', type: 'order.status_changed', correlationId: 'apv_x', actorType: 'system', occurredAt: '2026-11-13T12:00:00.000Z',
      payload: { subjectId: 'ord_b1', from: 'AWAITING_OWNER_APPROVAL', to: 'APPROVED' } });
    items.push({ id: 'evt_other', businessId: 'biz_a', type: 'call.started', correlationId: 'call_a1', actorType: 'system', occurredAt: '2026-11-13T12:00:00.000Z', payload: { callId: 'call_a1' } });
    const c = counting(h.db);
    const out = await normalizeActivity(c.db, items);
    expect(c.count()).toBeLessThanOrEqual(2);
    expect(out).toHaveLength(items.length);
    const first = out[0]!.payload as Record<string, unknown>;
    expect(first).toEqual({ orderId: 'ord_a1', callId: 'call_a1', from: 'AWAITING_OWNER_APPROVAL', to: 'APPROVED' });
    const booking = out.find((e) => e.type === 'booking.status_changed' && e.businessId === 'biz_b')!.payload as Record<string, unknown>;
    expect(booking.bookingId).toMatch(/^bkg_b/);
    expect(booking).not.toHaveProperty('subjectId');
    expect(out.find((e) => e.id === 'evt_cross')!.payload).toEqual({ orderId: 'ord_b1', from: 'AWAITING_OWNER_APPROVAL', to: 'APPROVED' });
    expect(out.at(-1)).toEqual(items.at(-1));
  });

  it('makes no query when nothing needs normalizing', async () => {
    const c = counting(h.db);
    await normalizeActivity(c.db, [{ id: 'evt_x', businessId: 'biz_a', type: 'call.started', payload: { callId: 'call_a1' } }]);
    expect(c.count()).toBe(0);
  });
});
