import type {
  ActionExecution,
  ActivityEvent,
  ApprovalRequest,
  Booking,
  BuilderSession,
  BusinessFact,
  Call,
  CatalogItem,
  FactConflict,
  FileRecord,
  IntegrationHealth,
  LiveAgent,
  MessageDispatch,
  Order,
} from "@/lib/api/pending-contracts";
import type { Agent, AgentVersion, Business } from "@/lib/api/api-shapes";

/** A sync_jobs row (DATA-MODEL.md). Not exposed by any endpoint; seen through sync.* events. */
export interface SyncJob {
  id: string;
  businessId: string;
  target: "google_sheets" | "catalog";
  recordType?: "order" | "booking";
  recordId?: string;
  status: "PENDING" | "RUNNING" | "DONE" | "RETRYING" | "FAILED";
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

/** An agent as stored. isLiveAgent and activeVersion are computed when served. */
export type AgentRecord = Omit<Agent, "isLiveAgent" | "activeVersion">;

export interface BuilderSessionRecord {
  /** session.messages is the message list. */
  session: BuilderSession;
  script: "restaurant_order_taker" | "appointment_booker" | "revise";
  step: number;
  progress: { answered: number; required: number };
}

export interface MockState {
  businesses: Business[];
  facts: BusinessFact[];
  conflicts: FactConflict[];
  files: FileRecord[];
  catalog: CatalogItem[];
  agents: AgentRecord[];
  versions: AgentVersion[];
  builderSessions: BuilderSessionRecord[];
  approvals: ApprovalRequest[];
  orders: Order[];
  bookings: Booking[];
  calls: Call[];
  executions: ActionExecution[];
  dispatches: MessageDispatch[];
  syncJobs: SyncJob[];
  activity: ActivityEvent[];
  liveAgent: LiveAgent;
  health: IntegrationHealth;
}

export const OWNER_USER_ID = "usr_owner_01";
export const PHONE_NUMBER = "+15555550199";
export const MESSAGE_CHANNEL = "surge" as const;
export const TIMEZONE = "America/Los_Angeles";
export const BARBER_CALENDAR_ID = "demo-barber@group.calendar.google.com";
