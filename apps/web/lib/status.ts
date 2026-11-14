/**
 * One place that maps every server state to a label and a tone, so the same
 * state looks the same on every screen.
 *
 * Rule: the `success` tone (green) is only for states the server or the
 * provider confirmed. Nothing here is green for a state that is still waiting.
 * Every payment label says sandbox.
 *
 * Rule: no raw state reaches the owner. Every contract state has a label
 * here, and a state this app does not know shows in a readable form, in
 * neutral. status.coverage.test.ts holds both rules against the contract lists.
 */

import type {
  AgentStatus,
  ApprovalState,
  BookingMachineState,
  BuilderSessionStatus,
  CallStage,
  CallStatus,
  ExecutionStatus,
  ExtractionState,
  FactStatus,
  IntegrationState,
  MessageDispatchStatus,
  OrderMachineState,
  SyncJobState,
} from '@abos/contracts';
import type {ActivityFeedStatus} from '@/lib/api/useActivityFeed';

export type Tone = 'neutral' | 'info' | 'warning' | 'danger' | 'success';

/** Every tone a status may have. StatusBadge and the banners know these and no others. */
export const TONES: readonly Tone[] = ['neutral', 'info', 'warning', 'danger', 'success'];

export type StatusView = {label: string; tone: Tone};

export type StatusMachine =
  | 'order'
  | 'booking'
  | 'approval'
  | 'execution'
  | 'syncJob'
  | 'messageDispatch'
  | 'call'
  | 'callStage'
  | 'agent'
  | 'fact'
  | 'fileExtraction'
  | 'integration'
  /** useActivityFeed status. A client connection, not a server state. */
  | 'feed'
  /** A Square catalog sync job, read from sync.* events with target "catalog". */
  | 'catalogSync'
  /** BuilderSession.status. */
  | 'builderSession';

const view = (label: string, tone: Tone): StatusView => ({label, tone});

/**
 * The states of each machine, taken from the contract types. A state that is
 * added to a contract enum and not labelled here fails the typecheck, and
 * status.coverage.test.ts fails as well.
 */
type StatesByMachine = {
  /** Order statuses, plus the order call stages that order.status_changed can carry. */
  order: OrderMachineState;
  /** Booking statuses, plus the booking call stages that booking.status_changed can carry. */
  booking: BookingMachineState;
  approval: ApprovalState;
  execution: ExecutionStatus;
  syncJob: SyncJobState;
  /** SKIPPED is what the message step reports when the channel is QR only. */
  messageDispatch: MessageDispatchStatus | 'SKIPPED';
  call: CallStatus;
  callStage: CallStage;
  agent: AgentStatus;
  fact: FactStatus;
  fileExtraction: ExtractionState;
  integration: IntegrationState;
  feed: ActivityFeedStatus;
  catalogSync: SyncJobState;
  builderSession: BuilderSessionStatus;
};

/** The conversation stages of a call. `order` and `booking` reuse these labels. */
const CALL_STAGE: Record<CallStage, StatusView> = {
  CALL_STARTED: view('Call started', 'info'),
  COLLECTING: view('Taking the order', 'info'),
  VALIDATING: view('Checking the order', 'info'),
  CUSTOMER_CONFIRMED: view('Customer confirmed', 'info'),
  INQUIRY: view('Asking what they need', 'info'),
  SLOT_SEARCH: view('Looking for a time', 'info'),
  PROPOSAL: view('Offering a time', 'info'),
  UNAVAILABLE: view('Item unavailable, choosing again', 'warning'),
};

