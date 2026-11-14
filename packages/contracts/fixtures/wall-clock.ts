import { barberBusyBlocks, bookingAwaitingApproval, type BusyBlock } from './bookings';
import { orders } from './orders';
import { ISO_UTC_PATTERN, isoUtc } from './world';
import { SEEDED_TIMEZONE } from '../src/constants';

const DAY = 86400000;
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: SEEDED_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function parts(epoch: number): number[] {
  const p = Object.fromEntries(formatter.formatToParts(new Date(epoch)).map((x) => [x.type, x.value]));
  return [Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)];
}

function localEpoch(epoch: number): number {
  const [y = 0, m = 0, d = 1, h = 0, min = 0, s = 0] = parts(epoch);
  return Date.UTC(y, m, d, h, min, s);
}

function utcFromLocal(local: number): number {
  let epoch = local;
  for (let i = 0; i < 3; i++) epoch += local - localEpoch(epoch);
  return epoch;
}

/** One date per authored local day. Pending work must still be in the future. */
export function wallClockShifter(now: Date): (iso: string) => string {
  const target = now.getTime();
  const today = Math.floor(localEpoch(target) / DAY) * DAY;
  const dates = new Map<number, number>();
  const constraints = [
    { iso: bookingAwaitingApproval.startUtc, earliest: target + 120 * 60000 },
    ...orders.filter((o) => o.status === 'AWAITING_OWNER_APPROVAL').map((o) => ({ iso: o.fulfillment.pickupAt, earliest: target })),
  ];
  return (iso) => {
    const authored = localEpoch(Date.parse(iso));
    const day = Math.floor(authored / DAY) * DAY;
    let chosen = dates.get(day);
    if (chosen === undefined) {
      const weekday = new Date(day).getUTCDay();
      const candidates: number[] = [];
      for (let offset = -7; offset <= 14; offset++) {
        const candidate = today + offset * DAY;
        if (new Date(candidate).getUTCDay() !== weekday) continue;
        const suitable = constraints.every(({ iso: required, earliest }) => {
          const local = localEpoch(Date.parse(required));
          return Math.floor(local / DAY) * DAY !== day || utcFromLocal(candidate + local - day) > earliest;
        });
        if (suitable) candidates.push(candidate);
      }
      candidates.sort((a, b) => Math.abs(a - today) - Math.abs(b - today) || a - b);
      chosen = candidates[0];
      if (chosen === undefined) throw new RangeError('No suitable fixture date');
      dates.set(day, chosen);
    }
    const epoch = utcFromLocal(chosen + authored - day) + (Date.parse(iso) % 1000);
    return iso.includes('.') ? new Date(epoch).toISOString() : isoUtc(epoch);
  };
}

/** Shift only fields tied to opening hours; keep all other instants on the relative clock. */
export function shiftFixtureTimes(value: unknown, delta: number, wall: (iso: string) => string, key = ''): unknown {
  if (typeof value === 'string' && ISO_UTC_PATTERN.test(value)) {
    if (['pickupAt', 'startUtc', 'endUtc'].includes(key)) return wall(value);
    const epoch = Date.parse(value) + delta;
    return value.includes('.') ? new Date(epoch).toISOString() : isoUtc(epoch);
  }
  if (Array.isArray(value)) return value.map((v) => shiftFixtureTimes(v, delta, wall));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shiftFixtureTimes(v, delta, wall, k)]));
  return value;
}

/** The mock calendar uses the same date selection as materializeFixtures. */
export function materializeBusyBlocks(now: Date): BusyBlock[] {
  return shiftFixtureTimes(barberBusyBlocks, 0, wallClockShifter(now)) as BusyBlock[];
}
