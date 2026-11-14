import type {
  ActionExecution,
  ActivityEvent,
  Agent,
  AgentVersion,
  ApprovalRequest,
  Booking,
  BuilderProgress,
  BuilderSession,
  Business,
  BusinessFact,
  Call,
  CatalogItem,
  FactConflict,
  FileRecord,
  IntegrationHealth,
  LiveAgent,
  MessageDispatch,
  Order,
  SyncJobState,
  SyncRecordType,
  SyncTarget,
} from "@abos/contracts";

/** A sync_jobs row (DATA-MODEL.md). Not exposed by any endpoint; seen through sync.* events. */
export interface SyncJob {
  id: string;
  businessId: string;
  target: SyncTarget;
  recordType?: SyncRecordType;
  recordId?: string;
  status: SyncJobState;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

/** An agent as stored. isLiveAgent and activeVersion are computed when served. */
export type AgentRecord = Omit<Agent, "isLiveAgent" | "activeVersion">;

export interface BuilderSessionRecord {
  /** session.messages is the message list. progress is kept beside it and added when served. */
  session: Omit<BuilderSession, "progress">;
  script: "restaurant_order_taker" | "appointment_booker" | "revise";
  step: number;
  progress: BuilderProgress;
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
