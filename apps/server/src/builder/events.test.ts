import { describe, expect, it } from 'vitest';
import type { ActivityEvent } from '@abos/contracts';
import { assertContractEvent, EventContractError } from './events';

const base = { id: 'evt_1', businessId: 'biz_pizza_01', correlationId: 'agt_1', actorType: 'owner', occurredAt: '2026-11-14T20:30:00Z' } as const;

describe('assertContractEvent', () => {
  it('passes an event the contract defines', () => {
    const event: ActivityEvent = { ...base, type: 'agent.paused', payload: { agentId: 'agt_1' } };
    expect(assertContractEvent(event)).toBe(event);
  });

  it('refuses an unknown type, a wrong payload and a bad envelope, without echoing values', () => {
    expect(() => assertContractEvent({ ...base, type: 'agent.deleted', payload: {} } as unknown as ActivityEvent)).toThrow(EventContractError);
    expect(() => assertContractEvent({ ...base, type: 'agent.published', payload: { agentId: 'agt_1', agentVersionId: 'v1', version: 1 } } as ActivityEvent)).toThrow(
      /payload.agentVersionId/,
    );
    expect(() => assertContractEvent({ ...base, id: 'x', type: 'agent.paused', payload: { agentId: 'agt_1' } } as ActivityEvent)).toThrow(/at: id$/);
    try {
      assertContractEvent({ ...base, type: 'live_agent.changed', payload: { phoneNumberLast4: '+15555550199', agentId: 'agt_1', agentVersionId: 'agv_1' } } as ActivityEvent);
    } catch (error) {
      expect((error as Error).message).not.toContain('5555');
    }
  });
});
