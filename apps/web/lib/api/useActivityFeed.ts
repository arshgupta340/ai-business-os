"use client";
/**
 * useActivityFeed(businessId): live ActivityEvents for one business.
 *
 * - Real mode: subscribes to Supabase Realtime postgres_changes INSERT on
 *   public.activity_events with filter business_id=eq.<businessId> (API.md
 *   section 1). The row arrives in snake_case and is mapped to ActivityEvent
 *   with activityEventFromRow from @abos/contracts (see realtime-row.ts).
 *   Every row refetches what it affects; only a row that matches the
 *   contract is added to `events`.
 * - Mock mode: receives events from the scripted mock timeline through the
 *   mock bridge. No MSW code is imported here.
 *
 * In both modes each event invalidates the queries it affects (SPEC P-16:
 * realtime tells the UI to refetch). The hook keeps only events received
 * since it mounted; use useActivity() for history.
 */
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ActivityEvent } from "@abos/contracts";
import { isMockMode } from "./config";
import { subscribeMockActivity, subscribeMockReset } from "./mock-bridge";
import { invalidateForEvent } from "./invalidation";
import { handleRealtimeRow } from "./realtime-row";
import { queryKeys } from "./query-keys";

export type ActivityFeedStatus =
  /** Subscribing. */
  | "connecting"
  /** Receiving events. */
  | "connected"
  /** The channel dropped or failed. Data on screen may be stale. */
  | "disconnected"
  /** No Supabase settings, so no live updates. Screens still work on REST. */
  | "unavailable"
  /** No business selected. */
  | "idle";

export interface ActivityFeed {
  /** Events received since mount, newest first, at most `limit`. */
  events: ActivityEvent[];
  status: ActivityFeedStatus;
  /** "mock" when NEXT_PUBLIC_MOCK=1, otherwise "realtime". */
  source: "mock" | "realtime";
  lastEventAt?: string;
}

let channelCounter = 0;

export function useActivityFeed(businessId: string | null | undefined, options: { limit?: number } = {}): ActivityFeed {
  const limit = options.limit ?? 100;
  const queryClient = useQueryClient();
  const mock = isMockMode();
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [status, setStatus] = useState<ActivityFeedStatus>(businessId ? "connecting" : "idle");
  const limitRef = useRef(limit);
  limitRef.current = limit;

  useEffect(() => {
    setEvents([]);
    if (!businessId) {
      setStatus("idle");
      return;
    }

    const addEvent = (event: ActivityEvent) => {
      setEvents((prev) => [event, ...prev.filter((e) => e.id !== event.id)].slice(0, limitRef.current));
    };
    const onEvent = (event: ActivityEvent) => {
      addEvent(event);
      invalidateForEvent(queryClient, businessId, event.type);
    };

    if (mock) {
      setStatus("connected");
      const stopEvents = subscribeMockActivity(businessId, onEvent);
      // After the mock reset() control the held events describe data that no
      // longer exists, so drop them and refetch what is on screen.
      const stopReset = subscribeMockReset(() => {
        setEvents([]);
        void queryClient.invalidateQueries({ queryKey: queryKeys.all });
      });
      return () => {
        stopEvents();
        stopReset();
      };
    }

    let cancelled = false;
    let cleanup: (() => void) | undefined;
    setStatus("connecting");

    void (async () => {
      const [{ getSupabaseBrowserClient }, { getAccessToken }] = await Promise.all([
        import("@/lib/supabase/client"),
        import("@/lib/session/auth"),
      ]);
      const supabase = getSupabaseBrowserClient();
      if (!supabase) {
        if (!cancelled) setStatus("unavailable");
        return;
      }
      try {
        const token = await getAccessToken();
        if (token) await supabase.realtime.setAuth(token);
      } catch {
        // The channel still opens; row-level security decides what it receives.
      }
      if (cancelled) return;

      const channel = supabase
        .channel(`activity:${businessId}:${++channelCounter}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "activity_events", filter: `business_id=eq.${businessId}` },
          (change: { new: Record<string, unknown> }) => {
            // Every row refetches, parsed or not (SPEC P-16). Only parsed rows join the feed.
            const event = handleRealtimeRow(queryClient, businessId, change.new);
            if (event) addEvent(event);
          },
        )
        .subscribe((state: string) => {
          if (cancelled) return;
          if (state === "SUBSCRIBED") setStatus("connected");
          else if (state === "CHANNEL_ERROR" || state === "TIMED_OUT" || state === "CLOSED") setStatus("disconnected");
        });

      cleanup = () => {
        void supabase.removeChannel(channel);
      };
    })().catch(() => {
      if (!cancelled) setStatus("disconnected");
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [businessId, mock, queryClient]);

  return {
    events,
    status,
    source: mock ? "mock" : "realtime",
    lastEventAt: events[0]?.occurredAt,
  };
}
