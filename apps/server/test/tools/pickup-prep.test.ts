// The 20 minute minimum between now and a pickup (Arsh, 2026-11-14), with a short grace for the time a call takes.
import { describe, expect, it } from 'vitest';
import { ORDER_PREP_GRACE_MS, ORDER_PREP_MINUTES, PICKUP_TOO_SOON, closesNextMorning, insideWindow, pickupTooSoon, shiftLocalDate } from '../../src/tools/real/time';

const NOW = Date.parse('2026-11-14T18:00:00-08:00');
const MIN = 60_000;

describe('pickup preparation time', () => {
  it('is 20 minutes', () => {
    expect(ORDER_PREP_MINUTES).toBe(20);
    expect(PICKUP_TOO_SOON).toContain('20 minutes');
  });

  it('refuses a pickup sooner than the minimum', () => {
    expect(pickupTooSoon(NOW + 5 * MIN, NOW)).toBe(true);
    expect(pickupTooSoon(NOW + 10 * MIN, NOW)).toBe(true);
    expect(pickupTooSoon(NOW + ORDER_PREP_MINUTES * MIN - ORDER_PREP_GRACE_MS - 1, NOW)).toBe(true);
  });

  it('accepts the minimum, later times, and a time that fell short only by the length of the call', () => {
    expect(pickupTooSoon(NOW + ORDER_PREP_MINUTES * MIN, NOW)).toBe(false);
    expect(pickupTooSoon(NOW + 45 * MIN, NOW)).toBe(false);
    expect(pickupTooSoon(NOW + ORDER_PREP_MINUTES * MIN - ORDER_PREP_GRACE_MS, NOW)).toBe(false);
  });
});

describe('hours that close the next morning (a shop open 11 AM to 2 AM)', () => {
  const TZ = 'America/Los_Angeles';
  const hours = { open: '11:00', close: '02:00' };
  const at = (iso: string) => Date.parse(iso);

  it('knows which hours cross midnight', () => {
    expect(closesNextMorning(hours)).toBe(true);
    expect(closesNextMorning({ open: '09:00', close: '19:00' })).toBe(false);
    expect(shiftLocalDate('2026-11-01', -1)).toBe('2026-10-31');
    expect(shiftLocalDate('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('is open in the evening and after midnight, and closed between 2 AM and 11 AM', () => {
    const inside = (date: string, iso: string) => insideWindow(date, hours, TZ, at(iso), at(iso));
    expect(inside('2026-11-14', '2026-11-14T20:00:00-08:00')).toBe(true);
    // 00:50 on the 15th belongs to the window that opened on the 14th.
    expect(inside('2026-11-14', '2026-11-15T00:50:00-08:00')).toBe(true);
    expect(inside('2026-11-14', '2026-11-15T02:00:00-08:00')).toBe(true);
    expect(inside('2026-11-14', '2026-11-15T02:01:00-08:00')).toBe(false);
    // Seen from the 15th's own window, 00:50 and 09:00 are before it opens.
    expect(inside('2026-11-15', '2026-11-15T00:50:00-08:00')).toBe(false);
    expect(inside('2026-11-15', '2026-11-15T09:00:00-08:00')).toBe(false);
    expect(inside('2026-11-15', '2026-11-15T11:00:00-08:00')).toBe(true);
  });

  it('keeps ordinary hours inside one day', () => {
    const day = { open: '09:00', close: '19:00' };
    expect(insideWindow('2026-11-15', day, TZ, at('2026-11-15T18:59:00-08:00'), at('2026-11-15T18:59:00-08:00'))).toBe(true);
    expect(insideWindow('2026-11-15', day, TZ, at('2026-11-15T19:01:00-08:00'), at('2026-11-15T19:01:00-08:00'))).toBe(false);
  });
});
