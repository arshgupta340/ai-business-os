// Prints up to 5 free start times for the demo service.
//   npm run slots              uses live free/busy from GOOGLE_CALENDAR_ID
//   npm run slots -- --offline needs no keys and treats the calendar as empty

import { parseArgs, run, describeError } from "./cli.js";
import { DEMO_BUFFER_MINUTES, DEMO_MIN_NOTICE_MINUTES, DEMO_SERVICE, TIME_ZONE } from "./demo-config.js";
import { demoSlots, demoSlotsFromBusy } from "./demo.js";
import { authClient, calendarClient } from "./google.js";
import { formatHuman } from "./time.js";
import type { Slot } from "./slots.js";

function print(slots: Slot[], label: string): void {
  console.log(
    `${DEMO_SERVICE.name}, ${DEMO_SERVICE.durationMinutes} min, buffer ${DEMO_BUFFER_MINUTES} min, ` +
      `notice ${DEMO_MIN_NOTICE_MINUTES} min, ${TIME_ZONE} (${label}):`,
  );
  if (slots.length === 0) console.log("  no free slots in the next 7 days");
  for (const s of slots) console.log(`  ${formatHuman(Date.parse(s.startAt), TIME_ZONE)}   ${s.localStart}`);
}

let args: Record<string, string>;
try {
  args = parseArgs();
} catch (err) {
  console.error(describeError(err));
  process.exit(1);
}

if (args.offline === "true") {
  print(demoSlotsFromBusy([], new Date()), "offline, calendar treated as empty");
} else {
  run({ calendar: true }, async (cfg) => {
    const cal = calendarClient(authClient(cfg.serviceAccount));
    print(await demoSlots(cal, cfg.calendarId), "live free/busy");
  });
}
