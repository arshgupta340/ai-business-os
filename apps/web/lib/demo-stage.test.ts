// @vitest-environment jsdom
import {act, renderHook} from '@testing-library/react';
import {STAGE_SHOPS} from '@abos/contracts/fixtures';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {clearDemoAgentBuilt, markDemoAgentBuilt, useDemoHidesAgents} from './demo-stage';

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_DEMO_SCRIPT', '1');
  clearDemoAgentBuilt();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('useDemoHidesAgents with three stage shops', () => {
  it('shows the agent only of the shop whose build reached the number', () => {
    const pizza = renderHook(() => useDemoHidesAgents(STAGE_SHOPS.pizza.businessId));
    const barber = renderHook(() => useDemoHidesAgents(STAGE_SHOPS.barber.businessId));
    expect(pizza.result.current).toBe(true);
    expect(barber.result.current).toBe(true);
    act(() => markDemoAgentBuilt(STAGE_SHOPS.barber.businessId));
    expect(barber.result.current).toBe(false);
    expect(pizza.result.current).toBe(true);
    act(() => clearDemoAgentBuilt());
    expect(barber.result.current).toBe(true);
  });

  it('never hides with the demo flag off', () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_SCRIPT', '');
    const {result} = renderHook(() => useDemoHidesAgents(STAGE_SHOPS.salon.businessId));
    expect(result.current).toBe(false);
  });
});
