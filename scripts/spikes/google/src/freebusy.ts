// Prints busy blocks on GOOGLE_CALENDAR_ID for the next 7 days, in the business time zone.

import { queryBusy } from "./calendar.js";
import { run } from "./cli.js";
import { TIME_ZONE } from "./demo-config.js";
import { authClient, calendarClient } from "./google.js";
import { formatHuman } from "./time.js";

run({ calendar: true }, async (cfg) => {
  const cal = calendarClient(authClient(cfg.serviceAccount));
  const now = new Date();
  const until = new Date(now.getTime() + 7 * 24 * 3600_000);
  const busy = await queryBusy(cal, cfg.calendarId, now, until, TIME_ZONE);
  console.log(`Busy blocks on the demo calendar, next 7 days, ${TIME_ZONE}: ${busy.length}`);
  for (const b of busy) {
    const s = Date.parse(String(b.start));
    const e = Date.parse(String(b.end));
    console.log(`  ${formatHuman(s, TIME_ZONE)}  to  ${formatHuman(e, TIME_ZONE)}`);
  }
});
