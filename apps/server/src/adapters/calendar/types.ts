import type { AvailabilitySlot, Booking, HoursKey, HoursValue, ToolFailure } from '@abos/contracts';

/**
 * One day of availability for one calendar. `hours` are the per-weekday `hours`
 * facts (keys `mon` to `sun`). `serviceId` is carried because AvailabilitySlot
 * requires it; pass the verified service with its duration.
 */
export type AvailabilityQuery = Pick<Booking, 'calendarId' | 'timezone' | 'serviceId'> & {
  /** YYYY-MM-DD in the business time zone. */
  date: string;
  hours: Partial<Record<HoursKey, HoursValue>>;
  serviceDurationMinutes: number;
  /** Added after the service only. The inserted event never covers it. */
  bufferMinutes: number;
  minNoticeMinutes: number;
  /** 1 to 5, default 5 (CONTRACTS read_calendar_availability). */
  maxSlots?: number;
};

export type BusyBlock = { start: string; end: string };

/** `outcome: 'unknown'`: an insert was sent and the follow-up lookup could not establish whether it landed (SPEC 2.9). */
export type AdapterFailure = ToolFailure & { retryable: boolean; outcome?: 'unknown' };
export type AdapterResult<T> = ({ ok: true } & T) | AdapterFailure;

export type CreateEventInput = Pick<Booking, 'calendarId' | 'startUtc' | 'endUtc'> & {
  bookingId: Booking['id'];
  summary: string;
  description: string;
  /**
   * The step's idempotency key (CONTRACTS 5), used as the Google event id.
   * When absent the adapter uses sha256(bookingId), which is also stable.
   */
  idempotencyKey?: string;
  /**
   * Fresh business facts for this booking's date, used only to compute
   * alternatives on a conflict. Without it a conflict has no alternatives.
   */
  alternativesQuery?: Omit<AvailabilityQuery, 'calendarId'>;
};

export type EventReference = { googleEventId: string; link?: string };

export interface CalendarAdapter {
  getAvailability(input: AvailabilityQuery): Promise<AdapterResult<{ slots: AvailabilitySlot[] }>>;
  createEvent(input: CreateEventInput): Promise<AdapterResult<EventReference>>;
  deleteEventForBooking(bookingId: Booking['id'], calendarId: string): Promise<AdapterResult<{ deleted: boolean }>>;
}

export type GoogleEvent = { id?: string | null; htmlLink?: string | null; status?: string | null };

export type FreeBusyResponse = {
  data: {
    calendars?: Record<string, { busy?: { start?: string | null; end?: string | null }[]; errors?: { reason?: string | null }[] }> | null;
  };
};

export type InsertEventRequest = {
  calendarId: string;
  sendUpdates: 'none';
  requestBody: {
    id: string;
    summary: string;
    description: string;
    start: { dateTime: string };
    end: { dateTime: string };
    transparency: 'opaque';
    extendedProperties: { private: Record<string, string> };
  };
};

/**
 * Only the SDK surface this adapter uses. A real `calendar_v3.Calendar` from
 * `@googleapis/calendar` satisfies it (checked in the tests). Credentials are
 * supplied by whoever builds the client.
 */
export interface GoogleCalendarClient {
  freebusy: {
    query(input: { requestBody: { timeMin: string; timeMax: string; timeZone?: string; items: { id: string }[] } }): Promise<FreeBusyResponse>;
  };
  events: {
    list(input: { calendarId: string; privateExtendedProperty: string[]; showDeleted: false; singleEvents: true; pageToken?: string }): Promise<{ data: { items?: GoogleEvent[] | null; nextPageToken?: string | null } }>;
    get(input: { calendarId: string; eventId: string }): Promise<{ data: GoogleEvent }>;
    insert(input: InsertEventRequest): Promise<{ data: GoogleEvent }>;
    delete(input: { calendarId: string; eventId: string; sendUpdates: 'none' }): Promise<unknown>;
  };
}

export interface CalendarDependencies {
  client: GoogleCalendarClient;
  now(): Date;
  /** Per provider call. Default 8000 ms (CONTRACTS capability timeout). */
  timeoutMs?: number;
}
