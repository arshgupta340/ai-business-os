/**
 * In-memory mock database, seeded from the shared demo world in
 * @abos/contracts/fixtures (see ./seed). It enforces the rules the
 * real server enforces (API.md section 3) and runs the scripted follow-up
 * after an approval, on timers from ./scheduler. Every change that the real
 * server would log writes an ActivityEvent and publishes it to the mock
 * bridge, which useActivityFeed reads in mock mode.
 *
 * Nothing here is ever marked sent, paid or booked unless the scripted
 * provider step that confirms it has run. All payment data is sandbox.
 */
import {
  ACTION_TYPE_CAPABILITY,
  AgentSpecSchema,
  APPROVAL_EXPIRY_MS,
  BUNDLE_ACTIONS,
  CAPABILITIES,
  canonicalJson,
  idempotencyKey,
  isCapabilityId,
  isDeferredActionType,
  payloadHash,
  type ActionExecution,
  type ActionType,
  type ActivityEvent,
  type ActivityEventPayloads,
  type ActivityEventType,
  type ActorType,
  type Agent,
  type AgentSpec,
  type AgentVersion,
  type ApprovalRequest,
  type Booking,
  type BookingMachineState,
  type BookingStatus,
  type BusinessFact,
  type Call,
  type CallStage,
  type CapabilityId,
  type DraftAgentSpec,
  type ErrorCode,
  type ExecutionActionType,
  type FactConflict,
  type FactKind,
  type FileRecord,
  type JsonValue,
  type Order,
  type OrderMachineState,
  type OrderStatus,
  type ProposeFactBody,
} from "@abos/contracts";
import { publishMockActivity } from "@/lib/api/mock-bridge";
import {
  bookingApproval,
  buildOrder,
  buildQuote,
  catalogRowId,
  factEditApproval,
  iso,
  last4,
  makeEvent,
  MINUTE,
  newId,
  orderApproval,
  priceEditApproval,
  sandboxCheckoutUrl,
} from "./builders";
import {
  businesses as SHARED_BUSINESSES,
  integrationHealthDisconnected,
  materializeBusyBlocks,
  orderFulfilled,
  serviceHaircut,
  telemetry as sharedTelemetry,
} from "@abos/contracts/fixtures";
import { buildSeed, emptyState } from "./seed";
import { cancel, cancelAllScheduled, schedule, timing } from "./scheduler";
import { BARBER_CALENDAR_ID, MESSAGE_CHANNEL, OWNER_USER_ID, TIMEZONE, type AgentRecord, type MockState } from "./types";

// ------------------------------------------------------------------ errors

export class MockHttpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const fail = (code: ErrorCode, message: string, details?: Record<string, unknown>): never => {
  throw new MockHttpError(code, message, details);
};

// ------------------------------------------------------------------- state

/**
 * Empty until the first seed finishes. The contract's hash functions are async,
 * so seeding is too; the handlers await ready() before they read the state.
 */
let state: MockState = emptyState();
let seeding: Promise<void> = Promise.resolve();

/** Resolves once the current seed (start or reset) is in place. */
export function ready(): Promise<void> {
  return seeding;
}

// ------------------------------------------- builder sessions across reload

/**
 * In the browser mock, builder sessions (and nothing else) are kept in
 * sessionStorage, so a reload of /build resumes the session. Every other row
 * still lives in memory and goes back to the fixtures on reload. The node
 * test server turns this off (mocks/server.ts), and it is off wherever there
 * is no service worker API (jsdom, node).
 */
export const BUILDER_SESSIONS_STORAGE_KEY = "abos.mock.builderSessions";

type SessionStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultSessionStore(): SessionStore | null {
  if (typeof window === "undefined" || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

let sessionStore: SessionStore | null = defaultSessionStore();

/** Set where builder sessions persist. null turns persistence off. Tests pass a memory store. */
export function setBuilderSessionStore(store: SessionStore | null): void {
  sessionStore = store;
}

/** Write the builder sessions to the store, if one is set. The handlers call this after every request. */
export function saveBuilderSessions(): void {
  if (!sessionStore) return;
  try {
    sessionStore.setItem(BUILDER_SESSIONS_STORAGE_KEY, JSON.stringify(state.builderSessions));
  } catch {
    // Storage full or blocked. Sessions then last until the next reload only.
  }
}

/** Read builder sessions back from the store into the current state. Unknown or malformed data is ignored. */
export function restoreBuilderSessions(): void {
  if (!sessionStore) return;
  try {
    const raw = sessionStore.getItem(BUILDER_SESSIONS_STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    const known = new Set(state.builderSessions.map((r) => r.session.id));
    for (const rec of parsed as MockState["builderSessions"]) {
      if (rec && rec.session && typeof rec.session.id === "string" && !known.has(rec.session.id)) {
        state.builderSessions.push(rec);
      }
    }
  } catch {
    // Ignore what cannot be read.
  }
}

seeding = buildSeed().then((seed) => {
  state = seed;
  restoreBuilderSessions();
});

interface Flags {
  nextPaymentFails: boolean;
  nextSyncRetries: boolean;
  /** The next uploaded file fails extraction. */
  nextExtractionFails: boolean;
  /** The next catalog sync fails. */
  nextCatalogSyncFails: boolean;
  /** The next pizza call is proposed with messageChannel "qr_only". */
  nextCallQrOnly: boolean;
}
const flags: Flags = {
  nextPaymentFails: false,
  nextSyncRetries: false,
  nextExtractionFails: false,
  nextCatalogSyncFails: false,
  nextCallQrOnly: false,
};
/** Businesses emptied by the simulateEmptyBusiness control, until reset. */
const emptyBusinesses = new Set<string>();

/** One rule of the simulateRequestFailure control. */
export interface RequestFailureRule {
  /** Matches when the request path (for example "/api/calls") starts with this. */
  path: string;
  /** HTTP method to match. Default GET. */
  method?: string;
  /** "error" answers with the API error envelope; "invalid" answers 200 with a body that does not match the contract. */
  mode?: "error" | "invalid";
  /** The error code for mode "error". Default INTERNAL (retryable). */
  code?: ErrorCode;
  /** The message for mode "error". */
  message?: string;
  /** How many matching requests fail. Default: every one until reset() or clearRequestFailures(). */
  times?: number;
}
const requestFailures: RequestFailureRule[] = [];

/** Mock control: the requests the rule matches fail until reset. */
export function addRequestFailure(rule: RequestFailureRule): void {
  requestFailures.push({ ...rule });
}

export function clearRequestFailures(): void {
  requestFailures.length = 0;
}

/**
 * The failure a request should get, if a rule matches. Spends one of the
 * rule's `times`. The handler calls it before the route runs.
 */
export function takeRequestFailure(method: string, pathname: string): RequestFailureRule | null {
  const index = requestFailures.findIndex(
    (r) => (r.method ?? "GET").toUpperCase() === method.toUpperCase() && pathname.startsWith(r.path),
  );
  if (index < 0) return null;
  const rule = requestFailures[index];
  if (rule.times !== undefined) {
    rule.times -= 1;
    if (rule.times <= 0) requestFailures.splice(index, 1);
  }
  return rule;
}

/**
 * Mock control: one business has nothing yet. Its agents, versions, calls,
 * orders, bookings, approvals, executions, messages, sync jobs, activity,
 * facts, conflicts, files, catalog and builder sessions are removed until
 * reset(). The business itself stays, so it is still in the selector.
 */
export function emptyBusiness(businessId: string): void {
  requireBusiness(businessId);
  emptyBusinesses.add(businessId);
  const other = <T extends { businessId: string }>(rows: T[]) => rows.filter((r) => r.businessId !== businessId);
  const agentIds = new Set(state.agents.filter((a) => a.businessId === businessId).map((a) => a.id));
  state = {
    ...state,
    facts: other(state.facts),
    conflicts: other(state.conflicts),
    files: other(state.files),
    catalog: other(state.catalog),
    agents: other(state.agents),
    versions: state.versions.filter((v) => !agentIds.has(v.agentId)),
    builderSessions: state.builderSessions.filter((s) => s.session.businessId !== businessId),
    approvals: other(state.approvals),
    orders: other(state.orders),
    bookings: other(state.bookings),
    calls: other(state.calls),
    executions: other(state.executions),
    dispatches: other(state.dispatches),
    syncJobs: other(state.syncJobs),
    activity: other(state.activity),
  };
  if (state.liveAgent.businessId === businessId || (state.liveAgent.agentId && agentIds.has(state.liveAgent.agentId))) {
    state.liveAgent = { phoneNumber: state.liveAgent.phoneNumber, businessId, updatedAt: nowIso() };
  }
}

export function isEmptyBusiness(businessId: string): boolean {
  return emptyBusinesses.has(businessId);
}

/** Files whose scripted extraction ends in FAILED. */
const failingExtractions = new Set<string>();

/** Scripted payment timers by order id, so a control can fail a payment instead. */
const paymentTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Bookings whose scripted calendar recheck finds the slot taken. */
const slotConflictBookings = new Set<string>();
/** fact_edit approvals that resolve a conflict when approved. */
const conflictByApproval = new Map<string, string>();
/** Square object versions per variation, for price_edit. */
const squareVersions = new Map<string, number>();
/** Mock test console sessions. Kept apart from state on purpose: the test console never writes. */
const testSessions = new Map<string, { businessId: string; agentId: string; turns: number }>();
/** Replay store for POST /api/approvals/:id/decision with an Idempotency-Key. */
const idempotency = new Map<string, { bodyKey: string; status: number; body: unknown }>();

export function getState(): MockState {
  return state;
}

export async function resetDb(now: number = Date.now()): Promise<void> {
  cancelAllScheduled();
  paymentTimers.clear();
  slotConflictBookings.clear();
  conflictByApproval.clear();
  squareVersions.clear();
  testSessions.clear();
  idempotency.clear();
  flags.nextPaymentFails = false;
  flags.nextSyncRetries = false;
  flags.nextExtractionFails = false;
  flags.nextCatalogSyncFails = false;
  flags.nextCallQrOnly = false;
  failingExtractions.clear();
  emptyBusinesses.clear();
  requestFailures.length = 0;
  clockOffsetMs = 0;
  seeding = buildSeed(now).then((seed) => {
    state = seed;
    saveBuilderSessions();
  });
  await seeding;
}

export function setFlag(name: keyof Flags, value: boolean): void {
  flags[name] = value;
}

const nowIso = () => iso(Date.now());

/**
 * Tests only: how far the mock's expiry clock runs ahead of real time. An
 * approval's createdAt, expiresAt and payload.expiresAt are tied together by
 * the contract (and expiresAt is hashed), so tests move the clock instead of
 * editing expiresAt. Reset to 0 by resetDb().
 */
let clockOffsetMs = 0;
const expiryNow = () => Date.now() + clockOffsetMs;

/** Tests only: move the mock's expiry clock forward by `ms`. */
export function advanceMockClock(ms: number): void {
  clockOffsetMs += ms;
}

/**
 * Tests only: re-create a pending approval as if it had been made so that it
 * expires at `expiresAtMs`. Moves createdAt, expiresAt and payload.expiresAt
 * together and stores the new payload hash, like a fresh approval would have.
 */
export async function setApprovalExpiry(approvalId: string, expiresAtMs: number): Promise<void> {
  const apv = state.approvals.find((a) => a.id === approvalId);
  if (!apv || apv.state !== "PENDING") return;
  apv.createdAt = iso(expiresAtMs - APPROVAL_EXPIRY_MS);
  apv.expiresAt = iso(expiresAtMs);
  apv.payload = { ...apv.payload, expiresAt: apv.expiresAt } as ApprovalRequest["payload"];
  apv.payloadHash = await payloadHash(apv.payload, apv.bundleType);
}

export function emit<T extends ActivityEventType>(
  businessId: string,
  type: T,
  correlationId: string,
  actorType: ActorType,
  payload: ActivityEventPayloads[T],
): ActivityEvent {
  const event = makeEvent(businessId, type, correlationId, actorType, Date.now(), payload);
  state.activity.push(event);
  publishMockActivity(event);
  return event;
}

// --------------------------------------------------------------- scoping

/** The seeded owner owns both shared businesses. */
const OWNER_BUSINESSES: string[] = SHARED_BUSINESSES.map((b) => b.id);

/** The cart of the shared pizza timeline (CONTRACTS 9): Large Margherita with Mushrooms, Large Pepperoni. Total 4731. */
export const TIMELINE_CART = orderFulfilled.cart;

/** FORBIDDEN_BUSINESS unless the seeded owner owns it (API.md section 1). */
export function requireBusiness(businessId: string | null | undefined): string {
  if (!businessId) fail("VALIDATION_FAILED", "businessId is required.", { issues: [{ path: "businessId", message: "Required" }] });
  if (!OWNER_BUSINESSES.includes(businessId!)) fail("FORBIDDEN_BUSINESS", "You do not own this business.");
  return businessId!;
}

function inBusiness<T extends { businessId: string; id?: string }>(rows: T[], businessId: string, id: string, what: string): T {
  const row = rows.find((r) => (r as { id?: string }).id === id && r.businessId === businessId);
  if (!row) fail("NOT_FOUND", `${what} not found.`);
  return row!;
}

// ------------------------------------------------------------ pagination

export function paginate<T>(rows: T[], limit?: number, cursor?: string | null): { items: T[]; nextCursor?: string } {
  const lim = limit ?? 50;
  if (!Number.isInteger(lim) || lim < 1 || lim > 200) {
    fail("VALIDATION_FAILED", "limit must be between 1 and 200.", { issues: [{ path: "limit", message: "Out of range" }] });
  }
  let offset = 0;
  if (cursor) {
    const m = /^c(\d+)$/.exec(cursor);
    if (!m) fail("VALIDATION_FAILED", "cursor is not valid.", { issues: [{ path: "cursor", message: "Invalid" }] });
    offset = Number(m![1]);
  }
  const items = rows.slice(offset, offset + lim);
  const next = offset + lim < rows.length ? `c${offset + lim}` : undefined;
  return next ? { items, nextCursor: next } : { items };
}

const newestFirst = <T extends { createdAt?: string; occurredAt?: string; startedAt?: string }>(a: T, b: T) =>
  (b.createdAt ?? b.occurredAt ?? b.startedAt ?? "").localeCompare(a.createdAt ?? a.occurredAt ?? a.startedAt ?? "");

// ---------------------------------------------------------------- expiry

/** Moves PENDING approvals past expiresAt to EXPIRED, like the server's job (API.md 3.7). */
export function sweepExpired(now: number = expiryNow()): void {
  for (const apv of state.approvals) {
    if (apv.state !== "PENDING" || Date.parse(apv.expiresAt) > now) continue;
    apv.state = "EXPIRED";
    // DATA-MODEL 2.14: decidedAt is set on every state but PENDING; an expiry has no decidedBy.
    apv.decidedAt = iso(now);
    emit(apv.businessId, "approval.expired", correlationFor(apv), "system", { approvalId: apv.id, subjectId: apv.subjectId });
    if (apv.bundleType === "order_bundle") {
      const order = state.orders.find((o) => o.id === apv.subjectId);
      if (order && order.status === "AWAITING_OWNER_APPROVAL") setOrderStatus(order, "APPROVAL_EXPIRED");
    } else if (apv.bundleType === "booking_bundle") {
      const booking = state.bookings.find((b) => b.id === apv.subjectId);
      if (booking && booking.status === "AWAITING_OWNER_APPROVAL") setBookingStatus(booking, "EXPIRED");
    } else if (apv.bundleType === "fact_edit") {
      const draft = state.facts.find((f) => f.id === apv.subjectId);
      if (draft && draft.status === "draft") draft.status = "superseded";
    }
  }
}

function correlationFor(apv: ApprovalRequest): string {
  if (apv.bundleType === "order_bundle") return state.orders.find((o) => o.id === apv.subjectId)?.callId ?? apv.id;
  if (apv.bundleType === "booking_bundle") return state.bookings.find((b) => b.id === apv.subjectId)?.callId ?? apv.id;
  return apv.id;
}

// ------------------------------------------------------- status helpers

function setOrderStatus(order: Order, to: OrderStatus): void {
  const from = order.status;
  order.status = to;
  order.updatedAt = nowIso();
  emit(order.businessId, "order.status_changed", order.callId, "system", { orderId: order.id, callId: order.callId, from, to });
}

function setBookingStatus(booking: Booking, to: BookingStatus): void {
  const from = booking.status;
  booking.status = to;
  booking.updatedAt = nowIso();
  emit(booking.businessId, "booking.status_changed", booking.callId ?? booking.id, "system", {
    bookingId: booking.id,
    callId: booking.callId,
    from,
    to,
  });
}

// ------------------------------------------------------------ businesses

export function listBusinesses() {
  return state.businesses.map(({ id, name, category, timezone }) => ({ id, name, category, timezone }));
}

export function getBusiness(businessId: string) {
  return state.businesses.find((b) => b.id === businessId) ?? fail("NOT_FOUND", "Business not found.");
}

export function updateBusiness(businessId: string, body: Record<string, unknown>) {
  const allowed = ["name", "contact", "settings"];
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) {
    fail("VALIDATION_FAILED", "Only name, contact and settings can change here. Facts change through facts/propose.", {
      issues: extra.map((path) => ({ path, message: "Not allowed" })),
    });
  }
  const biz = getBusiness(businessId);
  if (typeof body.name === "string") biz.name = body.name;
  if (body.contact && typeof body.contact === "object") biz.contact = { ...biz.contact, ...(body.contact as object) };
  if (body.settings && typeof body.settings === "object") biz.settings = { ...biz.settings, ...(body.settings as object) };
  biz.updatedAt = nowIso();
  return biz;
}

// ----------------------------------------------------------------- facts

export function listFacts(businessId: string, kind?: string | null, status?: string | null) {
  const items = state.facts.filter(
    (f) => f.businessId === businessId && (!kind || f.kind === kind) && (status ? f.status === status : f.status !== "superseded"),
  );
  const conflicts = state.conflicts.filter((c) => c.businessId === businessId && c.state === "open");
  return { items, conflicts };
}

function verifiedFact(businessId: string, kind: FactKind, key: string): BusinessFact | undefined {
  return state.facts.find((f) => f.businessId === businessId && f.kind === kind && f.key === key && f.status === "verified");
}

/**
 * POST /api/businesses/:id/facts/propose. Stores the value as a draft fact and
 * creates a fact_edit approval with actorType owner. Nothing changes until approved.
 */
export async function proposeFact(businessId: string, body: ProposeFactBody, sourceType: BusinessFact["sourceType"] = "owner_ui") {
  let kind: FactKind;
  let key: string;
  let conflict: FactConflict | undefined;
  if ("resolvesConflictId" in body) {
    conflict = inBusiness(state.conflicts, businessId, body.resolvesConflictId, "Conflict");
    if (conflict.state !== "open") fail("INVALID_STATE", "This conflict is already resolved.", { state: conflict.state });
    if (conflict.kind === "menu_item") {
      fail("VALIDATION_FAILED", "A menu price from a file never overwrites Square. Keep the Square price, or propose a price change.", {
        issues: [{ path: "resolvesConflictId", message: "Use catalog/prices/propose for prices" }],
      });
    }
    kind = conflict.kind;
    key = conflict.key;
  } else {
    kind = body.kind;
    key = body.key;
    if (kind === "menu_item") {
      fail("VALIDATION_FAILED", "menu_item facts come only from uploads.", { issues: [{ path: "kind", message: "Not allowed" }] });
    }
  }
  const current = verifiedFact(businessId, kind, key);
  const at = Date.now();
  const draft: BusinessFact = {
    id: newId("fact_"),
    businessId,
    kind,
    key,
    value: body.value,
    sourceType,
    status: "draft",
    confidence: 1,
    // The proposed edit is the next version; drafts never have version 0 (BusinessFact.version is at least 1).
    version: (current?.version ?? 0) + 1,
    createdAt: iso(at),
    updatedAt: iso(at),
  };
  state.facts.push(draft);
  const approval = await factEditApproval({
    id: newId("apv_"),
    businessId,
    subjectId: draft.id,
    kind,
    key,
    fromVersion: current?.version ?? 0,
    before: current ? current.value : null,
    after: body.value,
    at,
  });
  state.approvals.push(approval);
  if (conflict) conflictByApproval.set(approval.id, conflict.id);
  emit(businessId, "approval.requested", approval.id, "owner", {
    approvalId: approval.id,
    bundleType: "fact_edit",
    subjectId: draft.id,
    actionBundle: approval.actionBundle,
    expiresAt: approval.expiresAt,
  });
  return { approval };
}

/** POST /api/conflicts/:id/resolve with keep_authoritative. No approval: nothing external is written. */
export function resolveConflict(businessId: string, conflictId: string, resolution: unknown) {
  if (resolution !== "keep_authoritative") {
    fail("VALIDATION_FAILED", 'resolution must be "keep_authoritative".', { issues: [{ path: "resolution", message: "Invalid" }] });
  }
  const conflict = inBusiness(state.conflicts, businessId, conflictId, "Conflict");
  if (conflict.state !== "open") fail("INVALID_STATE", "This conflict is already resolved.", { state: conflict.state });
  for (const c of conflict.candidates) {
    if ((c.sourceType === "upload" || c.sourceType === "owner_chat") && c.factId) {
      const f = state.facts.find((x) => x.id === c.factId);
      if (f && f.status === "draft") {
        f.status = "superseded";
        f.updatedAt = nowIso();
      }
    }
  }
  const authority = conflict.candidates.find((c) => c.sourceType !== "upload" && c.sourceType !== "owner_chat");
  conflict.state = "resolved";
  conflict.resolvedBy = OWNER_USER_ID;
  conflict.resolvedAt = nowIso();
  if (authority?.factId) conflict.resolvedFactId = authority.factId;
  // Like the shared factConflictResolvedEvent: keeping the authority supersedes the draft without a new fact version.
  const draftId = conflict.candidates.find((c) => c.sourceType === "upload" || c.sourceType === "owner_chat")?.factId;
  const draft = draftId ? state.facts.find((f) => f.id === draftId) : undefined;
  if (draft) {
    emit(businessId, "fact.changed", conflict.id, "owner", {
      factId: draft.id,
      kind: draft.kind,
      key: draft.key,
      fromVersion: draft.version,
      toVersion: draft.version,
      sourceType: draft.sourceType,
      resolvedConflictId: conflict.id,
    });
  }
  return { conflict };
}

// --------------------------------------------------------------- catalog

export function getCatalog(businessId: string) {
  const items = state.catalog.filter((c) => c.businessId === businessId);
  const syncedAt = items.map((i) => i.syncedAt).sort().at(-1) ?? nowIso();
  return { items, syncedAt };
}

export function syncCatalog(businessId: string) {
  const jobId = newId("job_");
  emit(businessId, "sync.queued", jobId, "system", { target: "catalog", jobId });
  if (flags.nextCatalogSyncFails) {
    flags.nextCatalogSyncFails = false;
    // Square did not answer. The stored catalog and syncedAt stay as they were.
    schedule(() => {
      emit(businessId, "sync.failed", jobId, "system", { target: "catalog", jobId, attempts: 1, final: true });
    }, timing.stepMs);
    return { jobId };
  }
  schedule(() => {
    const at = nowIso();
    for (const item of state.catalog) if (item.businessId === businessId) item.syncedAt = at;
    emit(businessId, "sync.succeeded", jobId, "system", { target: "catalog", jobId });
  }, timing.stepMs);
  return { jobId };
}

export async function proposePrice(businessId: string, body: { variationId?: string; newPriceMinor?: number; currency?: string }) {
  if (!body.variationId || !Number.isInteger(body.newPriceMinor) || (body.newPriceMinor as number) < 0 || body.currency !== "USD") {
    fail("VALIDATION_FAILED", "variationId, a whole newPriceMinor and currency USD are required.", {
      issues: [{ path: "newPriceMinor", message: "Invalid" }],
    });
  }
  const item = state.catalog.find((c) => c.businessId === businessId && c.variations.some((v) => v.id === body.variationId));
  if (!item) fail("NOT_FOUND", "Variation not found.");
  const version = squareVersions.get(body.variationId!) ?? 3;
  squareVersions.set(body.variationId!, version);
  const approval = await priceEditApproval({
    id: newId("apv_"),
    businessId,
    item: item!,
    variationId: body.variationId!,
    newPriceMinor: body.newPriceMinor!,
    squareVersion: version,
    at: Date.now(),
  });
  state.approvals.push(approval);
  emit(businessId, "approval.requested", approval.id, "owner", {
    approvalId: approval.id,
    bundleType: "price_edit",
    subjectId: approval.subjectId,
    actionBundle: approval.actionBundle,
    expiresAt: approval.expiresAt,
  });
  return { approval };
}

// ----------------------------------------------------------------- files

export const ACCEPTED_MIME = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export async function createFile(businessId: string, input: { name: string; mime: string; size: number; bytes: Uint8Array }): Promise<FileRecord> {
  if (!(ACCEPTED_MIME as readonly string[]).includes(input.mime)) {
    fail("VALIDATION_FAILED", "This file type is not accepted. Upload a PDF, image, CSV or spreadsheet.", {
      issues: [{ path: "file", message: `Type ${input.mime || "unknown"} is not accepted` }],
    });
  }
  if (input.size < 1) {
    // FileRecord.sizeBytes is at least 1, so an empty file cannot be stored.
    fail("VALIDATION_FAILED", "The file is empty.", { issues: [{ path: "file", message: "Empty file" }] });
  }
  if (input.size > MAX_UPLOAD_BYTES) {
    fail("VALIDATION_FAILED", "The file is larger than 10 MB.", { issues: [{ path: "file", message: "Larger than 10 MB" }] });
  }
  const file: FileRecord = {
    id: newId("file_"),
    businessId,
    name: input.name,
    mime: input.mime as FileRecord["mime"],
    sizeBytes: input.size,
    sha256: await fileSha256(input.bytes),
    extractionState: "PENDING",
    draftFactIds: [],
    createdAt: nowIso(),
  };
  state.files.push(file);
  if (flags.nextExtractionFails) {
    flags.nextExtractionFails = false;
    failingExtractions.add(file.id);
  }
  schedule(() => {
    file.extractionState = "EXTRACTING";
    schedule(() => (failingExtractions.has(file.id) ? failExtraction(file) : finishExtraction(file)), timing.extractionMs);
  }, timing.extractionStartMs);
  return file;
}

/** DATA-MODEL files.sha256: "sha256:" plus the hex SHA-256 of the file bytes. */
async function fileSha256(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return `sha256:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Mock control outcome: the file could not be read, so it has no drafts and no conflicts. */
function failExtraction(file: FileRecord): void {
  failingExtractions.delete(file.id);
  file.extractionState = "FAILED";
  file.draftFactIds = [];
  file.conflictIds = [];
  emit(file.businessId, "extraction.completed", file.id, "system", {
    fileId: file.id,
    mime: file.mime,
    extractionState: "FAILED",
    draftFactCount: 0,
    conflictCount: 0,
  });
}

function finishExtraction(file: FileRecord): void {
  const at = Date.now();
  const drafts: BusinessFact[] = [];
  const conflicts: FactConflict[] = [];
  const draft = (kind: FactKind, key: string, value: JsonValue, confidence: number): BusinessFact => ({
    id: newId("fact_"),
    businessId: file.businessId,
    kind,
    key,
    value,
    sourceType: "upload",
    fileId: file.id,
    status: "draft",
    confidence,
    version: 1,
    createdAt: iso(at),
    updatedAt: iso(at),
  });
  // What the scripted extractor "reads" has no shared fixture (the shared world holds only finished
  // uploads). The drafts follow the shared shapes: a menu_item value is { itemName, variationName,
  // priceMinor, currency } keyed like "margherita_large", and a price conflict names the Square row.
  if (file.businessId === "biz_pizza_01") {
    const menuDraft = (itemId: string, variationId: string, delta: number, confidence: number) => {
      const item = state.catalog.find((c) => c.squareItemId === itemId);
      const variation = item?.variations.find((v) => v.id === variationId);
      if (!item || !variation) return null;
      const key = `${item.name}_${variation.name}`.toLowerCase().replace(/\s+/g, "_");
      const value = { itemName: item.name, variationName: variation.name, priceMinor: variation.priceMinor + delta, currency: variation.currency };
      return { fact: draft("menu_item", key, value, confidence), variation };
    };
    const [margItem, pepItem] = [state.catalog[0], state.catalog[1]];
    const same = pepItem && menuDraft(pepItem.squareItemId, pepItem.variations[1].id, 0, 0.88);
    const higher = margItem && menuDraft(margItem.squareItemId, margItem.variations[0].id, 100, 0.74);
    for (const d of [same, higher]) if (d) drafts.push(d.fact);
    if (higher) {
      const open = state.conflicts.some((c) => c.businessId === file.businessId && c.key === higher.fact.key && c.state === "open");
      if (!open) {
        const uploaded = (higher.fact.value as { priceMinor: number }).priceMinor;
        conflicts.push({
          id: newId("cfl_"),
          businessId: file.businessId,
          kind: "menu_item",
          key: higher.fact.key,
          required: true,
          candidates: [
            { factId: higher.fact.id, sourceType: "upload", sourceRef: `${file.name} page 1`, value: { priceMinor: uploaded, variationId: higher.variation.id } },
            { sourceType: "square", sourceRef: catalogRowId(higher.variation.id), value: { priceMinor: higher.variation.priceMinor, variationId: higher.variation.id } },
          ],
          state: "open",
          createdAt: iso(at),
        });
      }
    }
  } else {
    drafts.push(
      draft(
        "service",
        "svc_shave",
        { id: "svc_shave", businessId: file.businessId, name: "Hot towel shave", durationMinutes: 30, priceMinor: 3500, currency: "USD" },
        0.66,
      ),
      draft("faq", "gift_cards", { question: "Do you sell gift cards?", answer: "Yes, at the front desk." }, 0.81),
    );
  }
  state.facts.push(...drafts);
  state.conflicts.push(...conflicts);
  file.extractionState = "EXTRACTED";
  file.draftFactIds = drafts.map((d) => d.id);
  file.conflictIds = conflicts.map((c) => c.id);
  emit(file.businessId, "extraction.completed", file.id, "system", {
    fileId: file.id,
    mime: file.mime,
    extractionState: "EXTRACTED",
    draftFactCount: drafts.length,
    conflictCount: conflicts.length,
  });
}

export function getFile(businessId: string, fileId: string): FileRecord {
  return inBusiness(state.files, businessId, fileId, "File");
}

// ---------------------------------------------------------------- agents

export function agentView(agent: AgentRecord): Agent {
  const activeVersion = agent.activeVersionId ? state.versions.find((v) => v.id === agent.activeVersionId) : undefined;
  return {
    ...agent,
    ...(activeVersion ? { activeVersion } : {}),
    isLiveAgent: state.liveAgent.agentId === agent.id,
  };
}

export function listAgents(businessId: string, agentState?: string | null) {
  return state.agents
    .filter((a) => a.businessId === businessId && (!agentState || a.state === agentState))
    .sort(newestFirst)
    .map(agentView);
}

export function getAgentRecord(businessId: string, agentId: string): AgentRecord {
  return inBusiness(state.agents, businessId, agentId, "Agent");
}

function checkCapabilities(spec: DraftAgentSpec): void {
  const unknown = ((spec.capabilities ?? []) as string[]).filter((c) => !isCapabilityId(c));
  if (unknown.length) fail("CAPABILITY_NOT_ALLOWED", "The spec names a capability that is not in the registry.", { capabilities: unknown });
}

export function createAgent(businessId: string, body: { builderSessionId?: string; spec?: DraftAgentSpec }): Agent {
  let spec: DraftAgentSpec;
  if (body.builderSessionId) {
    const rec = state.builderSessions.find((s) => s.session.id === body.builderSessionId && s.session.businessId === businessId);
    if (!rec) fail("NOT_FOUND", "Builder session not found.");
    spec = rec!.session.draftSpec;
  } else if (body.spec) {
    // CreateAgentBodySchema: a spec sent directly must be a full AgentSpec.
    const parsed = AgentSpecSchema.safeParse(body.spec);
    if (!parsed.success) {
      fail("VALIDATION_FAILED", "The spec is not a complete agent spec.", {
        issues: parsed.error.issues.map((i) => ({ path: `spec.${i.path.join(".")}`, message: i.message })),
      });
    }
    spec = parsed.data!;
  } else {
    fail("VALIDATION_FAILED", "Send builderSessionId or spec.", { issues: [{ path: "builderSessionId", message: "Required" }] });
    return undefined as never;
  }
  checkCapabilities(spec);
  if (!spec.template || !spec.name) {
    fail("VALIDATION_FAILED", "The draft spec needs a template and a name first.", { issues: [{ path: "spec.template", message: "Required" }] });
  }
  const at = nowIso();
  const agent: AgentRecord = {
    id: newId("agt_"),
    businessId,
    name: spec.name!,
    template: spec.template!,
    state: "draft",
    draftSpec: { ...spec, status: "draft" },
    createdAt: at,
    updatedAt: at,
  };
  state.agents.push(agent);
  const rec = state.builderSessions.find((s) => s.session.id === body.builderSessionId);
  if (rec) rec.session.agentId = agent.id;
  return agentView(agent);
}

export function listVersions(businessId: string, agentId: string): AgentVersion[] {
  getAgentRecord(businessId, agentId);
  return state.versions.filter((v) => v.agentId === agentId).sort((a, b) => b.version - a.version);
}

const comparableSpec = (spec: DraftAgentSpec) => canonicalJson({ ...spec, id: undefined, version: undefined, status: undefined });

function openRequiredConflicts(businessId: string): string[] {
  return state.conflicts.filter((c) => c.businessId === businessId && c.state === "open" && c.required).map((c) => c.id);
}

function snapshotRef(businessId: string) {
  return {
    facts: state.facts.filter((f) => f.businessId === businessId && f.status === "verified").map((f) => ({ id: f.id, version: f.version })),
    catalogSyncedAt: getCatalog(businessId).syncedAt,
  };
}

function setLiveAgentTo(agent: AgentRecord, versionId: string): void {
  const previousAgentId = state.liveAgent.agentId;
  state.liveAgent = {
    phoneNumber: state.liveAgent.phoneNumber,
    businessId: agent.businessId,
    agentId: agent.id,
    agentVersionId: versionId,
    updatedAt: nowIso(),
  };
  emit(agent.businessId, "live_agent.changed", agent.id, "owner", {
    phoneNumberLast4: last4(state.liveAgent.phoneNumber),
    agentId: agent.id,
    agentVersionId: versionId,
    previousAgentId,
  });
}

export function publishAgent(businessId: string, agentId: string, body: { confirm?: unknown; makeLive?: unknown }) {
  const agent = getAgentRecord(businessId, agentId);
  if (body.confirm !== true) {
    fail("VALIDATION_FAILED", "Publishing needs confirm: true.", { issues: [{ path: "confirm", message: "Must be true" }] });
  }
  const conflictIds = openRequiredConflicts(businessId);
  if (conflictIds.length) fail("CONFLICT_UNRESOLVED", "Resolve the open conflicts before you publish.", { conflictIds });
  checkCapabilities(agent.draftSpec);
  if (!agent.draftSpec.capabilities?.length) {
    fail("VALIDATION_FAILED", "The draft spec has no capabilities.", { issues: [{ path: "draftSpec.capabilities", message: "Required" }] });
  }

  const active = agent.activeVersionId ? state.versions.find((v) => v.id === agent.activeVersionId) : undefined;
  let version: AgentVersion;
  if (active && comparableSpec(active.spec) === comparableSpec(agent.draftSpec)) {
    version = active; // unchanged draft: reactivate the current version
  } else {
    const n = Math.max(0, ...state.versions.filter((v) => v.agentId === agentId).map((v) => v.version)) + 1;
    // AgentVersion.spec is a full AgentSpec, so a draft with fields still missing cannot be published.
    const parsed = AgentSpecSchema.safeParse({ ...agent.draftSpec, id: agent.id, businessId, version: n, status: "live" });
    if (!parsed.success) {
      fail("VALIDATION_FAILED", "The draft spec is not complete yet.", {
        issues: parsed.error.issues.map((i) => ({ path: `draftSpec.${i.path.join(".")}`, message: i.message })),
      });
    }
    const spec: AgentSpec = parsed.data!;
    version = {
      id: `${agent.id.replace(/^agt_/, "agv_")}_v${n}`,
      agentId,
      version: n,
      spec,
      knowledgeSnapshotRef: snapshotRef(businessId),
      createdBy: OWNER_USER_ID,
      publishedAt: nowIso(),
    };
    state.versions.push(version);
  }
  agent.state = "live";
  agent.activeVersionId = version.id;
  agent.updatedAt = nowIso();
  emit(businessId, "agent.published", agent.id, "owner", {
    agentId,
    agentVersionId: version.id,
    version: version.version,
    phoneNumberLast4: body.makeLive === true ? last4(state.liveAgent.phoneNumber) : undefined,
  });
  if (body.makeLive === true) setLiveAgentTo(agent, version.id);
  else if (state.liveAgent.agentId === agent.id) state.liveAgent.agentVersionId = version.id;
  return { agent: agentView(agent), version, phoneNumber: state.liveAgent.phoneNumber };
}

export function pauseAgent(businessId: string, agentId: string): void {
  const agent = getAgentRecord(businessId, agentId);
  if (agent.state === "draft") fail("INVALID_STATE", "A draft agent cannot be paused.", { state: agent.state });
  agent.state = "paused";
  agent.updatedAt = nowIso();
  emit(businessId, "agent.paused", agent.id, "owner", { agentId });
}

export function rollbackAgent(businessId: string, agentId: string, body: { toVersionId?: string; confirm?: unknown }) {
  const agent = getAgentRecord(businessId, agentId);
  if (body.confirm !== true) fail("VALIDATION_FAILED", "Rollback needs confirm: true.", { issues: [{ path: "confirm", message: "Must be true" }] });
  const target = state.versions.find((v) => v.id === body.toVersionId && v.agentId === agentId);
  if (!target) fail("NOT_FOUND", "Version not found.");
  if (agent.state === "draft") fail("INVALID_STATE", "A draft agent has nothing to roll back.", { state: agent.state });
  if (agent.activeVersionId === target!.id) fail("INVALID_STATE", "That version is already active.", { state: agent.state });
  const conflictIds = openRequiredConflicts(businessId);
  if (conflictIds.length) fail("CONFLICT_UNRESOLVED", "Resolve the open conflicts first.", { conflictIds });
  const previous = agent.activeVersionId;
  agent.activeVersionId = target!.id;
  // API.md 3.4: only the active version moves. A paused agent stays paused.
  agent.updatedAt = nowIso();
  emit(businessId, "agent.published", agent.id, "owner", {
    agentId,
    agentVersionId: target!.id,
    version: target!.version,
    rolledBackFrom: previous,
  });
  if (agent.state === "live" && state.liveAgent.agentId === agent.id) setLiveAgentTo(agent, target!.id);
  return { agent: agentView(agent), version: target!, phoneNumber: state.liveAgent.phoneNumber };
}

// ------------------------------------------------------------ live agent

export function getLiveAgent() {
  return state.liveAgent;
}

export function putLiveAgent(agentId: unknown) {
  if (typeof agentId !== "string") fail("VALIDATION_FAILED", "agentId is required.", { issues: [{ path: "agentId", message: "Required" }] });
  const agent = state.agents.find((a) => a.id === agentId);
  if (!agent) fail("NOT_FOUND", "Agent not found.");
  if (!OWNER_BUSINESSES.includes(agent!.businessId)) fail("FORBIDDEN_BUSINESS", "You do not own this agent's business.");
  if (agent!.state !== "live" || !agent!.activeVersionId) fail("INVALID_STATE", "Only a live agent can answer the number.", { state: agent!.state });
  setLiveAgentTo(agent!, agent!.activeVersionId!);
  return state.liveAgent;
}

/** Mock control: nothing answers the number (SPEC 2.9 "Live agent, empty case"). */
export function clearLiveAgent(businessId = "biz_barber_01"): void {
  state.liveAgent = { phoneNumber: state.liveAgent.phoneNumber, businessId, updatedAt: nowIso() };
}

// --------------------------------------------------------------- approvals

export function listApprovals(businessId: string, filter: { state?: string | null; bundleType?: string | null }) {
  const wanted = filter.state ?? "PENDING";
  return state.approvals
    .filter((a) => a.businessId === businessId && a.state === wanted && (!filter.bundleType || a.bundleType === filter.bundleType))
    .sort(newestFirst);
}

export function getApproval(businessId: string, approvalId: string): ApprovalRequest {
  return inBusiness(state.approvals, businessId, approvalId, "Approval");
}

/**
 * POST /api/approvals/:id/decision, in the order API.md 3.7 lists the checks.
 * Idempotency-Key replay is handled here too: same key and body gives the
 * first answer; same key with a different body is VALIDATION_FAILED.
 */
export async function decideApproval(
  businessId: string,
  approvalId: string,
  body: { decision?: unknown; payloadHash?: unknown; reason?: unknown },
  key: string | null,
): Promise<{ status: number; body: unknown }> {
  const bodyKey = canonicalJson({ approvalId, businessId, decision: body.decision, payloadHash: body.payloadHash });
  if (key) {
    const prior = idempotency.get(key);
    if (prior) {
      if (prior.bodyKey !== bodyKey) fail("VALIDATION_FAILED", "This Idempotency-Key was used with a different body.", { issues: [{ path: "Idempotency-Key", message: "Reused" }] });
      return { status: prior.status, body: prior.body };
    }
  }
  if (body.decision !== "approve" && body.decision !== "reject") {
    fail("VALIDATION_FAILED", 'decision must be "approve" or "reject".', { issues: [{ path: "decision", message: "Invalid" }] });
  }
  if (typeof body.payloadHash !== "string") {
    fail("VALIDATION_FAILED", "payloadHash is required.", { issues: [{ path: "payloadHash", message: "Required" }] });
  }
  const apv = getApproval(businessId, approvalId);
  if (body.payloadHash !== apv.payloadHash) {
    fail("PAYLOAD_HASH_MISMATCH", "The approval payload changed since you loaded it.", { approvalId });
  }
  const wanted = body.decision === "approve" ? "APPROVED" : "REJECTED";
  const reply = () => ({ approval: { id: apv.id, state: apv.state, decidedBy: apv.decidedBy, decidedAt: apv.decidedAt } });
  if (apv.state === wanted) return { status: 200, body: reply() };
  if (apv.state === "EXPIRED" || (apv.state === "PENDING" && expiryNow() > Date.parse(apv.expiresAt))) {
    if (apv.state === "PENDING") sweepExpired();
    fail("APPROVAL_EXPIRED", "This approval expired, so nothing was sent.", { approvalId });
  }
  if (apv.state !== "PENDING") fail("APPROVAL_ALREADY_DECIDED", "A different decision was already recorded.", { state: apv.state });

  apv.state = wanted;
  apv.decidedBy = OWNER_USER_ID;
  apv.decidedAt = nowIso();
  emit(businessId, "approval.decided", correlationFor(apv), "owner", {
    approvalId: apv.id,
    subjectId: apv.subjectId,
    decision: wanted,
    decidedBy: OWNER_USER_ID,
  });
  if (wanted === "APPROVED") await runBundle(apv);
  else rejectSubject(apv);

  const result = { status: 200, body: reply() };
  if (key) idempotency.set(key, { bodyKey, ...result });
  return result;
}

/** Mock control: change a pending approval's stored payload, so the hash the UI shows no longer matches. */
export async function tamperApproval(approvalId: string): Promise<void> {
  const apv = state.approvals.find((a) => a.id === approvalId);
  if (!apv || apv.state !== "PENDING") return;
  apv.payload = { ...apv.payload, expiresAt: iso(Date.parse(apv.expiresAt) + 1000) } as ApprovalRequest["payload"];
  apv.payloadHash = await payloadHash(apv.payload, apv.bundleType);
}

function rejectSubject(apv: ApprovalRequest): void {
  if (apv.bundleType === "order_bundle") {
    const order = state.orders.find((o) => o.id === apv.subjectId);
    if (order) setOrderStatus(order, "REJECTED");
  } else if (apv.bundleType === "booking_bundle") {
    const booking = state.bookings.find((b) => b.id === apv.subjectId);
    if (booking) setBookingStatus(booking, "REJECTED");
  } else if (apv.bundleType === "fact_edit") {
    const draft = state.facts.find((f) => f.id === apv.subjectId);
    if (draft) draft.status = "superseded";
  }
}

// ---------------------------------------------------------------- executor

async function queueExecutions(apv: ApprovalRequest): Promise<Map<ExecutionActionType, ActionExecution>> {
  const map = new Map<ExecutionActionType, ActionExecution>();
  const steps: readonly string[] = apv.actionBundle;
  for (const [stepIndex, step] of steps.entries()) {
    if (isDeferredActionType(step as ActionType)) continue; // the Sheets step is created later as a sync job
    const actionType = step as ExecutionActionType;
    const capabilityId = ACTION_TYPE_CAPABILITY[actionType];
    const exe: ActionExecution = {
      id: newId("exe_"),
      businessId: apv.businessId,
      approvalId: apv.id,
      actionType,
      stepIndex,
      ...(capabilityId ? { capabilityId } : {}),
      idempotencyKey: await idempotencyKey({ businessId: apv.businessId, subjectId: apv.subjectId, actionType, approvalId: apv.id }),
      status: "QUEUED",
      attempts: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    state.executions.push(exe);
    map.set(actionType, exe);
  }
  return map;
}

function startStep(apv: ApprovalRequest, exe: ActionExecution, correlationId: string): void {
  exe.status = "RUNNING";
  exe.attempts += 1;
  exe.updatedAt = nowIso();
  emit(apv.businessId, "execution.started", correlationId, "system", {
    executionId: exe.id,
    approvalId: apv.id,
    actionType: exe.actionType,
    stepIndex: exe.stepIndex,
    attempt: exe.attempts,
  });
}

function succeedStep(apv: ApprovalRequest, exe: ActionExecution, correlationId: string, externalRef?: string): void {
  exe.status = "SUCCEEDED";
  exe.externalRef = externalRef;
  exe.updatedAt = nowIso();
  emit(apv.businessId, "execution.succeeded", correlationId, "system", { executionId: exe.id, actionType: exe.actionType, externalRef });
}

function failStep(apv: ApprovalRequest, exe: ActionExecution, correlationId: string, errorCode: ErrorCode, lastError: string): void {
  exe.status = "FAILED";
  exe.errorCode = errorCode;
  exe.lastError = lastError;
  exe.updatedAt = nowIso();
  emit(apv.businessId, "execution.failed", correlationId, "system", {
    executionId: exe.id,
    actionType: exe.actionType,
    errorCode,
    retryable: false,
    nextStatus: "FAILED",
  });
}

/** Run steps one after another, timing.stepMs apart. */
function sequence(steps: (() => void)[]): void {
  const next = (i: number) => {
    if (i >= steps.length) return;
    schedule(() => {
      steps[i]();
      next(i + 1);
    }, timing.stepMs);
  };
  next(0);
}

async function runBundle(apv: ApprovalRequest): Promise<void> {
  if (apv.bundleType === "order_bundle") await runOrderBundle(apv);
  else if (apv.bundleType === "booking_bundle") await runBookingBundle(apv);
  else if (apv.bundleType === "fact_edit") await runFactEdit(apv);
  else await runPriceEdit(apv);
}

async function runOrderBundle(apv: ApprovalRequest): Promise<void> {
  const order = state.orders.find((o) => o.id === apv.subjectId);
  if (!order) return;
  const c = order.callId;
  const exes = await queueExecutions(apv);
  const checkout = exes.get("square.checkout.create")!;
  const message = exes.get("message.checkout.send")!;
  const record = exes.get("local.order.record")!;
  setOrderStatus(order, "APPROVED");
  let messageSent = false;
  const qrOnly = apv.bundleType === "order_bundle" && apv.payload.messageChannel === "qr_only";

  const checkoutSteps: (() => void)[] = [
    () => {
      startStep(apv, checkout, c);
      setOrderStatus(order, "CREATING_CHECKOUT");
    },
    () => {
      // Square sandbox answered with the link and order id.
      const suffix = order.id.slice(4).toUpperCase();
      order.squareOrderId = `SQ_ORD_${suffix}`;
      order.squarePaymentLinkId = `SQ_PL_${suffix}`;
      order.checkoutUrl = sandboxCheckoutUrl(order.id);
      emit(order.businessId, "checkout.created", c, "system", {
        orderId: order.id,
        squareOrderId: order.squareOrderId,
        squarePaymentLinkId: order.squarePaymentLinkId,
        totalMinor: order.totalMinor,
        currency: "USD",
        sandbox: true,
      });
      succeedStep(apv, checkout, c, order.squarePaymentLinkId);
      setOrderStatus(order, "PAYMENT_LINK_READY");
    },
  ];
  const recordStep = () => {
    startStep(apv, record, c);
    succeedStep(apv, record, c);
    setOrderStatus(order, "PAYMENT_PENDING");
    void messageSent;
    schedulePayment(order);
  };

  if (qrOnly) {
    // SPEC 2.9: under qr_only the message step is SKIPPED, no dispatch row is
    // created and no message event is written. The QR code carries the link.
    sequence([
      ...checkoutSteps,
      () => {
        message.status = "SKIPPED";
        message.updatedAt = nowIso();
        recordStep();
      },
    ]);
    return;
  }

  sequence([
    ...checkoutSteps,
    () => {
      startStep(apv, message, c);
      state.dispatches.push({
        id: newId("msg_"),
        businessId: order.businessId,
        executionId: message.id,
        subjectId: order.id,
        channel: MESSAGE_CHANNEL,
        // A channel other than qr_only always has a recipient (the payload schema requires it).
        recipient: order.contact.messageRecipient!,
        template: "checkout_link",
        status: "QUEUED",
        idempotencyKey: message.idempotencyKey,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
    },
    () => {
      // The channel accepted the message and returned an id.
      const dispatch = state.dispatches.find((d) => d.executionId === message.id)!;
      dispatch.status = "SENT";
      dispatch.providerMessageId = newId("surge_");
      dispatch.sentAt = nowIso();
      dispatch.updatedAt = dispatch.sentAt;
      messageSent = true;
      emit(order.businessId, "message.sent", c, "system", {
        dispatchId: dispatch.id,
        subjectId: order.id,
        channel: MESSAGE_CHANNEL,
        template: "checkout_link",
        recipientLast4: last4(order.contact.messageRecipient!),
      });
      succeedStep(apv, message, c, dispatch.providerMessageId);
      setOrderStatus(order, "MESSAGE_SENT");
    },
    recordStep,
  ]);
}

function schedulePayment(order: Order): void {
  const id = schedule(() => {
    paymentTimers.delete(order.id);
    if (order.status !== "PAYMENT_PENDING") return;
    if (flags.nextPaymentFails) {
      flags.nextPaymentFails = false;
      failPayment(order);
    } else {
      verifyPayment(order);
    }
  }, timing.paymentMs);
  paymentTimers.set(order.id, id);
}

function verifyPayment(order: Order): void {
  // Scripted provider: Square reports COMPLETED with matching order id, amount and currency.
  order.squarePaymentId = `SQ_PAY_${order.id.slice(4).toUpperCase()}`;
  emit(order.businessId, "payment.verified", order.callId, "provider", {
    orderId: order.id,
    squarePaymentId: order.squarePaymentId,
    amountMinor: order.totalMinor,
    currency: "USD",
    sandbox: true,
  });
  setOrderStatus(order, "PAID_VERIFIED");
  runSheetsSync(order.businessId, "order", order.id, order.callId, () => {
    if (order.status === "PAID_VERIFIED") setOrderStatus(order, "FULFILLMENT_READY");
  });
}

export function failPayment(order: Order): void {
  cancel(paymentTimers.get(order.id));
  paymentTimers.delete(order.id);
  emit(order.businessId, "payment.failed", order.callId, "provider", {
    orderId: order.id,
    squarePaymentId: `SQ_PAY_${order.id.slice(4).toUpperCase()}`,
    reason: "card_declined",
    sandbox: true,
  });
  setOrderStatus(order, "PAYMENT_FAILED");
}

/** The newest pizza order waiting on payment, if any. */
export function newestPendingPayment(): Order | undefined {
  return [...state.orders].filter((o) => o.status === "PAYMENT_PENDING" && paymentTimers.has(o.id)).sort(newestFirst)[0];
}

function runSheetsSync(
  businessId: string,
  recordType: "order" | "booking",
  recordId: string,
  correlationId: string,
  afterQueued?: () => void,
): void {
  const job: MockState["syncJobs"][number] = {
    id: newId("syn_"),
    businessId,
    target: "google_sheets",
    recordType,
    recordId,
    state: "PENDING",
    attempts: 0,
    nextRetryAt: nowIso(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  state.syncJobs.push(job);
  emit(businessId, "sync.queued", correlationId, "system", { target: "google_sheets", syncJobId: job.id, recordType, recordId });
  afterQueued?.();
  const retry = flags.nextSyncRetries;
  flags.nextSyncRetries = false;
  const steps: (() => void)[] = [];
  if (retry) {
    steps.push(() => {
      job.state = "RETRYING";
      job.attempts = 1;
      job.updatedAt = nowIso();
      job.nextRetryAt = iso(Date.now() + timing.stepMs);
      emit(businessId, "sync.failed", correlationId, "system", {
        target: "google_sheets",
        syncJobId: job.id,
        recordType,
        recordId,
        attempts: 1,
        final: false,
      });
    });
  }
  steps.push(() => {
    job.state = "DONE";
    job.attempts += 1;
    job.updatedAt = nowIso();
    emit(businessId, "sync.succeeded", correlationId, "system", { target: "google_sheets", syncJobId: job.id, recordType, recordId });
  });
  sequence(steps);
}

async function runBookingBundle(apv: ApprovalRequest): Promise<void> {
  const booking = state.bookings.find((b) => b.id === apv.subjectId);
  if (!booking) return;
  const c = booking.callId ?? booking.id;
  const exes = await queueExecutions(apv);
  const calendar = exes.get("calendar.event.create")!;
  const message = exes.get("message.booking.confirm")!;
  const record = exes.get("local.booking.record")!;

  if (slotConflictBookings.has(booking.id)) {
    setBookingStatus(booking, "RECHECKING_SLOT");
    sequence([
      () => startStep(apv, calendar, c),
      () => {
        const start = Date.parse(booking.startUtc);
        const dur = Date.parse(booking.endUtc) - start;
        emit(booking.businessId, "booking.slot_conflict", c, "provider", {
          bookingId: booking.id,
          approvalId: apv.id,
          startUtc: booking.startUtc,
          alternatives: [1, 2, 3].map((n) => ({ startUtc: iso(start + n * 45 * MINUTE), endUtc: iso(start + n * 45 * MINUTE + dur) })),
        });
        failStep(apv, calendar, c, "SLOT_CONFLICT", "slot_busy");
        setBookingStatus(booking, "SLOT_CONFLICT");
      },
    ]);
    return;
  }

  setBookingStatus(booking, "RECHECKING_SLOT");
  sequence([
    () => startStep(apv, calendar, c),
    () => {
      // Google Calendar returned the event id after a clear free/busy read.
      booking.googleEventId = calendar.idempotencyKey.slice(0, 26);
      succeedStep(apv, calendar, c, booking.googleEventId);
    },
    () => {
      startStep(apv, message, c);
      const dispatch = {
        id: newId("msg_"),
        businessId: booking.businessId,
        executionId: message.id,
        subjectId: booking.id,
        channel: MESSAGE_CHANNEL,
        recipient: booking.customer.messageRecipient!,
        template: "booking_confirmed" as const,
        status: "SENT" as const,
        providerMessageId: newId("surge_"),
        idempotencyKey: message.idempotencyKey,
        sentAt: nowIso(),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      state.dispatches.push(dispatch);
      emit(booking.businessId, "message.sent", c, "system", {
        dispatchId: dispatch.id,
        subjectId: booking.id,
        channel: MESSAGE_CHANNEL,
        template: "booking_confirmed",
        recipientLast4: last4(booking.customer.messageRecipient!),
      });
      succeedStep(apv, message, c, dispatch.providerMessageId);
    },
    () => {
      startStep(apv, record, c);
      succeedStep(apv, record, c);
      setBookingStatus(booking, "BOOKED_VERIFIED");
      emit(booking.businessId, "booking.verified", c, "provider", {
        bookingId: booking.id,
        googleEventId: booking.googleEventId!,
        serviceName: booking.serviceName,
        startUtc: booking.startUtc,
        timezone: booking.timezone,
      });
      runSheetsSync(booking.businessId, "booking", booking.id, c);
    },
  ]);
}

async function runFactEdit(apv: ApprovalRequest): Promise<void> {
  const exes = await queueExecutions(apv);
  const exe = exes.get("local.fact.update")!;
  sequence([
    () => {
      startStep(apv, exe, apv.id);
      const draft = state.facts.find((f) => f.id === apv.subjectId);
      if (!draft) return failStep(apv, exe, apv.id, "NOT_FOUND", "draft_missing");
      const current = verifiedFact(apv.businessId, draft.kind, draft.key);
      const at = nowIso();
      if (current) {
        current.status = "superseded";
        current.updatedAt = at;
      }
      draft.status = "verified";
      draft.version = (current?.version ?? 0) + 1;
      draft.supersedesId = current?.id;
      draft.verifiedAt = at;
      draft.updatedAt = at;
      const conflictId = conflictByApproval.get(apv.id);
      if (conflictId) {
        const conflict = state.conflicts.find((c) => c.id === conflictId);
        if (conflict && conflict.state === "open") {
          conflict.state = "resolved";
          conflict.resolvedFactId = draft.id;
          conflict.resolvedBy = OWNER_USER_ID;
          conflict.resolvedAt = at;
          for (const cand of conflict.candidates) {
            const f = cand.factId ? state.facts.find((x) => x.id === cand.factId) : undefined;
            if (f && f.status === "draft" && f.id !== draft.id) f.status = "superseded";
          }
        }
      }
      const resolved = conflictId ? state.conflicts.find((c) => c.id === conflictId && c.resolvedFactId === draft.id) : undefined;
      emit(apv.businessId, "fact.changed", apv.id, "system", {
        factId: draft.id,
        kind: draft.kind,
        key: draft.key,
        fromVersion: current?.version ?? 0,
        toVersion: draft.version,
        sourceType: draft.sourceType,
        ...(resolved ? { resolvedConflictId: resolved.id } : {}),
      });
      succeedStep(apv, exe, apv.id);
    },
  ]);
}

async function runPriceEdit(apv: ApprovalRequest): Promise<void> {
  const exes = await queueExecutions(apv);
  const update = exes.get("square.catalog.price.update")!;
  const sync = exes.get("local.catalog.sync")!;
  const payload = apv.payload as { variationId: string; newPriceMinor: number; squareVersion: number };
  sequence([
    () => startStep(apv, update, apv.id),
    () => {
      // Square sandbox accepted the upsert with the approved version.
      squareVersions.set(payload.variationId, payload.squareVersion + 1);
      succeedStep(apv, update, apv.id, `v${payload.squareVersion + 1}`);
    },
    () => {
      startStep(apv, sync, apv.id);
      for (const item of state.catalog) {
        const v = item.variations.find((x) => x.id === payload.variationId);
        if (v) {
          v.priceMinor = payload.newPriceMinor;
          item.syncedAt = nowIso();
        }
      }
      succeedStep(apv, sync, apv.id);
    },
  ]);
}

// ------------------------------------------------------ orders, bookings

export function listOrders(businessId: string, q: { status?: string | null; callId?: string | null }) {
  const statuses = q.status ? q.status.split(",") : null;
  return state.orders
    .filter((o) => o.businessId === businessId && (!statuses || statuses.includes(o.status)) && (!q.callId || o.callId === q.callId))
    .sort(newestFirst);
}

export function getOrder(businessId: string, orderId: string): Order {
  return inBusiness(state.orders, businessId, orderId, "Order");
}

export function getCheckout(businessId: string, orderId: string) {
  const order = getOrder(businessId, orderId);
  const ready = Boolean(order.checkoutUrl && order.squarePaymentLinkId);
  const dispatch = [...state.dispatches].reverse().find((d) => d.subjectId === order.id);
  return {
    orderId: order.id,
    ready,
    environment: "sandbox" as const,
    ...(ready ? { checkoutUrl: order.checkoutUrl, qrText: order.checkoutUrl, squarePaymentLinkId: order.squarePaymentLinkId } : {}),
    ...(dispatch
      ? { message: { id: dispatch.id, channel: dispatch.channel, status: dispatch.status, ...(dispatch.sentAt ? { sentAt: dispatch.sentAt } : {}) } }
      : {}),
  };
}

export function cancelOrder(businessId: string, orderId: string) {
  const order = getOrder(businessId, orderId);
  if (!["PAYMENT_PENDING", "PAYMENT_FAILED", "RECOVERY_REQUIRED"].includes(order.status)) {
    fail("INVALID_STATE", "This order cannot be cancelled now.", { state: order.status });
  }
  cancel(paymentTimers.get(order.id));
  paymentTimers.delete(order.id);
  setOrderStatus(order, "CANCELLED");
  return { order };
}

export function listBookings(businessId: string, q: { status?: string | null; from?: string | null; to?: string | null }) {
  const statuses = q.status ? q.status.split(",") : null;
  return state.bookings
    .filter(
      (b) =>
        b.businessId === businessId &&
        (!statuses || statuses.includes(b.status)) &&
        (!q.from || b.startUtc >= q.from) &&
        (!q.to || b.startUtc < q.to),
    )
    .sort(newestFirst);
}

export function getBooking(businessId: string, bookingId: string): Booking {
  return inBusiness(state.bookings, businessId, bookingId, "Booking");
}

export function resolveExecution(businessId: string, executionId: string, action: unknown) {
  if (action !== "retry" && action !== "abandon") {
    fail("VALIDATION_FAILED", 'action must be "retry" or "abandon".', { issues: [{ path: "action", message: "Invalid" }] });
  }
  const exe = inBusiness(state.executions, businessId, executionId, "Execution");
  const dispatch = state.dispatches.find((d) => d.executionId === exe.id);
  if (exe.status !== "NEEDS_REVIEW" && dispatch?.status !== "UNKNOWN") {
    fail("INVALID_STATE", "Only a step that needs review can be retried or abandoned.", { state: exe.status });
  }
  exe.updatedAt = nowIso();
  if (action === "abandon") {
    exe.status = "FAILED";
    if (dispatch && dispatch.status === "UNKNOWN") dispatch.status = "FAILED";
  } else {
    exe.status = "QUEUED"; // same idempotency key
  }
  return { execution: exe };
}

// ------------------------------------------------------------------ calls

export function listCalls(businessId: string, q: { agentId?: string | null; since?: string | null }) {
  return state.calls
    .filter((c) => c.businessId === businessId && (!q.agentId || c.agentId === q.agentId) && (!q.since || c.startedAt >= q.since))
    .sort(newestFirst);
}

export function getCall(businessId: string, callId: string): Call {
  return inBusiness(state.calls, businessId, callId, "Call");
}

export function startCall(input: {
  businessId: string;
  agentId: string;
  agentVersionId: string;
  channel: Call["channel"];
  callerLast4?: string;
}): Call {
  const id = newId("call_");
  const call: Call = {
    id,
    businessId: input.businessId,
    agentId: input.agentId,
    agentVersionId: input.agentVersionId,
    channel: input.channel,
    stage: input.businessId === "biz_barber_01" ? "INQUIRY" : "CALL_STARTED",
    ...(input.channel === "phone" ? { providerCallId: `CA${id.slice(5)}`, callerLast4: input.callerLast4 } : {}),
    status: "IN_PROGRESS",
    startedAt: nowIso(),
  };
  state.calls.push(call);
  emit(call.businessId, "call.started", call.id, "provider", {
    callId: call.id,
    agentId: call.agentId,
    agentVersionId: call.agentVersionId,
    channel: call.channel,
    callerLast4: call.callerLast4,
  });
  return call;
}

export function setStage(call: Call, to: CallStage): void {
  const from = call.stage;
  if (from === to) return;
  call.stage = to;
  if (call.businessId === "biz_barber_01") {
    emit(call.businessId, "booking.status_changed", call.id, "deployed_agent", {
      callId: call.id,
      from: from as BookingMachineState,
      to: to as BookingMachineState,
    });
  } else {
    emit(call.businessId, "order.status_changed", call.id, "deployed_agent", {
      callId: call.id,
      from: from as OrderMachineState,
      to: to as OrderMachineState,
    });
  }
}

export function endCall(call: Call, reason: "completed" | "dropped" | "failed"): void {
  if (call.status !== "IN_PROGRESS") return;
  call.status = reason === "completed" ? "COMPLETED" : reason === "dropped" ? "DROPPED" : "FAILED";
  call.endReason = reason;
  call.endedAt = nowIso();
  emit(call.businessId, "call.ended", call.id, "provider", {
    callId: call.id,
    status: call.status,
    reason,
    durationSec: Math.max(1, Math.round((Date.parse(call.endedAt) - Date.parse(call.startedAt)) / 1000)),
  });
}

/** What propose_order does: the order row and the approval, no external write. */
export async function proposeOrderOnCall(call: Call, contact: { name: string; messageRecipient: string }): Promise<{ order: Order; approval: ApprovalRequest }> {
  const at = Date.now();
  const order = await buildOrder({
    id: newId("ord_"),
    businessId: call.businessId,
    callId: call.id,
    catalog: state.catalog,
    cart: TIMELINE_CART,
    contact: { ...contact, messageConsent: true },
    pickupAt: at + 30 * MINUTE,
    at,
  });
  const channel = flags.nextCallQrOnly ? "qr_only" : MESSAGE_CHANNEL;
  flags.nextCallQrOnly = false;
  const approval = await orderApproval(order, call.agentVersionId, newId("apv_"), at, channel);
  order.approvalId = approval.id;
  state.orders.push(order);
  state.approvals.push(approval);
  emit(call.businessId, "proposal.created", call.id, "deployed_agent", {
    subjectId: order.id,
    subjectType: "order",
    callId: call.id,
    totalMinor: order.totalMinor,
    currency: "USD",
  });
  emit(call.businessId, "approval.requested", call.id, "system", {
    approvalId: approval.id,
    bundleType: "order_bundle",
    subjectId: order.id,
    actionBundle: approval.actionBundle,
    expiresAt: approval.expiresAt,
    totalMinor: order.totalMinor,
    recipientLast4: last4(contact.messageRecipient),
  });
  emit(call.businessId, "order.status_changed", call.id, "system", {
    orderId: order.id,
    callId: call.id,
    from: "CUSTOMER_CONFIRMED",
    to: "AWAITING_OWNER_APPROVAL",
  });
  return { order, approval };
}

/**
 * The slot a scripted booking call proposes: the first free time of the shared
 * demo appointment day (just after the morning busy block, inside opening
 * hours), a week later when that is under the two hour minimum notice.
 */
export function scriptedSlotStart(at: number): number {
  const [morning] = materializeBusyBlocks(new Date(at));
  let start = Date.parse(morning.endUtc);
  while (start < at + 120 * MINUTE) start += 7 * 24 * 60 * MINUTE;
  return start;
}

/** What propose_booking does. slotConflict makes the scripted recheck after approval find the slot taken. */
export async function proposeBookingOnCall(
  call: Call,
  customer: { name: string; messageRecipient: string },
  options: { slotConflict?: boolean } = {},
): Promise<{ booking: Booking; approval: ApprovalRequest }> {
  const at = Date.now();
  const service = serviceHaircut;
  const start = new Date(scriptedSlotStart(at));
  const booking: Booking = {
    id: newId("bkg_"),
    businessId: call.businessId,
    callId: call.id,
    status: "AWAITING_OWNER_APPROVAL",
    serviceId: service.id,
    serviceName: service.name,
    startUtc: iso(start.getTime()),
    endUtc: iso(start.getTime() + service.durationMinutes * MINUTE),
    timezone: TIMEZONE,
    calendarId: BARBER_CALENDAR_ID,
    customer: { ...customer, messageConsent: true },
    createdAt: iso(at),
    updatedAt: iso(at),
  };
  const approval = await bookingApproval(booking, call.agentVersionId, newId("apv_"), at);
  booking.approvalId = approval.id;
  state.bookings.push(booking);
  state.approvals.push(approval);
  if (options.slotConflict) slotConflictBookings.add(booking.id);
  emit(call.businessId, "proposal.created", call.id, "deployed_agent", {
    subjectId: booking.id,
    subjectType: "booking",
    callId: call.id,
    serviceName: booking.serviceName,
    startUtc: booking.startUtc,
  });
  emit(call.businessId, "approval.requested", call.id, "system", {
    approvalId: approval.id,
    bundleType: "booking_bundle",
    subjectId: booking.id,
    actionBundle: approval.actionBundle,
    expiresAt: approval.expiresAt,
    recipientLast4: last4(customer.messageRecipient),
  });
  emit(call.businessId, "booking.status_changed", call.id, "system", {
    bookingId: booking.id,
    callId: call.id,
    from: "CUSTOMER_CONFIRMED",
    to: "AWAITING_OWNER_APPROVAL",
  });
  return { booking, approval };
}

// --------------------------------------------------------------- activity

export function listActivity(
  businessId: string,
  q: { types?: string | null; correlationId?: string | null; since?: string | null },
): ActivityEvent[] {
  const types = q.types ? q.types.split(",") : null;
  return state.activity
    .filter(
      (e) =>
        e.businessId === businessId &&
        (!types || types.includes(e.type)) &&
        (!q.correlationId || e.correlationId === q.correlationId) &&
        (!q.since || e.occurredAt >= q.since),
    )
    .slice()
    .reverse();
}

// ----------------------------------------------------- health, telemetry

/**
 * Mock control: Google Sheets loses its connection. The shared world keeps
 * this as a separate export (integrationHealthDisconnected), so the default
 * health stays as the shared default and this control switches to it.
 */
export function disconnectSheets(): void {
  const at = nowIso();
  state.health = { ...state.health, google_sheets: { ...integrationHealthDisconnected.google_sheets, lastCheckedAt: at } };
}

export function getHealth(refresh: boolean) {
  if (refresh) {
    const at = nowIso();
    for (const entry of Object.values(state.health)) entry.lastCheckedAt = at;
  }
  return state.health;
}

/** The shared telemetry fixture. It has no times, so it needs no materializing. An emptied business has no measurements. */
export function getTelemetry(businessId?: string) {
  if (businessId && emptyBusinesses.has(businessId)) return { metrics: [] };
  return structuredClone(sharedTelemetry);
}

// -------------------------------------------------- test console (no writes)

export function testSessionFor(businessId: string, agentId: string, testSessionId?: string): { id: string; turns: number } {
  if (testSessionId) {
    const s = testSessions.get(testSessionId);
    if (!s || s.businessId !== businessId || s.agentId !== agentId) fail("NOT_FOUND", "Test session not found.");
    s!.turns += 1;
    return { id: testSessionId, turns: s!.turns };
  }
  const id = newId("tst_");
  testSessions.set(id, { businessId, agentId, turns: 1 });
  return { id, turns: 1 };
}

export function quoteFor(businessId: string) {
  return buildQuote(
    state.catalog.filter((c) => c.businessId === businessId),
    TIMELINE_CART,
    Date.now(),
  );
}

export const capabilityEffect = (id: CapabilityId) => CAPABILITIES[id].effect;
export { BUNDLE_ACTIONS };
