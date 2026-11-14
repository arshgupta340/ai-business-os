"use client";
/**
 * useActivityFeed(businessId): live ActivityEvents for one business.
 *
 * - Real mode: subscribes to Supabase Realtime postgres_changes INSERT on
 *   public.activity_events with filter business_id=eq.<businessId> (API.md
 *   section 1). The row arrives in snake_case and is mapped to ActivityEvent.
 * - Mock mode: receives events from the scripted mock timeline through the
 *   mock bridge. No MSW code is imported here.
 *
 * In both modes each event invalidates the queries it affects (SPEC P-16:
 * realtime tells the UI to refetch). The hook keeps only events received
 * since it mounted; use useActivity() for history.
 */
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ActivityEventSchema, type ActivityEvent } from "./pending-contracts";
import { isMockMode } from "./config";
import { subscribeMockActivity } from "./mock-bridge";
import { invalidateForEvent } from "./invalidation";

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

/** Map a raw activity_events row (snake_case) to an ActivityEvent. Returns null if it does not fit the contract. */
export function activityEventFromRow(row: Record<string, unknown>): ActivityEvent | null {
  const candidate = {
    id: row.id,
    businessId: row.business_id,
    type: row.type,
    correlationId: row.correlation_id,
    actorType: row.actor_type,
    occurredAt: row.occurred_at,
    payload: row.payload ?? row.payload_json ?? {},
  };
  const parsed = ActivityEventSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
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

    const onEvent = (event: ActivityEvent) => {
      setEvents((prev) => [event, ...prev.filter((e) => e.id !== event.id)].slice(0, limitRef.current));
      invalidateForEvent(queryClient, businessId, event.type);
    };

    if (mock) {
      setStatus("connected");
      return subscribeMockActivity(businessId, onEvent);
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
            const event = activityEventFromRow(change.new);
            if (event) onEvent(event);
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
