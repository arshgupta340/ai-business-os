// Issue #93 "smaller": the Idempotency-Key replay memory had no size limit.
import { describe, expect, it } from 'vitest';
import { createReplayCache } from '../../src/api/replay';

describe('the Idempotency-Key replay memory', () => {
  it('returns what was stored for a key until it expires', () => {
    const cache = createReplayCache<string>({ ttlMs: 1000, maxEntries: 10 });
    cache.set('a', { fingerprint: 'f', response: 'r' }, 0);
    expect(cache.get('a', 999)).toEqual({ fingerprint: 'f', response: 'r' });
    expect(cache.get('a', 1000)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('never holds more than its bound: the oldest key is dropped first', () => {
    const cache = createReplayCache<number>({ ttlMs: 1_000_000, maxEntries: 3 });
    for (let i = 0; i < 50; i++) cache.set(`k${i}`, { fingerprint: 'f', response: i }, i);
    expect(cache.size).toBe(3);
    expect(cache.get('k46', 60)).toBeUndefined();
    expect([47, 48, 49].map((i) => cache.get(`k${i}`, 60)?.response)).toEqual([47, 48, 49]);
  });

  it('drops expired keys before it drops live ones, and delete removes a key', () => {
    const cache = createReplayCache<number>({ ttlMs: 100, maxEntries: 2 });
    cache.set('old', { fingerprint: 'f', response: 1 }, 0);
    cache.set('live', { fingerprint: 'f', response: 2 }, 90);
    cache.set('new', { fingerprint: 'f', response: 3 }, 150);
    expect(cache.get('live', 160)?.response).toBe(2);
    expect(cache.get('new', 160)?.response).toBe(3);
    cache.delete('new');
    expect(cache.get('new', 160)).toBeUndefined();
  });
});
