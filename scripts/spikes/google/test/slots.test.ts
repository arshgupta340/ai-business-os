import { describe, expect, it } from "vitest";
import { findFreeSlots, type BusinessHours, type SlotQuery } from "../src/slots.js";
import { formatLocalIso, zonedWallTimeToUtc } from "../src/time.js";

const TZ = "America/Los_Angeles";

// Tuesday to Sunday open, Monday closed.
const HOURS: BusinessHours = {
  mon: [],
  tue: [{ open: "09:00", close: "18:00" }],
  wed: [{ open: "09:00", close: "18:00" }],
  thu: [{ open: "09:00", close: "18:00" }],
  fri: [{ open: "09:00", close: "18:00" }],
  sat: [{ open: "09:00", close: "18:00" }],
  sun: [{ open: "09:00", close: "18:00" }],
};

// Monday 2026-11-16 12:00 PST. Next open day is Tuesday 2026-11-17.
const MON_NOON = new Date("2026-11-16T20:00:00Z");

function q(over: Partial<SlotQuery> = {}): SlotQuery {
  return {
    timeZone: TZ,
    businessHours: HOURS,
    durationMinutes: 30,
    bufferMinutes: 0,
    minNoticeMinutes: 0,
    gridMinutes: 15,
    busy: [],
    now: MON_NOON,
    ...over,
  };
}

const localTimes = (slots: { localStart: string }[]) => slots.map((s) => s.localStart.slice(11, 16));

