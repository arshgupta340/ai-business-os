import {describe, expect, it} from 'vitest';
import {actorName} from './format';

describe('actorName', () => {
  it('never shows a raw user ID', () => {
    expect(actorName('usr_owner_01')).toBe('the owner');
    expect(actorName(undefined)).toBe('the system');
    expect(actorName('svc_worker')).toBe('the system');
  });
});
