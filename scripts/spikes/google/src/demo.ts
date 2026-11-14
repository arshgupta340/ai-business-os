// Glue between the demo settings, free/busy and the pure slot finder.

import type { calendar_v3 } from "@googleapis/calendar";
import { queryBusy } from "./calendar.js";
import {
  DEMO_BUFFER_MINUTES,
  DEMO_HOURS,
  DEMO_MIN_NOTICE_MINUTES,
  DEMO_SERVICE,
  GRID_MINUTES,
  TIME_ZONE,
} from "./demo-config.js";
import { findFreeSlots, type BusyBlock, type Slot } from "./slots.js";

export function demoSlotsFromBusy(busy: BusyBlock[], now: Date, maxSlots = 5): Slot[] {
  return findFreeSlots({
    timeZone: TIME_ZONE,
    businessHours: DEMO_HOURS,
    durationMinutes: DEMO_SERVICE.durationMinutes,
    bufferMinutes: DEMO_BUFFER_MINUTES,
    minNoticeMinutes: DEMO_MIN_NOTICE_MINUTES,
    gridMinutes: GRID_MINUTES,
    busy,
    now,
    maxSlots,
  });
}

export async function demoSlots(
  cal: calendar_v3.Calendar,
  calendarId: string,
  now: Date = new Date(),
  maxSlots = 5,
): Promise<Slot[]> {
  const until = new Date(now.getTime() + 7 * 24 * 3600_000);
  const busy = await queryBusy(cal, calendarId, now, until, TIME_ZONE);
  return demoSlotsFromBusy(busy, now, maxSlots);
}
