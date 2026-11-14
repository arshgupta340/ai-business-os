import {describe, expect, it} from 'vitest';
import {chooseBusinesses} from './ApiBusinessProvider';
import {SEEDED_BUSINESSES} from './businesses';
import {businessListStatus, type BusinessListInput} from './business-list';

const real = (over: Partial<BusinessListInput>): BusinessListInput => ({
  authStatus: 'signed_in',
  mock: false,
  isPending: false,
  hasError: false,
  apiCount: undefined,
  visibleCount: 0,
  ...over,
});

const items = [
  {id: 'biz_a', name: 'A', category: 'restaurant', timezone: 'America/Los_Angeles'},
  {id: 'biz_b', name: 'B', category: 'barbershop', timezone: 'America/Los_Angeles'},
];

describe('chooseBusinesses in real mode', () => {
  it('shows no seeded business while the list loads or after it failed', () => {
    expect(chooseBusinesses(undefined, new Set(), {fallback: 'none'})).toEqual([]);
  });

  it('shows the server list, without refused businesses', () => {
    expect(chooseBusinesses(items, new Set(['biz_a']), {fallback: 'none'}).map((b) => b.id)).toEqual(['biz_b']);
    expect(chooseBusinesses([], new Set(), {fallback: 'none'})).toEqual([]);
  });

  it('keeps the seeded fallback when asked for it (mock mode)', () => {
    expect(chooseBusinesses(undefined, new Set(), {fallback: 'seeded'})).toBe(SEEDED_BUSINESSES);
    expect(chooseBusinesses(undefined, new Set())).toBe(SEEDED_BUSINESSES);
  });
});

describe('businessListStatus', () => {
  it('is loading until the server answers', () => {
    expect(businessListStatus(real({isPending: true}))).toBe('loading');
  });

  it('is an error when GET /api/businesses failed and no list was ever returned', () => {
    expect(businessListStatus(real({hasError: true}))).toBe('error');
    // A retry in flight shows loading again.
    expect(businessListStatus(real({hasError: true, isPending: true}))).toBe('loading');
  });

  it('keeps a list it already has when a later refetch fails', () => {
    expect(businessListStatus(real({hasError: true, apiCount: 2, visibleCount: 2}))).toBe('ready');
  });

  it('says the account has no business when the server returns an empty list', () => {
    expect(businessListStatus(real({apiCount: 0}))).toBe('empty');
  });

  it('tells apart an empty account from one whose every business was refused', () => {
    expect(businessListStatus(real({apiCount: 1, visibleCount: 0}))).toBe('no_access');
  });

  it('is signed_out when nobody is signed in', () => {
    expect(businessListStatus(real({authStatus: 'signed_out'}))).toBe('signed_out');
    expect(businessListStatus(real({authStatus: 'loading'}))).toBe('signed_out');
  });

  it('keeps mock mode on the seeded list while loading or after a failure', () => {
    expect(businessListStatus(real({mock: true, isPending: true, visibleCount: 2}))).toBe('ready');
    expect(businessListStatus(real({mock: true, hasError: true, visibleCount: 2}))).toBe('ready');
    expect(businessListStatus(real({mock: true, apiCount: 0}))).toBe('empty');
  });
});
