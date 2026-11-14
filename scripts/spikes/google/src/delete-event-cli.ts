// Deletes the test event for a booking ID.
//   npm run delete-event                     booking bkg_spike_manual
//   npm run delete-event -- --booking bkg_x

import { deleteEventByBookingId } from "./calendar.js";
import { parseArgs, run } from "./cli.js";
import { DEFAULT_BOOKING_ID } from "./demo-config.js";
import { authClient, calendarClient } from "./google.js";

run({ calendar: true }, async (cfg) => {
  const bookingId = parseArgs().booking ?? DEFAULT_BOOKING_ID;
  const cal = calendarClient(authClient(cfg.serviceAccount));
  const r = await deleteEventByBookingId(cal, cfg.calendarId, bookingId);
  console.log(
    r.kind === "DELETED"
      ? `DELETED event ${r.eventId} for booking ${bookingId}.`
      : `NOT_FOUND: no event carries booking ${bookingId}. Nothing deleted.`,
  );
});
