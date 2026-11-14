/**
 * One place that maps every server state to a label and a tone, so the same
 * state looks the same on every screen.
 *
 * Rule: the `success` tone (green) is only for states the server or the
 * provider confirmed. Nothing here is green for a state that is still waiting.
 * Every payment label says sandbox.
 */

export type Tone = 'neutral' | 'info' | 'warning' | 'danger' | 'success';

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
  | 'integration';

const view = (label: string, tone: Tone): StatusView => ({label, tone});

const TABLE: Record<StatusMachine, Record<string, StatusView>> = {
  order: {
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
  },
  call: {
    IN_PROGRESS: view('On the call', 'info'),
    COMPLETED: view('Call ended', 'neutral'),
    DROPPED: view('Call lost', 'warning'),
    FAILED: view('Call failed', 'danger'),
  },
  callStage: {
    CALL_STARTED: view('Call started', 'info'),
    COLLECTING: view('Taking the order', 'info'),
    VALIDATING: view('Checking the order', 'info'),
    CUSTOMER_CONFIRMED: view('Customer confirmed', 'info'),
    INQUIRY: view('Asking what they need', 'info'),
    SLOT_SEARCH: view('Looking for a time', 'info'),
    PROPOSAL: view('Offering a time', 'info'),
    UNAVAILABLE: view('Item unavailable, choosing again', 'warning'),
  },
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
};

/** Label and tone for a server state. An unknown state shows as itself, in neutral. */
export function statusView(machine: StatusMachine, state: string): StatusView {
  return TABLE[machine][state] ?? view(state, 'neutral');
}

/** Fact conflicts depend on two fields, so they get their own helper. */
export function conflictView(status: 'open' | 'resolved', required: boolean): StatusView {
  if (status === 'resolved') return view('Resolved', 'neutral');
  return required ? view('Conflict, blocks publish', 'danger') : view('Conflict', 'warning');
}
