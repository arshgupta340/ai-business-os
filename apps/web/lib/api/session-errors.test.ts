import {describe, expect, it} from 'vitest';
import {ApiError} from './errors';
import {queryKeys} from './query-keys';
import {businessIdFromQueryKey, reportApiError, subscribeApiErrors, type ApiErrorReport} from './session-errors';
import {chooseBusinesses} from '@/lib/session/ApiBusinessProvider';
import {SEEDED_BUSINESSES} from '@/lib/session/businesses';

const forbidden = new ApiError({code: 'FORBIDDEN_BUSINESS', message: 'No.', status: 403, retryable: false, kind: 'http'});

describe('session error report', () => {
  it('reads the business from a business-scoped key only', () => {
    expect(businessIdFromQueryKey(queryKeys.catalog('biz_barber_01'))).toBe('biz_barber_01');
    expect(businessIdFromQueryKey(queryKeys.businesses())).toBeUndefined();
    expect(businessIdFromQueryKey(queryKeys.liveAgent())).toBeUndefined();
    expect(businessIdFromQueryKey(undefined)).toBeUndefined();
  });

  it('passes ApiErrors to listeners and ignores other errors', () => {
    const seen: ApiErrorReport[] = [];
    const stop = subscribeApiErrors((r) => seen.push(r));
    reportApiError(forbidden, queryKeys.facts('biz_pizza_01'));
    reportApiError(new Error('not an api error'));
    stop();
    reportApiError(forbidden);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({businessId: 'biz_pizza_01'});
    expect(seen[0].error.code).toBe('FORBIDDEN_BUSINESS');
  });
});

describe('chooseBusinesses', () => {
  it('falls back to the seeded list until the API answers', () => {
    expect(chooseBusinesses(undefined, new Set())).toBe(SEEDED_BUSINESSES);
  });

  it('uses the API list and leaves out refused businesses', () => {
    const items = [
      {id: 'biz_pizza_01', name: 'Demo Pizza Co.', category: 'restaurant', timezone: 'America/Los_Angeles'},
      {id: 'biz_barber_01', name: 'Demo Barbershop', category: 'barbershop', timezone: 'America/Los_Angeles'},
    ];
    expect(chooseBusinesses(items, new Set()).map((b) => b.id)).toEqual(['biz_pizza_01', 'biz_barber_01']);
    expect(chooseBusinesses(items, new Set(['biz_pizza_01'])).map((b) => b.id)).toEqual(['biz_barber_01']);
    expect(chooseBusinesses([], new Set())).toEqual([]);
  });
});
