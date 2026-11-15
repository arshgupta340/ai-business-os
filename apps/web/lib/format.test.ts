import {describe, expect, it} from 'vitest';
import {actorName, formatPhone} from './format';

describe('actorName', () => {
  it('never shows a raw user ID', () => {
    expect(actorName('usr_owner_01')).toBe('the owner');
    expect(actorName(undefined)).toBe('the system');
    expect(actorName('svc_worker')).toBe('the system');
  });
});

describe('formatPhone', () => {
  it('formats a North American number for reading aloud', () => {
    expect(formatPhone('+15555550199')).toBe('+1 (555) 555 0199');
    expect(formatPhone('+1 805-555-0199')).toBe('+1 (805) 555 0199');
  });

  it('returns anything it cannot parse unchanged', () => {
    expect(formatPhone('+442071838750')).toBe('+442071838750');
    expect(formatPhone('5550199')).toBe('5550199');
    expect(formatPhone('')).toBe('');
    expect(formatPhone('call us')).toBe('call us');
  });
});
