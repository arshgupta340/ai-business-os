import { calendar } from '@googleapis/calendar';
import { describe, expect, it } from 'vitest';
import type { GoogleCalendarClient } from '../../../src/adapters/calendar/types';

describe('narrow Google Calendar client', () => {
  it('is satisfied by the real SDK client (a compile-time check; no request is made)', () => {
    const real: GoogleCalendarClient = calendar({ version: 'v3' });
    expect(typeof real.events.insert).toBe('function');
  });
});
