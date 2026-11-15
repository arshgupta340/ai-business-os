// The 20 minute minimum between now and a pickup (Arsh, 2026-11-14), with a short grace for the time a call takes.
import { describe, expect, it } from 'vitest';
import { ORDER_PREP_GRACE_MS, ORDER_PREP_MINUTES, PICKUP_TOO_SOON, pickupTooSoon } from '../../src/tools/real/time';

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
