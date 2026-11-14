/**
 * What to refetch when an ActivityEvent arrives (SPEC P-16: realtime tells
 * the UI to refetch). Used by useActivityFeed in both mock and real mode.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { ActivityEventType } from "./pending-contracts";
import { queryKeys, type Resource } from "./query-keys";

export interface InvalidationTarget {
  resources: Resource[];
  liveAgent?: boolean;
}

const MAP: Record<ActivityEventType, InvalidationTarget> = {
  "call.started": { resources: ["calls", "orders", "bookings"] },
  "call.ended": { resources: ["calls", "orders", "bookings"] },
  "proposal.created": { resources: ["calls", "orders", "bookings", "approvals"] },
  "approval.requested": { resources: ["approvals", "orders", "bookings", "facts"] },
  "approval.decided": { resources: ["approvals", "orders", "bookings", "facts"] },
  "approval.expired": { resources: ["approvals", "orders", "bookings", "facts"] },
  "execution.started": { resources: ["approvals", "orders", "bookings"] },
  "execution.succeeded": { resources: ["approvals", "orders", "bookings", "facts", "catalog"] },
  "execution.failed": { resources: ["approvals", "orders", "bookings", "facts", "catalog"] },
  "checkout.created": { resources: ["orders"] },
  "message.sent": { resources: ["orders", "bookings"] },
  "message.failed": { resources: ["orders", "bookings"] },
  "payment.verified": { resources: ["orders"] },
  "payment.failed": { resources: ["orders"] },
  "booking.verified": { resources: ["bookings"] },
  "booking.slot_conflict": { resources: ["bookings"] },
  "order.status_changed": { resources: ["orders", "calls"] },
  "booking.status_changed": { resources: ["bookings", "calls"] },
  "sync.queued": { resources: ["health"] },
  "sync.succeeded": { resources: ["health", "facts", "catalog"] },
  "sync.failed": { resources: ["health"] },
  "fact.changed": { resources: ["facts", "business", "agents", "catalog"] },
  "extraction.completed": { resources: ["files", "facts"] },
  "agent.published": { resources: ["agents"], liveAgent: true },
  "agent.paused": { resources: ["agents"], liveAgent: true },
  "live_agent.changed": { resources: ["agents"], liveAgent: true },
  "guardrail.refused": { resources: ["calls"] },
  "webhook.rejected": { resources: ["health"] },
};

export function invalidationFor(type: ActivityEventType): InvalidationTarget {
  return MAP[type] ?? { resources: [] };
}

/** Invalidate everything an event touches. The activity list is always refreshed. */
export function invalidateForEvent(queryClient: QueryClient, businessId: string, type: ActivityEventType): void {
  const target = invalidationFor(type);
  const resources = new Set<Resource>([...target.resources, "activity"]);
  for (const resource of resources) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.resource(businessId, resource) });
  }
  if (target.liveAgent) void queryClient.invalidateQueries({ queryKey: queryKeys.liveAgent() });
}
