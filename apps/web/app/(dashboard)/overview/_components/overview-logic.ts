/**
 * Pure helpers for the Overview screen. No React here, so each one is unit
 * tested on its own (overview-logic.test.ts).
 */
import {payloadOf, type ActivityEvent, type Agent, type Booking, type Call, type Order} from '@/lib/api';
import {formatDateTime, formatMoney} from '@/lib/format';
import {actionLabel, eventTypeLabel, factKeyLabel, factKindLabel, providerLabel} from '@/lib/labels';
import {statusView} from '@/lib/status';

// ------------------------------------------------------------- time zones

/** Milliseconds that `timeZone` is ahead of UTC at the instant `utcMs`. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Local midnight of the current day in `timeZone`, as a UTC ISO string.
 * This is the `since` value for "today's calls" (screen data map, Overview).
 * The result stays the same for every `now` within one local day, so it is
 * safe to use in a query key.
 */
export function startOfTodayUtc(timeZone: string, now: number = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wallMidnight = Date.UTC(get('year'), get('month') - 1, get('day'));
  // First guess with the offset at midnight UTC, then correct once with the
  // offset at the guessed instant (handles a DST change during the day).
  let utc = wallMidnight - zoneOffsetMs(wallMidnight, timeZone);
  utc = wallMidnight - zoneOffsetMs(utc, timeZone);
  return new Date(utc).toISOString();
}

// ------------------------------------------------------------------ calls

export type CallsSummary = {
  total: number;
  inProgress: number;
  lost: number;
  failed: number;
  simulated: number;
};

/** Counts for the calls that started at or after `sinceIso`. */
export function summarizeCalls(calls: readonly Call[], sinceIso: string): CallsSummary {
  const today = calls.filter((c) => c.startedAt >= sinceIso);
  return {
    total: today.length,
    inProgress: today.filter((c) => c.status === 'IN_PROGRESS').length,
    lost: today.filter((c) => c.status === 'DROPPED').length,
    failed: today.filter((c) => c.status === 'FAILED').length,
    simulated: today.filter((c) => c.channel === 'test_console').length,
  };
}