describe("findFreeSlots", () => {
  it("returns starts inside business hours on the 15 minute grid, in local time", () => {
    const slots = findFreeSlots(q());
    expect(slots).toHaveLength(5);
    expect(slots[0]).toEqual({
      startAt: "2026-11-17T17:00:00.000Z",
      endAt: "2026-11-17T17:30:00.000Z",
      localStart: "2026-11-17T09:00:00-08:00",
      localEnd: "2026-11-17T09:30:00-08:00",
      timeZone: TZ,
    });
    expect(localTimes(slots)).toEqual(["09:00", "09:15", "09:30", "09:45", "10:00"]);
  });

  it("never offers a start outside hours or on a closed day", () => {
    const slots = findFreeSlots(q({ maxSlots: 1000, to: new Date("2026-11-18T08:00:00Z") }));
    // Only Tuesday is in the window. 09:00 to 17:30 inclusive is 35 starts.
    expect(slots).toHaveLength(35);
    expect(slots.every((s) => s.localStart.startsWith("2026-11-17"))).toBe(true);
    expect(localTimes(slots).at(0)).toBe("09:00");
    expect(localTimes(slots).at(-1)).toBe("17:30"); // ends exactly at close
  });

  it("returns nothing when the window covers only a closed day", () => {
    const slots = findFreeSlots(q({ to: new Date("2026-11-17T07:59:00Z") }));
    expect(slots).toEqual([]);
  });

  it("applies the buffer after the service against busy blocks", () => {
    // Busy Tuesday 10:00 to 11:00 PST.
    const busy = [{ start: "2026-11-17T18:00:00Z", end: "2026-11-17T19:00:00Z" }];
    const to = new Date("2026-11-17T20:00:00Z"); // Tuesday 12:00 PST
    const noBuffer = localTimes(findFreeSlots(q({ busy, to, maxSlots: 100 })));
    const withBuffer = localTimes(findFreeSlots(q({ busy, to, maxSlots: 100, bufferMinutes: 10 })));
    expect(noBuffer).toContain("09:30"); // 09:30 to 10:00 touches the block but does not overlap
    expect(withBuffer).not.toContain("09:30"); // 10:00 plus 10 min buffer overlaps
    expect(withBuffer).toContain("09:15"); // ends 09:45, buffer to 09:55
    expect(withBuffer).toContain("11:00"); // busy end is exclusive
    expect(withBuffer).not.toContain("10:45");
  });

  it("enforces the minimum notice and rounds up to the grid", () => {
    const now = new Date("2026-11-17T17:05:00Z"); // Tuesday 09:05 PST
    const slots = findFreeSlots(q({ now, minNoticeMinutes: 60 }));
    expect(localTimes(slots)[0]).toBe("10:15");
  });

  it("drops starts that a partly overlapping busy block touches", () => {
    // Busy Tuesday 09:40 to 09:50 PST.
    const busy = [{ start: new Date("2026-11-17T17:40:00Z"), end: new Date("2026-11-17T17:50:00Z") }];
    const slots = findFreeSlots(q({ busy }));
    expect(localTimes(slots)).toEqual(["09:00", "10:00", "10:15", "10:30", "10:45"]);
  });

  it("skips a fully booked day and moves to the next one", () => {
    const busy = [{ start: "2026-11-17T17:00:00Z", end: "2026-11-18T02:00:00Z" }]; // Tue 09:00 to 18:00
    const slots = findFreeSlots(q({ busy }));
    expect(slots[0]!.localStart).toBe("2026-11-18T09:00:00-08:00");
  });

  it("keeps 09:00 local on every day of a week that crosses the fall DST change", () => {
    const daily: BusinessHours = Object.fromEntries(
      ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, [{ open: "09:00", close: "09:30" }]]),
    );
    const now = new Date("2026-10-28T07:00:00Z"); // Wed 2026-10-28 00:00 PDT
    const slots = findFreeSlots(q({ businessHours: daily, now, maxSlots: 100 }));
    expect(slots.map((s) => s.localStart)).toEqual([
      "2026-10-28T09:00:00-07:00",
      "2026-10-29T09:00:00-07:00",
      "2026-10-30T09:00:00-07:00",
      "2026-10-31T09:00:00-07:00",
      "2026-11-01T09:00:00-08:00",
      "2026-11-02T09:00:00-08:00",
      "2026-11-03T09:00:00-08:00",
    ]);
    expect(slots[3]!.startAt).toBe("2026-10-31T16:00:00.000Z");
    expect(slots[4]!.startAt).toBe("2026-11-01T17:00:00.000Z");
  });

  it("keeps 09:00 local across the spring DST change", () => {
    const now = new Date("2026-03-07T08:00:00Z"); // Sat 2026-03-07 00:00 PST
    const hours: BusinessHours = { sat: [{ open: "09:00", close: "09:30" }], sun: [{ open: "09:00", close: "09:30" }] };
    const slots = findFreeSlots(q({ businessHours: hours, now, maxSlots: 10 }));
    expect(slots.map((s) => s.startAt)).toEqual(["2026-03-07T17:00:00.000Z", "2026-03-08T16:00:00.000Z"]);
    expect(slots[1]!.localStart).toBe("2026-03-08T09:00:00-07:00");
  });

  it("measures the service in real minutes on the night the clocks change", () => {
    // Open 00:00 to 04:00 on Sun 2026-11-01. 01:00 to 02:00 happens twice.
    const hours: BusinessHours = { sun: [{ open: "00:00", close: "04:00" }] };
    const now = new Date("2026-11-01T06:00:00Z"); // Sat 23:00 PDT
    const slots = findFreeSlots(q({ businessHours: hours, now, durationMinutes: 60, gridMinutes: 60, maxSlots: 10 }));
    const starts = slots.map((s) => Date.parse(s.startAt));
    // Strictly increasing, and every slot ends by 04:00 PST (12:00Z).
    for (let i = 1; i < starts.length; i++) expect(starts[i]!).toBeGreaterThan(starts[i - 1]!);
    expect(slots.every((s) => Date.parse(s.endAt) <= Date.parse("2026-11-01T12:00:00Z"))).toBe(true);
    expect(slots[0]!.localStart).toBe("2026-11-01T00:00:00-07:00");
  });

  it("caps the result at 5 by default and honors a smaller cap", () => {
    expect(findFreeSlots(q())).toHaveLength(5);
    expect(findFreeSlots(q({ maxSlots: 2 }))).toHaveLength(2);
    expect(findFreeSlots(q({ maxSlots: 0 }))).toEqual([]);
  });

  it("rejects bad input", () => {
    expect(() => findFreeSlots(q({ timeZone: "Mars/Olympus" }))).toThrow();
    expect(() => findFreeSlots(q({ durationMinutes: 0 }))).toThrow(/durationMinutes/);
    expect(() =>
      findFreeSlots(q({ businessHours: { tue: [{ open: "22:00", close: "02:00" }] } })),
    ).toThrow(/crosses midnight/);
  });
});

describe("zonedWallTimeToUtc", () => {
  it("maps a normal wall time in winter and summer", () => {
    expect(zonedWallTimeToUtc({ year: 2026, month: 1, day: 15, hour: 9, minute: 0, second: 0 }, TZ)).toBe(
      Date.parse("2026-01-15T17:00:00Z"),
    );
    expect(zonedWallTimeToUtc({ year: 2026, month: 7, day: 15, hour: 9, minute: 0, second: 0 }, TZ)).toBe(
      Date.parse("2026-07-15T16:00:00Z"),
    );
  });

  it("returns the earlier instant for a time that happens twice", () => {
    const t = zonedWallTimeToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 }, TZ);
    expect(t).toBe(Date.parse("2026-11-01T08:30:00Z"));
    expect(formatLocalIso(t, TZ)).toBe("2026-11-01T01:30:00-07:00");
  });

  it("shifts a time in the spring gap forward", () => {
    const t = zonedWallTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 }, TZ);
    expect(formatLocalIso(t, TZ)).toBe("2026-03-08T03:30:00-07:00");
  });
});
