import { describe, expect, it } from 'vitest';
import { checkedResponse } from './respond';

describe('checkedResponse', () => {
  it('passes a response that matches the endpoint schema, unchanged and with extra fields kept', () => {
    const body = { clientSecret: 's', expiresAt: '2026-11-14T20:30:00Z', model: 'gpt-realtime-2.1' as const, builderSessionId: 'bld_1', extra: 1 };
    expect(checkedResponse('createRealtimeClientSecret', body)).toBe(body);
  });

  it('answers INTERNAL with the failing paths for a response that does not match', () => {
    expect(() => checkedResponse('pauseAgent', { agent: { id: 'agt_1' } } as never)).toThrow(
      expect.objectContaining({ code: 'INTERNAL', status: 500, details: expect.objectContaining({ endpoint: 'pauseAgent' }) }),
    );
  });
});
