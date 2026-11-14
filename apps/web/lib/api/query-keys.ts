/**
 * Every React Query key in one place. Business-scoped keys start with
 * ["api", "biz", businessId, resource], so invalidating that prefix refreshes
 * every list and detail of the resource.
 */
import type {
  ActivityQuery,
  AgentsQuery,
  ApprovalsQuery,
  BookingsQuery,
  CallsQuery,
  FactsQuery,
  ListParams,
  OrdersQuery,
} from "./api-shapes";

export type Resource =
  | "business"
  | "facts"
  | "files"
  | "builder"
  | "agents"
  | "approvals"
  | "orders"
  | "bookings"
  | "activity"
  | "health"
  | "catalog"
  | "calls"
  | "telemetry";

const biz = (businessId: string, resource: Resource) => ["api", "biz", businessId, resource] as const;

export const queryKeys = {
  all: ["api"] as const,
  businesses: () => ["api", "businesses"] as const,
  liveAgent: () => ["api", "live-agent"] as const,

  resource: biz,
  business: (businessId: string) => [...biz(businessId, "business")] as const,
  facts: (businessId: string, query: FactsQuery = {}) => [...biz(businessId, "facts"), query] as const,
  file: (businessId: string, fileId: string) => [...biz(businessId, "files"), fileId] as const,
  builderSession: (businessId: string, sessionId: string) => [...biz(businessId, "builder"), sessionId] as const,

  agents: (businessId: string, query: AgentsQuery = {}) => [...biz(businessId, "agents"), "list", query] as const,
  agent: (businessId: string, agentId: string) => [...biz(businessId, "agents"), "detail", agentId] as const,
  agentVersions: (businessId: string, agentId: string, query: ListParams = {}) =>
    [...biz(businessId, "agents"), "versions", agentId, query] as const,

  approvals: (businessId: string, query: ApprovalsQuery = {}) => [...biz(businessId, "approvals"), "list", query] as const,
  approval: (businessId: string, approvalId: string) => [...biz(businessId, "approvals"), "detail", approvalId] as const,

  orders: (businessId: string, query: OrdersQuery = {}) => [...biz(businessId, "orders"), "list", query] as const,
  order: (businessId: string, orderId: string) => [...biz(businessId, "orders"), "detail", orderId] as const,
  orderCheckout: (businessId: string, orderId: string) => [...biz(businessId, "orders"), "checkout", orderId] as const,

  bookings: (businessId: string, query: BookingsQuery = {}) => [...biz(businessId, "bookings"), "list", query] as const,
  booking: (businessId: string, bookingId: string) => [...biz(businessId, "bookings"), "detail", bookingId] as const,

  activity: (businessId: string, query: ActivityQuery = {}) => [...biz(businessId, "activity"), query] as const,
  health: (businessId: string) => [...biz(businessId, "health")] as const,
  catalog: (businessId: string) => [...biz(businessId, "catalog")] as const,
  calls: (businessId: string, query: CallsQuery = {}) => [...biz(businessId, "calls"), "list", query] as const,
  call: (businessId: string, callId: string) => [...biz(businessId, "calls"), "detail", callId] as const,
  telemetry: (businessId: string, since?: string) => [...biz(businessId, "telemetry"), since ?? null] as const,
};

/**
 * The pending approvals query the sidebar badge and the Approvals inbox share,
 * so both read one cache entry: useApprovals(businessId, PENDING_APPROVALS_QUERY).
 */
export const PENDING_APPROVALS_QUERY = { state: "PENDING", limit: 200 } as const satisfies ApprovalsQuery;
