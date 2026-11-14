import {describe, expect, it} from 'vitest';
import {SEEDED_BUSINESSES, DEFAULT_BUSINESS_ID} from './businesses';
import {BUSINESS_STORAGE_KEY, readStoredBusinessId, resolveBusinessId, storeBusinessId} from './business-selection';
import type {KeyValueStorage} from '@/lib/storage';

function memoryStorage(): KeyValueStorage & {data: Map<string, string>} {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe('seeded businesses', () => {
  it('match SPEC 2.1', () => {
    expect(SEEDED_BUSINESSES.map((b) => [b.id, b.name, b.timezone])).toEqual([
      ['biz_pizza_01', 'Demo Pizza Co.', 'America/Los_Angeles'],
      ['biz_barber_01', 'Demo Barbershop', 'America/Los_Angeles'],
    ]);
    expect(DEFAULT_BUSINESS_ID).toBe('biz_pizza_01');
  });
});

describe('resolveBusinessId', () => {
  it('defaults to the pizza business when nothing is stored', () => {
    expect(resolveBusinessId(SEEDED_BUSINESSES, null, DEFAULT_BUSINESS_ID)).toBe('biz_pizza_01');
  });

  it('uses a stored ID that is still in the list', () => {
    expect(resolveBusinessId(SEEDED_BUSINESSES, 'biz_barber_01', DEFAULT_BUSINESS_ID)).toBe('biz_barber_01');
  });

  it('ignores a stored ID that is not in the list', () => {
    expect(resolveBusinessId(SEEDED_BUSINESSES, 'biz_gone_99', DEFAULT_BUSINESS_ID)).toBe('biz_pizza_01');
  });

  it('falls back to the first business, then null', () => {
    const onlyBarber = SEEDED_BUSINESSES.filter((b) => b.id === 'biz_barber_01');
    expect(resolveBusinessId(onlyBarber, null, DEFAULT_BUSINESS_ID)).toBe('biz_barber_01');
    expect(resolveBusinessId([], null, DEFAULT_BUSINESS_ID)).toBeNull();
  });
});

describe('selection persistence', () => {
  it('round-trips through storage', () => {
    const storage = memoryStorage();
    expect(readStoredBusinessId(storage)).toBeNull();
    storeBusinessId(storage, 'biz_barber_01');
    expect(storage.data.get(BUSINESS_STORAGE_KEY)).toBe('biz_barber_01');
    expect(readStoredBusinessId(storage)).toBe('biz_barber_01');
  });

  it('does nothing without storage', () => {
    expect(readStoredBusinessId(null)).toBeNull();
    expect(() => storeBusinessId(null, 'biz_pizza_01')).not.toThrow();
  });

  it('survives storage that throws', () => {
    const broken: KeyValueStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => undefined,
    };
    expect(readStoredBusinessId(broken)).toBeNull();
    expect(() => storeBusinessId(broken, 'biz_pizza_01')).not.toThrow();
  });
});