/** Calls from `sinceIso` on, newest first. */
export function callsSince(calls: readonly Call[], sinceIso: string): Call[] {
  return calls.filter((c) => c.startedAt >= sinceIso).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Short label for one call row. A test console call is always "Simulated call" (data map rule 6). */
export function callTitle(call: Call): string {
  if (call.channel === 'test_console') return 'Simulated call';
  return call.callerLast4 ? `Caller ending ${call.callerLast4}` : 'Phone call';
}

// ----------------------------------------------------------------- orders

export type OrderGroupKey = 'waiting' | 'creatingCheckout' | 'linkSent' | 'paid' | 'needsReview' | 'closed';

export type OrderGroupDef = {
  key: OrderGroupKey;
  title: string;
  statuses: readonly Order['status'][];
  /** The state whose tone (from statusView) the group shows. */
  toneState: Order['status'];
  /** True when the group holds payment data, so it needs a sandbox label. */
  payment: boolean;
};

export const ORDER_GROUPS: readonly OrderGroupDef[] = [
  {
    key: 'waiting',
    title: 'Proposed, waiting for your approval',
    statuses: ['AWAITING_OWNER_APPROVAL'],
    toneState: 'AWAITING_OWNER_APPROVAL',
    payment: false,
  },
  {
    key: 'creatingCheckout',
    title: 'Approved, creating checkout',
    statuses: ['APPROVED', 'CREATING_CHECKOUT'],
    toneState: 'CREATING_CHECKOUT',
    payment: true,
  },
  {
    key: 'linkSent',
    title: 'Link sent, not paid',
    statuses: ['PAYMENT_LINK_READY', 'MESSAGE_SENT', 'PAYMENT_PENDING'],
    toneState: 'PAYMENT_PENDING',
    payment: true,
  },
  {
    key: 'paid',
    title: 'Paid, verified',
    // AC-12: only these two count as paid. PAYMENT_PENDING never does.
    statuses: ['PAID_VERIFIED', 'FULFILLMENT_READY'],
    toneState: 'PAID_VERIFIED',
    payment: true,
  },
  {
    key: 'needsReview',
    title: 'Payment failed or needs your review',
    statuses: ['PAYMENT_FAILED', 'RECOVERY_REQUIRED'],
    toneState: 'PAYMENT_FAILED',
    payment: true,
  },
  {
    key: 'closed',
    title: 'Closed, nothing charged',
    statuses: ['REJECTED', 'APPROVAL_EXPIRED', 'CANCELLED', 'UNAVAILABLE'],
    toneState: 'REJECTED',
    payment: false,
  },
];

export type OrderGroup = OrderGroupDef & {count: number; totalMinor: number; currency: string};

/** Groups orders by status. Every group is returned, also when its count is 0. */
export function groupOrders(orders: readonly Order[]): OrderGroup[] {
  return ORDER_GROUPS.map((def) => {
    const inGroup = orders.filter((o) => def.statuses.includes(o.status));
    return {
      ...def,
      count: inGroup.length,
      totalMinor: inGroup.reduce((sum, o) => sum + o.totalMinor, 0),
      currency: inGroup[0]?.currency ?? 'USD',
    };
  });
}

// --------------------------------------------------------------- bookings

export type BookingGroupKey = 'waiting' | 'checking' | 'booked' | 'needsReview' | 'closed';

export type BookingGroupDef = {
  key: BookingGroupKey;
  title: string;
  statuses: readonly Booking['status'][];
  toneState: Booking['status'];
};

export const BOOKING_GROUPS: readonly BookingGroupDef[] = [
  {key: 'waiting', title: 'Proposed, waiting for your approval', statuses: ['AWAITING_OWNER_APPROVAL'], toneState: 'AWAITING_OWNER_APPROVAL'},
  {key: 'checking', title: 'Approved, checking the calendar', statuses: ['RECHECKING_SLOT'], toneState: 'RECHECKING_SLOT'},
  {key: 'booked', title: 'Booked, verified', statuses: ['BOOKED_VERIFIED'], toneState: 'BOOKED_VERIFIED'},
  {key: 'needsReview', title: 'Slot taken or needs your review', statuses: ['SLOT_CONFLICT', 'RETRY_REQUIRED'], toneState: 'SLOT_CONFLICT'},
  {key: 'closed', title: 'Closed, nothing booked', statuses: ['REJECTED', 'EXPIRED'], toneState: 'REJECTED'},
];

export type BookingGroup = BookingGroupDef & {count: number};

export function groupBookings(bookings: readonly Booking[]): BookingGroup[] {
  return BOOKING_GROUPS.map((def) => ({...def, count: bookings.filter((b) => def.statuses.includes(b.status)).length}));
}

// ----------------------------------------------------------------- business

export type BusinessFlow = 'orders' | 'bookings' | 'both';

/** The pizza shop takes orders, the barbershop takes bookings. An unknown category shows both. */
export function businessFlow(category: string | undefined): BusinessFlow {
  if (category === 'restaurant') return 'orders';
  if (category === 'barbershop') return 'bookings';
  return 'both';
}

// ------------------------------------------------------------------ agents

// Template names come from agentTemplateLabel in '@/lib/labels'.

/** "Version 2" from the active version, or a note when nothing is published. */
export function versionLabel(agent: Agent): string {
  if (agent.activeVersion) return `Version ${agent.activeVersion.version}`;
  if (agent.activeVersionId) return 'Published version';
  return 'Not published yet';
}

/** Live agents first, then by name. */
export function sortAgents(agents: readonly Agent[]): Agent[] {
  return [...agents].sort((a, b) => Number(b.isLiveAgent) - Number(a.isLiveAgent) || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- activity

export type EventLine = {
  title: string;
  /** True for payment data (amounts, checkout, payment events): show a sandbox label. */
  payment: boolean;
};

/**
 * One plain sentence per activity event for the recent activity list.
 * Labels for order and booking states come from statusView so a state reads
 * the same here as on every other screen.
 */
export function describeEvent(
  event: ActivityEvent,
  options: {timeZone: string; agentName?: (agentId: string) => string | undefined},
): EventLine {
  const {timeZone} = options;
  const agentName = (id: string | undefined) => (id ? options.agentName?.(id) : undefined);
  const money = (minor: unknown, currency: unknown) =>
    typeof minor === 'number' ? formatMoney(minor, typeof currency === 'string' ? currency : 'USD') : undefined;

  switch (event.type) {
    case 'call.started': {
      const p = payloadOf({...event, type: 'call.started'});
      if (p.channel === 'test_console') return {title: 'Simulated call started', payment: false};
      return {title: p.callerLast4 ? `Call started, caller ending ${p.callerLast4}` : 'Call started', payment: false};
    }
    case 'call.ended': {
      const p = payloadOf({...event, type: 'call.ended'});
      if (p.reason === 'dropped') return {title: 'Call lost', payment: false};
      if (p.reason === 'failed') return {title: 'Call failed', payment: false};
      return {title: 'Call ended', payment: false};
    }
    case 'proposal.created': {
      const p = payloadOf({...event, type: 'proposal.created'});
      if (p.subjectType === 'booking') {
        return {title: p.serviceName ? `Booking proposed: ${p.serviceName}` : 'Booking proposed', payment: false};
      }
      const total = money(p.totalMinor, p.currency);
      return {title: total ? `Order proposed, ${total}` : 'Order proposed', payment: total !== undefined};
    }
    case 'approval.requested': {
      const p = payloadOf({...event, type: 'approval.requested'});
      const total = money(p.totalMinor, 'USD');
      return {title: total ? `Approval requested, ${total}` : 'Approval requested', payment: total !== undefined};
    }
    case 'approval.decided': {
      const p = payloadOf({...event, type: 'approval.decided'});
      return {title: p.decision === 'APPROVED' ? 'Request approved' : 'Request rejected', payment: false};
    }
    case 'approval.expired':
      return {title: 'Approval expired, nothing was done', payment: false};
    case 'execution.started':
      return {title: `Step started: ${actionLabel(payloadOf({...event, type: 'execution.started'}).actionType)}`, payment: false};
    case 'execution.succeeded':
      return {title: `Step done: ${actionLabel(payloadOf({...event, type: 'execution.succeeded'}).actionType)}`, payment: false};
    case 'execution.failed':
      return {title: `Step failed: ${actionLabel(payloadOf({...event, type: 'execution.failed'}).actionType)}`, payment: false};
    case 'checkout.created': {
      const p = payloadOf({...event, type: 'checkout.created'});
      const total = money(p.totalMinor, p.currency);
      return {title: total ? `Checkout link created, ${total}` : 'Checkout link created', payment: true};
    }
    case 'message.sent':
      return {title: 'Message sent to the customer', payment: false};
    case 'message.failed': {
      const p = payloadOf({...event, type: 'message.failed'});
      return {title: statusView('messageDispatch', p.status).label, payment: false};
    }
    case 'payment.verified': {
      const p = payloadOf({...event, type: 'payment.verified'});
      const amount = money(p.amountMinor, p.currency);
      return {title: amount ? `Payment verified, ${amount}` : 'Payment verified', payment: true};
    }
    case 'payment.failed':
      return {title: 'Payment failed', payment: true};
    case 'booking.verified': {
      const p = payloadOf({...event, type: 'booking.verified'});
      const when = p.startUtc ? formatDateTime(p.startUtc, p.timezone || timeZone) : undefined;
      return {title: when ? `Booked: ${p.serviceName}, ${when}` : `Booked: ${p.serviceName}`, payment: false};
    }
    case 'booking.slot_conflict':
      return {title: 'Slot taken, alternatives ready', payment: false};
    case 'order.status_changed': {
      const p = payloadOf({...event, type: 'order.status_changed'});
      // Without orderId the event is a call stage change (data map, Overview).
      if (!p.orderId) return {title: `Call: ${statusView('callStage', p.to).label}`, payment: false};
      const view = statusView('order', p.to);
      return {title: `Order: ${view.label}`, payment: true};
    }
    case 'booking.status_changed': {
      const p = payloadOf({...event, type: 'booking.status_changed'});
      if (!p.bookingId) return {title: `Call: ${statusView('callStage', p.to).label}`, payment: false};
      return {title: `Booking: ${statusView('booking', p.to).label}`, payment: false};
    }
    case 'sync.queued':
    case 'sync.succeeded':
    case 'sync.failed': {
      const p = payloadOf({...event, type: 'sync.failed'});
      const what = p.target === 'catalog' ? 'Catalog sync' : 'Sheets report';
      if (event.type === 'sync.queued') return {title: `${what} queued`, payment: false};
      if (event.type === 'sync.succeeded') return {title: `${what} done`, payment: false};
      return {title: p.final ? `${what} failed` : `${what} failed, retrying`, payment: false};
    }
    case 'fact.changed': {
      const p = payloadOf({...event, type: 'fact.changed'});
      return {title: `Business fact updated: ${factKindLabel(p.kind)}, ${factKeyLabel(p.kind, p.key)}`, payment: false};
    }
    case 'extraction.completed': {
      const p = payloadOf({...event, type: 'extraction.completed'});
      if (p.extractionState === 'FAILED') return {title: 'Could not read an uploaded file', payment: false};
      return {title: `File read: ${p.draftFactCount} draft facts to review`, payment: false};
    }
    case 'agent.published': {
      const p = payloadOf({...event, type: 'agent.published'});
      const name = agentName(p.agentId) ?? 'Agent';
      return {title: `${name} published as version ${p.version}`, payment: false};
    }
    case 'agent.paused': {
      const p = payloadOf({...event, type: 'agent.paused'});
      return {title: `${agentName(p.agentId) ?? 'Agent'} paused`, payment: false};
    }
    case 'live_agent.changed': {
      const p = payloadOf({...event, type: 'live_agent.changed'});
      const name = agentName(p.agentId);
      return {title: name ? `${name} now answers the phone number` : 'Another agent now answers the phone number', payment: false};
    }
    case 'guardrail.refused':
      return {title: 'The agent refused a request it may not handle', payment: false};
    case 'webhook.rejected': {
      const p = payloadOf({...event, type: 'webhook.rejected'});
      return {title: `${providerLabel(p.provider)} webhook rejected, nothing changed`, payment: p.provider === 'square'};
    }
    default:
      // A type this app does not know gets a generic title, never the raw type.
      return {title: eventTypeLabel((event as ActivityEvent).type), payment: false};
  }
}
