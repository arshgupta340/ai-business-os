// Arsh, 2026-11-15: on the demo build the barbershop's agent card said "Answers the phone number ending
// 9807", the pizza place's number. Each stage shop has its own line; the screens now show it.
import {afterEach, describe, expect, it, vi} from 'vitest';
import {STAGE_SHOPS} from '@abos/contracts/fixtures';
import type {LiveAgent} from '@/lib/api';
import {shopLine} from './demo-shop-line';

const serverLine: LiveAgent = {phoneNumber: '+18052039807', businessId: STAGE_SHOPS.pizza.businessId, agentId: STAGE_SHOPS.pizza.agent.id, agentVersionId: 'agv_pizza_01_v2', updatedAt: '2026-11-15T09:00:00Z'};

function demoOn() {
  vi.stubEnv('NEXT_PUBLIC_DEMO_SCRIPT', '1');
  vi.stubEnv('NEXT_PUBLIC_DEMO_PHONE_PIZZA', '+18052039807');
  vi.stubEnv('NEXT_PUBLIC_DEMO_PHONE_BARBER', '+16012020299');
  vi.stubEnv('NEXT_PUBLIC_DEMO_PHONE_SALON', '+13242046938');
}

afterEach(() => vi.unstubAllEnvs());

describe('the phone line of a stage shop on the scripted demo', () => {
  it('is the shop\'s own number and agent, not the server\'s single line', () => {
    demoOn();
    expect(shopLine(serverLine, STAGE_SHOPS.barber.businessId)).toEqual({phoneNumber: '+16012020299', businessId: STAGE_SHOPS.barber.businessId, agentId: STAGE_SHOPS.barber.agent.id, updatedAt: '2026-11-15T09:00:00Z'});
    expect(shopLine(serverLine, STAGE_SHOPS.salon.businessId)).toMatchObject({phoneNumber: '+13242046938', agentId: STAGE_SHOPS.salon.agent.id});
    expect(shopLine(serverLine, STAGE_SHOPS.pizza.businessId)).toMatchObject({phoneNumber: '+18052039807', agentId: STAGE_SHOPS.pizza.agent.id});
  });

  it('is the server\'s answer when the demo is off, the number is not set, or the business is not a stage shop', () => {
    expect(shopLine(serverLine, STAGE_SHOPS.barber.businessId)).toBe(serverLine);
    vi.stubEnv('NEXT_PUBLIC_DEMO_SCRIPT', '1');
    expect(shopLine(serverLine, STAGE_SHOPS.barber.businessId)).toBe(serverLine);
    demoOn();
    expect(shopLine(serverLine, 'biz_other_01')).toBe(serverLine);
    expect(shopLine(serverLine, null)).toBe(serverLine);
    // Still loading: nothing is made up.
    expect(shopLine(undefined, STAGE_SHOPS.barber.businessId)).toBeUndefined();
  });
});
