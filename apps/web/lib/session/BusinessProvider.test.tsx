// @vitest-environment jsdom
import {act, renderHook, waitFor} from '@testing-library/react';
import type {ReactNode} from 'react';
import {afterEach, describe, expect, it} from 'vitest';
import {BusinessProvider, useBusiness} from './BusinessProvider';
import {BUSINESS_STORAGE_KEY} from './business-selection';

const wrapper = ({children}: {children: ReactNode}) => <BusinessProvider>{children}</BusinessProvider>;

afterEach(() => {
  window.localStorage.clear();
});

describe('useBusiness', () => {
  it('starts on the pizza business', () => {
    const {result} = renderHook(() => useBusiness(), {wrapper});
    expect(result.current.businessId).toBe('biz_pizza_01');
    expect(result.current.business?.name).toBe('Demo Pizza Co.');
    expect(result.current.businesses).toHaveLength(2);
  });

  it('persists a new selection in localStorage', () => {
    const {result} = renderHook(() => useBusiness(), {wrapper});
    act(() => result.current.setBusinessId('biz_barber_01'));
    expect(result.current.businessId).toBe('biz_barber_01');
    expect(window.localStorage.getItem(BUSINESS_STORAGE_KEY)).toBe('biz_barber_01');
  });

  it('restores the stored selection after mount', async () => {
    window.localStorage.setItem(BUSINESS_STORAGE_KEY, 'biz_barber_01');
    const {result} = renderHook(() => useBusiness(), {wrapper});
    await waitFor(() => expect(result.current.businessId).toBe('biz_barber_01'));
  });

  it('ignores an unknown business ID', () => {
    const {result} = renderHook(() => useBusiness(), {wrapper});
    act(() => result.current.setBusinessId('biz_unknown_01'));
    expect(result.current.businessId).toBe('biz_pizza_01');
    expect(window.localStorage.getItem(BUSINESS_STORAGE_KEY)).toBeNull();
  });
});