const TABLE: {[M in StatusMachine]: Record<StatesByMachine[M], StatusView>} = {
  order: {
    CALL_STARTED: CALL_STAGE.CALL_STARTED,
    COLLECTING: CALL_STAGE.COLLECTING,
    VALIDATING: CALL_STAGE.VALIDATING,
    CUSTOMER_CONFIRMED: CALL_STAGE.CUSTOMER_CONFIRMED,
    AWAITING_OWNER_APPROVAL: view('Waiting for your approval', 'warning'),
    APPROVED: view('Approved, creating checkout', 'info'),
    CREATING_CHECKOUT: view('Creating checkout', 'info'),
    PAYMENT_LINK_READY: view('Link ready, not paid (sandbox)', 'info'),
    MESSAGE_SENT: view('Link sent, not paid (sandbox)', 'info'),
    PAYMENT_PENDING: view('Not paid yet (sandbox)', 'info'),
    PAID_VERIFIED: view('Paid (sandbox), verified', 'success'),
    FULFILLMENT_READY: view('Paid (sandbox), ready to make', 'success'),
    REJECTED: view('Rejected, nothing charged', 'neutral'),
    APPROVAL_EXPIRED: view('Approval expired, nothing charged', 'neutral'),
    CANCELLED: view('Cancelled, nothing charged', 'neutral'),
    UNAVAILABLE: view('Item unavailable, nothing charged', 'neutral'),
    PAYMENT_FAILED: view('Payment failed (sandbox)', 'danger'),
    RECOVERY_REQUIRED: view('Needs your review', 'danger'),
  },
  booking: {
    INQUIRY: CALL_STAGE.INQUIRY,
    SLOT_SEARCH: CALL_STAGE.SLOT_SEARCH,
    PROPOSAL: CALL_STAGE.PROPOSAL,
    CUSTOMER_CONFIRMED: CALL_STAGE.CUSTOMER_CONFIRMED,
    AWAITING_OWNER_APPROVAL: view('Waiting for your approval', 'warning'),
    RECHECKING_SLOT: view('Checking the calendar', 'info'),
    BOOKED_VERIFIED: view('Booked, verified', 'success'),
    SLOT_CONFLICT: view('Slot taken', 'danger'),
    RETRY_REQUIRED: view('Needs your review', 'danger'),
    REJECTED: view('Rejected, nothing booked', 'neutral'),
    EXPIRED: view('Approval expired, nothing booked', 'neutral'),
  },
  approval: {
    PENDING: view('Waiting for you', 'warning'),
    APPROVED: view('Approved', 'info'),
    REJECTED: view('Rejected', 'neutral'),
    EXPIRED: view('Expired', 'neutral'),
  },
  execution: {
    QUEUED: view('Queued', 'info'),
    RUNNING: view('Running', 'info'),
    SUCCEEDED: view('Done', 'success'),
    SKIPPED: view('Skipped', 'neutral'),
    FAILED: view('Failed', 'danger'),
    NEEDS_REVIEW: view('Needs your review', 'warning'),
  },
  syncJob: {
    PENDING: view('Report pending', 'info'),
    RUNNING: view('Writing the report', 'info'),
    RETRYING: view('Report pending, retrying', 'warning'),
    DONE: view('Report written', 'success'),
    FAILED: view('Report failed', 'danger'),
  },
  messageDispatch: {
    QUEUED: view('Message queued', 'info'),
    SENT: view('Message sent', 'info'),
    DELIVERED: view('Message delivered', 'success'),
    UNKNOWN: view('Delivery unknown, not resent', 'warning'),
    FAILED: view('Message failed, show the QR code', 'danger'),
    SKIPPED: view('No message sent', 'neutral'),
  },
  call: {
    IN_PROGRESS: view('On the call', 'info'),
    COMPLETED: view('Call ended', 'neutral'),
    DROPPED: view('Call lost', 'warning'),
    FAILED: view('Call failed', 'danger'),
  },
  callStage: CALL_STAGE,
  agent: {
    draft: view('Draft', 'neutral'),
    live: view('Live', 'info'),
    paused: view('Paused', 'warning'),
  },
  fact: {
    draft: view('Needs confirmation', 'warning'),
    verified: view('Verified', 'info'),
    superseded: view('Replaced', 'neutral'),
  },
  fileExtraction: {
    PENDING: view('Waiting to read', 'info'),
    EXTRACTING: view('Reading the file', 'info'),
    EXTRACTED: view('Facts extracted', 'info'),
    FAILED: view('Could not read the file', 'danger'),
  },
  integration: {
    connected: view('Connected', 'success'),
    degraded: view('Degraded', 'warning'),
    disconnected: view('Disconnected', 'danger'),
  },
  // The feed is how this screen hears about changes. A connected feed
  // confirms nothing about any order or booking, so it is never green.
  feed: {
    connecting: view('Live updates: connecting', 'neutral'),
    connected: view('Live updates: on', 'info'),
    disconnected: view('Live updates lost, data may be stale', 'warning'),
    unavailable: view('Live updates not configured', 'warning'),
    idle: view('No business selected', 'neutral'),
  },
  // Same job states as syncJob, worded for the Square catalog. syncJob stays
  // worded for the Sheets report.
  catalogSync: {
    PENDING: view('Catalog sync queued', 'info'),
    RUNNING: view('Syncing the catalog from Square', 'info'),
    RETRYING: view('Catalog sync failed, retrying', 'warning'),
    DONE: view('Catalog synced from Square', 'success'),
    FAILED: view('Catalog sync failed', 'danger'),
  },
  builderSession: {
    active: view('In progress', 'info'),
    completed: view('Finished', 'neutral'),
    abandoned: view('Abandoned', 'neutral'),
  },
};

