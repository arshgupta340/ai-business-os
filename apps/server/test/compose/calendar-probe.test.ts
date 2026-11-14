// Review finding 5: the Calendar health probe uses an operation the configured scopes allow
// (calendar.events and calendar.freebusy): a free/busy read on the configured calendar.
import { describe, expect, it } from 'vitest';
import { CALENDAR_SCOPES, calendarProbe } from '../../src/compose/providers';

const now = () => new Date('2026-11-14T10:00:00Z');

function fakeClient(answer: (body: { items: { id: string }[] }) => unknown) {
  const calls: string[] = [];
  const client = {
    calendars: { async get() { calls.push('calendars.get'); return { data: {} }; } },
    freebusy: { async query({ requestBody }: { requestBody: { items: { id: string }[] } }) { calls.push('freebusy.query'); return { data: answer(requestBody) }; } },
  };
  return { client, calls };
}

describe('calendar health probe', () => {
  it('needs only the events and free/busy scopes', () => {
    expect([...CALENDAR_SCOPES].sort()).toEqual(['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.freebusy']);
  });

  it('reads free/busy for the configured calendar, never calendar metadata', async () => {
    const { client, calls } = fakeClient((b) => ({ calendars: { [b.items[0]!.id]: { busy: [] } } }));
    expect(await calendarProbe(client, 'cal@example.test', now)()).toMatchObject({ ok: true });
    expect(calls).toEqual(['freebusy.query']);
  });

  it('is disconnected when the calendar entry is missing or carries errors, or the read throws', async () => {
    expect(await calendarProbe(fakeClient(() => ({ calendars: {} })).client, 'cal@example.test', now)()).toMatchObject({ ok: false });
    expect(await calendarProbe(fakeClient((b) => ({ calendars: { [b.items[0]!.id]: { errors: [{ reason: 'notFound' }] } } })).client, 'cal@example.test', now)()).toMatchObject({ ok: false });
    const throwing = { calendars: { async get() { return {}; } }, freebusy: { async query() { throw new Error('403'); } } };
    expect(await calendarProbe(throwing, 'cal@example.test', now)()).toMatchObject({ ok: false });
  });
});
