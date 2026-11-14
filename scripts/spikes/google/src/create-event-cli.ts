// Creates one test event for a booking ID, following the booking rule.
//   npm run create-event                              first free demo slot, booking bkg_spike_manual
//   npm run create-event -- --booking bkg_x --start 2026-11-20T17:00:00Z --minutes 30

import { createBookingEvent } from "./calendar.js";
import { parseArgs, run } from "./cli.js";
import { ConfigError } from "./env.js";
import { DEFAULT_BOOKING_ID, DEMO_SERVICE, TIME_ZONE } from "./demo-config.js";
import { demoSlots } from "./demo.js";
import { authClient, calendarClient } from "./google.js";
import { formatHuman } from "./time.js";

run({ calendar: true }, async (cfg) => {
  const args = parseArgs();
  const bookingId = args.booking ?? DEFAULT_BOOKING_ID;
  const cal = calendarClient(authClient(cfg.serviceAccount));

  let startAt: Date;
  if (args.start) {
    startAt = new Date(args.start);
    if (Number.isNaN(startAt.getTime())) throw new ConfigError(`--start "${args.start}" is not a date`);
  } else {
    const [first] = await demoSlots(cal, cfg.calendarId, new Date(), 1);
    if (!first) throw new Error("No free demo slot in the next 7 days. Pass --start.");
    startAt = new Date(first.startAt);
  }
  const minutes = Number(args.minutes ?? DEMO_SERVICE.durationMinutes);
  if (!Number.isInteger(minutes) || minutes <= 0) throw new ConfigError("--minutes must be a positive integer");
  const endAt = new Date(startAt.getTime() + minutes * 60_000);

  console.log(`Booking ${bookingId}: ${formatHuman(startAt.getTime(), TIME_ZONE)}, ${minutes} min`);
  const r = await createBookingEvent(cal, cfg.calendarId, bookingId, { startAt, endAt, timeZone: TIME_ZONE });
  if (r.kind === "SLOT_CONFLICT") {
    console.log(`SLOT_CONFLICT: the slot overlaps ${r.busy.length} busy block(s). No event was created.`);
    process.exitCode = 2;
    return;
  }
  console.log(r.kind === "CREATED" ? "CREATED a new event." : "EXISTING event found for this booking ID. Nothing created.");
  console.log(`  event ID: ${r.event.id}`);
  console.log(`  link:     ${r.event.htmlLink}`);
});
