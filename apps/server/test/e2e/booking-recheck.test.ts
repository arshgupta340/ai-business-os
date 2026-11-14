// Review findings 3 and 4: the booking proposal rechecks exactly the requested slot, fetches
// alternatives only on a conflict, and reads service, hours and notice from the call's pinned facts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENDPOINTS, type ToolResult } from '@abos/contracts';
import { READBACK_MIN_MS } from '../../src/tools/real/index';
import { OWNER, createWorld, nextLocalDate, zonedIso, type World } from './world';

const BARBER = 'biz_barber_01';
const TZ = 'America/Los_Angeles';
type Proposal = { ok: boolean; reason?: string; proposalId?: string; approvalId?: string; alternatives?: { startUtc: string }[] };

let w: World;
beforeAll(async () => { w = await createWorld(); }, 120_000);
afterAll(async () => { await w?.close(); });

async function sim(body: Record<string, unknown>) {
  const res = await w.app.inject({ method: 'POST', url: `/api/agents/agt_barber_01/sim-call?businessId=${BARBER}`, headers: OWNER, payload: body });
  return res.json() as { callId: string; reply: string };
}
/** propose_booking with the recipient read-back (same number again three seconds later). */
const proposeTurn = (startUtc: string, out: { r?: Proposal }) => async ({ executeTool }: { executeTool: (name: string, input: unknown) => Promise<unknown> }) => {
  const input = { serviceId: 'svc_haircut', startUtc, customer: { name: 'Ana', messageRecipient: '+15555550124', messageConsent: true } };
  const first = await executeTool('propose_booking', input) as Proposal & { missingFields?: string[] };
  if (!first.missingFields) { out.r = first; return 'done'; }
  w.clock.advance(READBACK_MIN_MS + 100);
  out.r = await executeTool('propose_booking', input) as Proposal;
  return 'done';
};

describe('exact-slot recheck', () => {
  it('an afternoon slot outside the first five offered starts is free and is proposed', async () => {
    const date = nextLocalDate([3, 4], 2); // Wednesday or Thursday, 09:00 to 18:00
    const start = zonedIso(date, '15:00', TZ);
    const out: { r?: Proposal } = {};
    const before = w.calendar.queries.length;
    w.model.push(proposeTurn(start, out));
    await sim({ message: 'A haircut at three please', end: true });
    expect(out.r).toMatchObject({ ok: true });
    // One free/busy read for the exact check; no alternatives fetched when the slot is free.
    expect(w.calendar.queries.length - before).toBe(1);
    const booking = (await w.t.db.query('select start_utc, end_utc from bookings where id = $1', [out.r!.proposalId])).rows[0] as { start_utc: Date; end_utc: Date };
    expect(booking.start_utc.toISOString()).toBe(start);
    expect(w.calendarWrites).toEqual([]);
  });

  it('a taken slot is a SLOT_CONFLICT, with at most three free alternatives fetched only then', async () => {
    const date = nextLocalDate([3, 4], 2);
    const start = zonedIso(date, '16:00', TZ);
    w.calendar.busy.push({ start, end: new Date(Date.parse(start) + 30 * 60_000).toISOString() });
    try {
      const out: { r?: Proposal } = {};
      const before = w.calendar.queries.length;
      w.model.push(proposeTurn(start, out));
      await sim({ message: 'A haircut at four please', end: true });
      expect(out.r).toMatchObject({ ok: false, reason: 'SLOT_CONFLICT' });
      expect(out.r!.alternatives!.length).toBeGreaterThan(0);
      expect(out.r!.alternatives!.length).toBeLessThanOrEqual(3);
      expect(out.r!.alternatives!.some((a) => a.startUtc === start)).toBe(false);
      expect(w.calendar.queries.length - before).toBe(2);
    } finally { w.calendar.busy.length = 0; }
  });

  it('a start off the grid or outside the hours is refused without a provider call', async () => {
    const date = nextLocalDate([3, 4], 2);
    for (const hhmm of ['15:07', '20:00']) {
      const out: { r?: Proposal } = {};
      const before = w.calendar.queries.length;
      w.model.push(proposeTurn(zonedIso(date, hhmm, TZ), out));
      await sim({ message: 'An odd time', end: true });
      expect(out.r).toMatchObject({ ok: false });
      expect(w.calendar.queries.length - before).toBe(0);
    }
  });
});

describe('booking ports read the call snapshot', () => {
  it('a mid-call service edit does not change the call in progress; the next call uses it', async () => {
    const date = nextLocalDate([3, 4], 2);
    // The call starts and pins its facts with its first tool call.
    w.model.push(async ({ executeTool }) => {
      const r = await executeTool('read_calendar_availability', { serviceId: 'svc_haircut', date }) as ToolResult<'read_calendar_availability'>;
      return r.ok ? String(Date.parse(r.slots[0]!.endUtc) - Date.parse(r.slots[0]!.startUtc)) : 'failed';
    });
    const callA = await sim({ message: 'Haircut availability?' });
    expect(Number(callA.reply)).toBe(30 * 60_000);

    // The owner makes a haircut 60 minutes, confirmed through the approval flow.
    const proposed = await w.app.inject({ method: 'POST', url: `/api/businesses/${BARBER}/facts/propose`, headers: OWNER,
      payload: { kind: 'service', key: 'svc_haircut', value: { id: 'svc_haircut', businessId: BARBER, name: 'Haircut', durationMinutes: 60, priceMinor: 3000, currency: 'USD', bufferMinutes: 5 } } });
    expect(proposed.statusCode).toBe(201);
    const { approval } = ENDPOINTS.proposeFact.response.parse(proposed.json());
    expect((await w.app.inject({ method: 'POST', url: `/api/approvals/${approval.id}/decision?businessId=${BARBER}`, headers: OWNER, payload: { decision: 'approve', payloadHash: approval.payloadHash } })).statusCode).toBe(200);

    // Call A keeps 30 minutes for availability and for the stored proposal.
    const start = zonedIso(date, '11:00', TZ);
    const queriesBefore = w.calendar.queries.length;
    w.model.push(async ({ executeTool }) => {
      const r = await executeTool('read_calendar_availability', { serviceId: 'svc_haircut', date }) as ToolResult<'read_calendar_availability'>;
      return r.ok ? String(Date.parse(r.slots[0]!.endUtc) - Date.parse(r.slots[0]!.startUtc)) : 'failed';
    });
    expect(Number((await sim({ callId: callA.callId, message: 'Again?' })).reply)).toBe(30 * 60_000);
    const out: { r?: Proposal } = {};
    w.model.push(proposeTurn(start, out));
    await sim({ callId: callA.callId, message: 'Eleven then', end: true });
    expect(out.r).toMatchObject({ ok: true });
    const stored = (await w.t.db.query('select start_utc, end_utc from bookings where id = $1', [out.r!.proposalId])).rows[0] as { start_utc: Date; end_utc: Date };
    expect(stored.end_utc.getTime() - stored.start_utc.getTime()).toBe(30 * 60_000);
    // The exact check asked free/busy about a 30-minute service window too.
    expect(w.calendar.queries.length).toBeGreaterThan(queriesBefore);

    // A new call reads the new duration.
    w.model.push(async ({ executeTool }) => {
      const r = await executeTool('read_calendar_availability', { serviceId: 'svc_haircut', date }) as ToolResult<'read_calendar_availability'>;
      return r.ok ? String(Date.parse(r.slots[0]!.endUtc) - Date.parse(r.slots[0]!.startUtc)) : 'failed';
    });
    expect(Number((await sim({ message: 'Haircut availability?', end: true })).reply)).toBe(60 * 60_000);
  });
});
