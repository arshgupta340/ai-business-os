// Calendar operations for the spike. The booking rule (PRD 9, FLOWS C8):
//   1. look up an existing event carrying the booking ID, return it if found;
//   2. otherwise recheck free/busy for exactly the slot, stop on SLOT_CONFLICT;
//   3. otherwise insert one event with the booking ID, no attendees, no invites.

import type { calendar_v3 } from "@googleapis/calendar";
import type { BusyBlock } from "./slots.js";

/** Key of the private extended property that holds our booking ID. Max 44 characters. */
export const BOOKING_ID_KEY = "bookingId";

export class FreeBusyError extends Error {
  override name = "FreeBusyError";
}

export async function queryBusy(
  cal: calendar_v3.Calendar,
  calendarId: string,
  timeMin: Date,
  timeMax: Date,
  timeZone: string,
): Promise<BusyBlock[]> {
  const res = await cal.freebusy.query({
    requestBody: {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      timeZone,
      items: [{ id: calendarId }],
    },
  });
  const entry = res.data.calendars?.[calendarId];
  if (!entry) {
    throw new FreeBusyError(
      `Free/busy returned no entry for ${calendarId}. Check GOOGLE_CALENDAR_ID.`,
    );
  }
  if (entry.errors?.length) {
    const reasons = entry.errors.map((x) => x.reason ?? "unknown").join(", ");
    throw new FreeBusyError(
      `Free/busy failed for the calendar (${reasons}). "notFound" usually means the calendar is not ` +
        `shared with the service account or the ID is wrong.`,
    );
  }
  return (entry.busy ?? []).flatMap((b) => (b.start && b.end ? [{ start: b.start, end: b.end }] : []));
}

export async function findEventByBookingId(
  cal: calendar_v3.Calendar,
  calendarId: string,
  bookingId: string,
): Promise<calendar_v3.Schema$Event | undefined> {
  const res = await cal.events.list({
    calendarId,
    privateExtendedProperty: [`${BOOKING_ID_KEY}=${bookingId}`],
    showDeleted: false,
    singleEvents: true,
    maxResults: 10,
  });
  const items = (res.data.items ?? []).filter((e) => e.status !== "cancelled");
  if (items.length > 1) {
    // Should never happen. Report it rather than hide it.
    console.warn(`  warning: ${items.length} events carry booking ID ${bookingId}; returning the first.`);
  }
  return items[0];
}

export interface BookingSlot {
  startAt: Date;
  endAt: Date;
  timeZone: string;
}

export type CreateEventResult =
  | { kind: "EXISTING"; event: calendar_v3.Schema$Event }
  | { kind: "CREATED"; event: calendar_v3.Schema$Event }
  | { kind: "SLOT_CONFLICT"; busy: BusyBlock[] };

export async function createBookingEvent(
  cal: calendar_v3.Calendar,
  calendarId: string,
  bookingId: string,
  slot: BookingSlot,
  summary = "Spike booking (safe to delete)",
): Promise<CreateEventResult> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(bookingId)) {
    throw new Error(`Booking ID must be letters, digits, _ or -, got "${bookingId}"`);
  }
  if (!(slot.endAt > slot.startAt)) throw new Error("Slot end must be after its start");

  const existing = await findEventByBookingId(cal, calendarId, bookingId);
  if (existing) return { kind: "EXISTING", event: existing };

  const busy = await queryBusy(cal, calendarId, slot.startAt, slot.endAt, slot.timeZone);
  const s = slot.startAt.getTime();
  const e = slot.endAt.getTime();
  const overlapping = busy.filter((b) => Date.parse(String(b.start)) < e && s < Date.parse(String(b.end)));
  if (overlapping.length) return { kind: "SLOT_CONFLICT", busy: overlapping };

  const res = await cal.events.insert({
    calendarId,
    sendUpdates: "none",
    requestBody: {
      summary,
      description: `Created by spike B-05. Booking ${bookingId}.`,
      start: { dateTime: slot.startAt.toISOString(), timeZone: slot.timeZone },
      end: { dateTime: slot.endAt.toISOString(), timeZone: slot.timeZone },
      // Opaque so the event shows as busy in free/busy and blocks the slot.
      transparency: "opaque",
      // No attendees: no invitations go out, and a service account cannot
      // invite attendees without domain-wide delegation anyway.
      extendedProperties: { private: { [BOOKING_ID_KEY]: bookingId } },
    },
  });
  return { kind: "CREATED", event: res.data };
}

export type DeleteEventResult = { kind: "DELETED"; eventId: string } | { kind: "NOT_FOUND" };

export async function deleteEventByBookingId(
  cal: calendar_v3.Calendar,
  calendarId: string,
  bookingId: string,
): Promise<DeleteEventResult> {
  const existing = await findEventByBookingId(cal, calendarId, bookingId);
  if (!existing?.id) return { kind: "NOT_FOUND" };
  await cal.events.delete({ calendarId, eventId: existing.id, sendUpdates: "none" });
  return { kind: "DELETED", eventId: existing.id };
}
