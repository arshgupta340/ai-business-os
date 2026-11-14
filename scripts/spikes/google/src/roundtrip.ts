// Runs the whole spike in order and prints PASS or FAIL per step.
// Cleans up its calendar events even when a step fails. The Sheets row stays,
// because it is the proof that the append ran once.

import { createBookingEvent, deleteEventByBookingId, findEventByBookingId, queryBusy } from "./calendar.js";
import { describeError } from "./cli.js";
import { ConfigError, loadGoogleConfig, type GoogleConfig } from "./env.js";
import { TIME_ZONE } from "./demo-config.js";
import { demoSlotsFromBusy } from "./demo.js";
import { authClient, calendarClient, sheetsClient } from "./google.js";
import { appendRowOnce, countRecordId } from "./sheets.js";
import { formatHuman } from "./time.js";
import type { BookingSlot } from "./calendar.js";

const results: { step: string; pass: boolean; detail: string }[] = [];

function record(step: string, pass: boolean, detail: string): void {
  results.push({ step, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${step}: ${detail}`);
}

async function step(name: string, cfg: GoogleConfig, fn: () => Promise<string>): Promise<boolean> {
  try {
    record(name, true, await fn());
    return true;
  } catch (err) {
    record(name, false, describeError(err, cfg).replace(/\n/g, " "));
    return false;
  }
}

async function main(): Promise<void> {
  let cfg: GoogleConfig;
  try {
    cfg = loadGoogleConfig({ calendar: true, sheet: true });
  } catch (err) {
    console.error(describeError(err));
    process.exit(1);
  }

  const auth = authClient(cfg.serviceAccount);
  const cal = calendarClient(auth);
  const api = sheetsClient(auth);
  const stamp = Date.now();
  const bookingA = `bkg_spike_${stamp}_a`;
  const bookingB = `bkg_spike_${stamp}_b`;
  const recordId = `spike_row_${stamp}`;
  let slot: BookingSlot | undefined;
  let eventIdA: string | undefined;

  console.log(`Spike B-05 roundtrip. Booking IDs ${bookingA}, ${bookingB}. Record ID ${recordId}.\n`);

  await step("1 whoami", cfg, async () => {
    const t = await auth.getAccessToken();
    if (!t.token) throw new Error("no access token");
    return `${cfg.serviceAccount.clientEmail}, token issued`;
  });

  await step("2 freebusy", cfg, async () => {
    const now = new Date();
    const busy = await queryBusy(cal, cfg.calendarId, now, new Date(now.getTime() + 7 * 86400_000), TIME_ZONE);
    const [first] = demoSlotsFromBusy(busy, now, 1);
    if (!first) throw new Error("free/busy worked but no free demo slot in 7 days; free some time and rerun");
    slot = { startAt: new Date(first.startAt), endAt: new Date(first.endAt), timeZone: TIME_ZONE };
    return `${busy.length} busy block(s) in 7 days; test slot ${formatHuman(slot.startAt.getTime(), TIME_ZONE)}`;
  });

  try {
    if (slot) {
      const s = slot;
      await step("3 create-event (new booking)", cfg, async () => {
        const r = await createBookingEvent(cal, cfg.calendarId, bookingA, s);
        if (r.kind !== "CREATED") throw new Error(`expected CREATED, got ${r.kind}`);
        eventIdA = r.event.id ?? undefined;
        return `CREATED ${r.event.id} ${r.event.htmlLink}`;
      });

      await step("4 create-event (same booking ID again)", cfg, async () => {
        const r = await createBookingEvent(cal, cfg.calendarId, bookingA, s);
        if (r.kind !== "EXISTING") throw new Error(`expected EXISTING, got ${r.kind}`);
        if (r.event.id !== eventIdA) throw new Error(`found ${r.event.id}, expected ${eventIdA}`);
        return `EXISTING ${r.event.id}, no duplicate`;
      });

      // Give free/busy a moment to see the new event before the conflict check.
      await new Promise((res) => setTimeout(res, 3000));

      await step("5 create-event (same slot, other booking ID)", cfg, async () => {
        const r = await createBookingEvent(cal, cfg.calendarId, bookingB, s);
        if (r.kind !== "SLOT_CONFLICT") {
          throw new Error(`expected SLOT_CONFLICT, got ${r.kind} (event ${r.event.id})`);
        }
        return `SLOT_CONFLICT, ${r.busy.length} overlapping busy block(s), nothing created`;
      });

      await step("6 delete-event", cfg, async () => {
        const r = await deleteEventByBookingId(cal, cfg.calendarId, bookingA);
        if (r.kind !== "DELETED") throw new Error("expected DELETED, got NOT_FOUND");
        const after = await findEventByBookingId(cal, cfg.calendarId, bookingA);
        if (after) throw new Error(`event ${after.id} still found after delete`);
        return `DELETED ${r.eventId}; lookup now finds nothing`;
      });
    } else {
      for (const n of ["3 create-event", "4 create-event again", "5 conflict check", "6 delete-event"]) {
        record(n, false, "skipped, no test slot from step 2");
      }
    }
  } finally {
    // Cleanup in case a step failed midway. Never throws.
    for (const b of [bookingA, bookingB]) {
      try {
        const r = await deleteEventByBookingId(cal, cfg.calendarId, b);
        if (r.kind === "DELETED") console.log(`      cleanup: deleted leftover event ${r.eventId} for ${b}`);
      } catch (err) {
        console.log(`      cleanup for ${b} failed: ${describeError(err, cfg).replace(/\n/g, " ")}`);
      }
    }
  }

  const row = [new Date().toISOString(), "spike", bookingA, "Spike B-05 roundtrip row, safe to delete"];
  await step("7 append-row (first time)", cfg, async () => {
    const r = await appendRowOnce(api, cfg.sheetId, recordId, row);
    if (r.kind !== "APPENDED") throw new Error(`expected APPENDED, got ${r.kind}`);
    return `APPENDED at ${r.updatedRange}${r.headerCreated ? ", header created" : ""}`;
  });

  await step("8 append-row (same record ID again)", cfg, async () => {
    const r = await appendRowOnce(api, cfg.sheetId, recordId, row);
    if (r.kind !== "SKIPPED") throw new Error(`expected SKIPPED, got ${r.kind}`);
    const n = await countRecordId(api, cfg.sheetId, recordId);
    if (n !== 1) throw new Error(`record ID appears ${n} times in column A`);
    return "SKIPPED, record ID appears exactly once";
  });

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} FAILED`} (${results.length} steps)`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof ConfigError ? `Config error: ${err.message}` : describeError(err));
  process.exit(1);
});
