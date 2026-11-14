import { HoursValueSchema } from '@abos/contracts';
import { describe, expect, it } from 'vitest';
import { readableFactValue, sameFactMeaning, typedFactValue } from './fact-values';

describe('typed fact values from chat answers', () => {
  it('reads opening hours with am or pm, 24-hour times with minutes, noon and closed', () => {
    expect(typedFactValue('hours.fri', 'Open 11 am until 11 pm.')).toEqual({ ok: true, value: { open: '11:00', close: '23:00' } });
    expect(typedFactValue('hours.mon', '9:30am - 5:15 p.m.')).toEqual({ ok: true, value: { open: '09:30', close: '17:15' } });
    expect(typedFactValue('hours.tue', '08:00 to 17:30')).toEqual({ ok: true, value: { open: '08:00', close: '17:30' } });
    expect(typedFactValue('hours.wed', 'noon to 9 pm')).toEqual({ ok: true, value: { open: '12:00', close: '21:00' } });
    expect(typedFactValue('hours.sun', 'We are closed on Sundays')).toEqual({ ok: true, value: { closed: true } });
    for (const text of ['11 to 11', '9-5', 'late', '10 pm to 2 am', 'closed from 2 pm to 4 pm', '9 am']) {
      expect(typedFactValue('hours.fri', text).ok).toBe(false);
    }
    const r = typedFactValue('hours.fri', '11 am to 11 pm');
    expect(r.ok && HoursValueSchema.safeParse(r.value).success).toBe(true);
  });

  it('reads one length of time as minutes, and refuses two different ones', () => {
    expect(typedFactValue('policy.min_notice', 'At least 2 hours before the appointment.')).toEqual({ ok: true, value: { minutes: 120, text: 'At least 2 hours before the appointment.' } });
    expect(typedFactValue('policy.pickup_window', '20 minutes')).toMatchObject({ ok: true, value: { minutes: 20 } });
    expect(typedFactValue('policy.pickup_window', 'an hour')).toMatchObject({ ok: true, value: { minutes: 60 } });
    expect(typedFactValue('policy.pickup_window', 'half an hour')).toMatchObject({ ok: true, value: { minutes: 30 } });
    for (const text of ['soon', '20 minutes or 1 hour', 'an hour and a half', 'within the hour']) {
      expect(typedFactValue('policy.pickup_window', text).ok).toBe(false);
    }
  });

  it('reads yes or no for special requests, and consent wording as given', () => {
    expect(typedFactValue('policy.special_requests', 'Yes, we accept them.')).toMatchObject({ ok: true, value: { allowed: true } });
    expect(typedFactValue('policy.special_requests', 'No special requests.')).toMatchObject({ ok: true, value: { allowed: false } });
    expect(typedFactValue('policy.special_requests', 'Yes but not on Fridays').ok).toBe(false);
    expect(typedFactValue('policy.message_consent', 'May we text you?')).toEqual({ ok: true, value: { required: true, wording: 'May we text you?' } });
  });

  it('a text-only value is not readable where the readers need structure', () => {
    expect(readableFactValue('hours.fri', { text: '11 to 11' })).toBe(false);
    expect(readableFactValue('policy.min_notice', { text: '2 hours' })).toBe(false);
    expect(readableFactValue('policy.min_notice', { minutes: 120, text: '2 hours' })).toBe(true);
    expect(readableFactValue('policy.message_consent', { text: 'ask' })).toBe(false);
  });

  it('two answers with the same meaning are the same, whatever the words', () => {
    expect(sameFactMeaning('policy.min_notice', { minutes: 120, text: '2 hours' }, { minutes: 120, text: '120 minutes' })).toBe(true);
    expect(sameFactMeaning('policy.min_notice', { minutes: 120 }, { minutes: 60 })).toBe(false);
    expect(sameFactMeaning('hours.fri', { open: '11:00', close: '23:00' }, { open: '11:00', close: '23:00' })).toBe(true);
  });
});
