/**
 * What useActivityFeed does with one Supabase Realtime insert on
 * activity_events, kept apart from React so it is unit tested.
 *
 * SPEC P-16: Realtime only tells the UI to refetch. So every row refetches
 * the queries it affects, whether or not it matches the contract:
 * - a row whose `type` is a known event type uses the invalidation map for that type;
 * - a row with an unknown or missing `type` refetches everything of the business.
 * Only a row that parses with the contract's activityEventFromRow is returned,
 * so only those go into the feed's `events` list.
 *
 * A row can have a known type and still fail to parse: status events written
 * before migration 0005 are stored as { subjectId, from, to }, and only the
 * REST activity route fills in orderId, bookingId and callId for them. Rows
 * the current server writes all parse (test/real-server/flows.test.ts).
 */
import type { QueryClient } from "@tanstack/react-query";
import { activityEventFromRow, ActivityEventTypeSchema, type ActivityEvent } from "@abos/contracts";
import { invalidateForEvent } from "./invalidation";
import { queryKeys } from "./query-keys";

type Warn = (message: string) => void;

/** Event types already warned about, so each unparsable type logs once. */
const warnedTypes = new Set<string>();

/** For tests: forget which types were warned about. */
export function resetRealtimeWarnings(): void {
  warnedTypes.clear();
}

function rowType(row: unknown): unknown {
  return row && typeof row === "object" ? (row as { type?: unknown }).type : undefined;
}

/** Refetches what the row affects and returns the parsed event, or null when the row does not match the contract. Never throws. */
export function handleRealtimeRow(
  queryClient: QueryClient,
  businessId: string,
  row: unknown,
  warn: Warn = (message) => console.warn(message),
): ActivityEvent | null {
  const type = ActivityEventTypeSchema.safeParse(rowType(row));
  if (type.success) {
    invalidateForEvent(queryClient, businessId, type.data);
  } else {
    void queryClient.invalidateQueries({ queryKey: ["api", "biz", businessId] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.liveAgent() });
  }

  try {
    return activityEventFromRow(row);
  } catch {
    const label = type.success ? type.data : "unknown type";
    if (!warnedTypes.has(label)) {
      warnedTypes.add(label);
      // The payload is left out on purpose: it is customer data.
      warn(`Realtime activity row of type ${label} does not match the contract. The UI refetched; the row is not shown in the live feed.`);
    }
    return null;
  }
}