/**
 * A readable form of a raw value this app has no label for. "REFUND_PENDING"
 * becomes "Refund pending" and "google_sheets" becomes "Google sheets".
 * `whenEmpty` is returned for a value that is not text or has no letters or digits.
 */
export function readableLabel(raw: unknown, whenEmpty = 'Unknown'): string {
  if (typeof raw !== 'string') return whenEmpty;
  const words = raw
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : whenEmpty;
}

function lookup(machine: StatusMachine, state: unknown): StatusView | undefined {
  if (typeof state !== 'string' || !Object.hasOwn(TABLE, machine)) return undefined;
  const states: Record<string, StatusView> = TABLE[machine];
  // Object.hasOwn keeps inherited names such as "constructor" from passing as a state.
  return Object.hasOwn(states, state) ? states[state] : undefined;
}

/** True when this app has its own label for the state. False means statusView falls back to a readable form of the raw value. */
export function hasStatusLabel(machine: StatusMachine, state: string): boolean {
  return lookup(machine, state) !== undefined;
}

/**
 * Label and tone for a server state. A state this app does not know, as a
 * later contract version may add, shows in a readable form of its name and in
 * neutral. It is never green, because nothing confirmed it.
 */
export function statusView(machine: StatusMachine, state: string): StatusView {
  return lookup(machine, state) ?? view(readableLabel(state, 'Unknown status'), 'neutral');
}

/** Fact conflicts depend on two fields, so they get their own helper. */
export function conflictView(status: 'open' | 'resolved', required: boolean): StatusView {
  if (status === 'resolved') return view('Resolved', 'neutral');
  if (status === 'open') return required ? view('Conflict, blocks publish', 'danger') : view('Conflict', 'warning');
  // A conflict state this app does not know. It is not shown as open or as blocking.
  return view(readableLabel(status, 'Unknown status'), 'neutral');
}

/**
 * A menu_item draft from an upload is never a price source. Prices always
 * come from Square, so the draft is shown for comparison only.
 */
export const MENU_ITEM_DRAFT_VIEW: StatusView = view('Menu draft, for comparison only', 'neutral');

/**
 * Label and tone for a fact, given its kind. Same as statusView('fact', status)
 * except a menu_item draft, which gets MENU_ITEM_DRAFT_VIEW.
 */
export function factView(kind: string, status: string): StatusView {
  if (kind === 'menu_item' && status === 'draft') return MENU_ITEM_DRAFT_VIEW;
  return statusView('fact', status);
}
