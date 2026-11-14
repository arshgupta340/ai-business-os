// The fixture world moved to a chosen "now" (for the web mock, which needs PENDING approvals that are
// still live). Every timestamp shifts by one delta, so every gap between two times is unchanged, and
// every hash that covers a shifted timestamp is recomputed. Browser-safe: Web Crypto only.
import { approvalPayloadHash, type BundleType } from '../src/index';
import * as agents from './agents';
import * as approvals from './approvals';
import * as bookings from './bookings';
import * as calls from './calls';
import * as catalog from './catalog';
import * as executions from './executions';
import * as facts from './facts';
import * as operations from './operations';
import * as orders from './orders';
import * as responses from './responses';
import * as timelines from './timelines';
import * as world from './world';
import { FIXTURE_NOW, shiftIsoTimes } from './world';

/** The data exports of a fixture module: every export that is not a function. */
type DataOf<M> = { -readonly [K in keyof M as M[K] extends (...args: never[]) => unknown ? never : K]: M[K] };

/**
 * Every data export of the fixture modules under its export name, so `world.approvalOrderPending` is
 * the shifted copy of `approvalOrderPending`. `FIXTURE_NOW` is the requested time.
 */
export type FixtureWorld = DataOf<typeof world> &
  DataOf<typeof catalog> &
  DataOf<typeof facts> &
  DataOf<typeof agents> &
  DataOf<typeof calls> &
  DataOf<typeof orders> &
  DataOf<typeof bookings> &
  DataOf<typeof approvals> &
  DataOf<typeof executions> &
  DataOf<typeof timelines> &
  DataOf<typeof operations> &
  DataOf<typeof responses>;

const MODULES = [world, catalog, facts, agents, calls, orders, bookings, approvals, executions, timelines, operations, responses] as const;

function dataExports(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const mod of MODULES) {
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== 'function') out[name] = value;
    }
  }
  return out;
}

type ApprovalLike = { bundleType: BundleType; payload: Record<string, unknown>; payloadHash: string };

function isApprovalLike(value: Record<string, unknown>): value is ApprovalLike {
  return (
    typeof value.bundleType === 'string' &&
    typeof value.payloadHash === 'string' &&
    value.payload !== null &&
    typeof value.payload === 'object' &&
    !Array.isArray(value.payload)
  );
}

/** Every approval request anywhere in the tree (named exports, lists, API responses). */
function collectApprovals(value: unknown, found: ApprovalLike[]): void {
  if (Array.isArray(value)) {
    for (const v of value) collectApprovals(v, found);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const obj = value as Record<string, unknown>;
  if (isApprovalLike(obj)) found.push(obj);
  for (const v of Object.values(obj)) collectApprovals(v, found);
}

/** The local date (`YYYY-MM-DD`) of an instant in `timeZone`. */
function localDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/**
 * Returns a deep copy of the whole fixture world with every timestamp shifted by the same delta, so the
 * fixture "now" (`FIXTURE_NOW`, 2026-11-14T20:30:00Z) lands on `now`. Every approval's `payloadHash` is
 * recomputed, because payloads hold `expiresAt` and `pickupAt` or `startUtc`. Cart hashes and idempotency
 * keys have no time input, so they carry over unchanged. A PENDING approval created before the fixture
 * "now" and not yet expired then is live at `now` too. The original fixtures are not changed.
 */
export async function materializeFixtures(now: Date): Promise<FixtureWorld> {
  const target = now.getTime();
  if (!Number.isFinite(target)) throw new RangeError('materializeFixtures: invalid date');
  const deltaMs = target - Date.parse(FIXTURE_NOW);
  const out = shiftIsoTimes(dataExports(), deltaMs) as FixtureWorld;

  const found: ApprovalLike[] = [];
  collectApprovals(out, found);
  await Promise.all(
    found.map(async (a) => {
      a.payloadHash = await approvalPayloadHash(a.bundleType, a.payload);
    }),
  );

  // The demo appointment day is a local date, not an instant: recompute it from the shifted booking.
  out.BOOKING_DEMO_DATE = localDate(out.bookingVerified.startUtc, out.bookingVerified.timezone);
  return out;
}
