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
  SyncJob,
} from "@abos/contracts";

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

// The shared world's constants, under the names the mock already used.
export { OWNER_USER_ID, DEMO_PHONE_NUMBER as PHONE_NUMBER, BARBER_CALENDAR_ID } from "@abos/contracts/fixtures";
export { SEEDED_TIMEZONE as TIMEZONE } from "@abos/contracts";
/** The message channel of every seeded consenting customer. */
export const MESSAGE_CHANNEL = "surge" as const;
