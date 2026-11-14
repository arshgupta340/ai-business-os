/**
 * Pure helpers for the Approvals screen and the decision dialog. Nothing here
 * changes data. Every label is plain text so the components stay thin and the
 * rules are unit tested.
 */
import type {
  ApiError,
  ApprovalRequest,
  ApprovalState,
  BookingApprovalPayload,
  BundleType,
  FactEditApprovalPayload,
  OrderApprovalPayload,
  PriceEditApprovalPayload,
} from '@/lib/api';
import {formatDateTime, formatMoney, lastFour, secondsUntil} from '@/lib/format';

// ------------------------------------------------------------- payloads

/** The payload narrowed by bundleType. The union in the contract has no discriminator. */
export type TypedApproval =
  | {bundleType: 'order_bundle'; approval: ApprovalRequest; payload: OrderApprovalPayload}
  | {bundleType: 'booking_bundle'; approval: ApprovalRequest; payload: BookingApprovalPayload}
  | {bundleType: 'fact_edit'; approval: ApprovalRequest; payload: FactEditApprovalPayload}
  | {bundleType: 'price_edit'; approval: ApprovalRequest; payload: PriceEditApprovalPayload};

export function typedApproval(approval: ApprovalRequest): TypedApproval {
  switch (approval.bundleType) {
    case 'order_bundle':
      return {bundleType: 'order_bundle', approval, payload: approval.payload as OrderApprovalPayload};
    case 'booking_bundle':
      return {bundleType: 'booking_bundle', approval, payload: approval.payload as BookingApprovalPayload};
    case 'fact_edit':
      return {bundleType: 'fact_edit', approval, payload: approval.payload as FactEditApprovalPayload};
    case 'price_edit':
      return {bundleType: 'price_edit', approval, payload: approval.payload as PriceEditApprovalPayload};
  }
}

// ---------------------------------------------------------------- labels

const BUNDLE_LABELS: Record<BundleType, string> = {
  order_bundle: 'Order',
  booking_bundle: 'Booking',
  fact_edit: 'Fact edit',
  price_edit: 'Price edit',
};

export function bundleLabel(bundleType: BundleType): string {
  return BUNDLE_LABELS[bundleType];
}

export function actorLabel(actorType: ApprovalRequest['actorType']): string {
  return actorType === 'owner' ? 'Your own change' : 'Asked by your phone agent';
}

const WEEKDAYS: Record<string, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

const FACT_KIND_LABELS: Record<string, string> = {
  hours: 'Opening hours',
  policy: 'Policy',
  service: 'Service',
  contact: 'Contact',
  faq: 'FAQ',
  menu_item: 'Menu item',
};

export function factKindLabel(kind: string): string {
  return FACT_KIND_LABELS[kind] ?? kind;
}

/** "Sunday" for an hours key, the key itself for anything else. */
export function factKeyLabel(kind: string, key: string): string {
  return kind === 'hours' ? (WEEKDAYS[key] ?? key) : key;
}

/** Shows a fact value as text. `null` means the fact is new (CONTRACTS.md section 4). */
export function formatFactValue(kind: string, value: unknown): string {
  if (value === null || value === undefined) return 'Not set yet (new fact)';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (kind === 'hours' && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if (v.closed === true) return 'Closed';
    if (typeof v.open === 'string' && typeof v.close === 'string') {
      const rest = Object.keys(v).filter((k) => k !== 'open' && k !== 'close');
      const base = `${v.open} to ${v.close}`;
      return rest.length ? `${base}, ${rest.map((k) => `${k}: ${stringify(v[k])}`).join(', ')}` : base;
    }
  }
  if (Array.isArray(value)) return value.map((v) => formatFactValue(kind, v)).join(', ');
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${stringify(v)}`)
      .join(', ');
  }
  return stringify(value);
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * "phone ending 0136" for a phone number, "recipient ending abcd" for anything else.
 * No recipient means the customer declined messages (SPEC 2.9): the payload is qr_only.
 */
export function recipientLabel(recipient: string | undefined): string {
  if (recipient === undefined) return 'no one (the customer declined messages)';
  const looksLikePhone = /^\+?[0-9 ()-]{6,}$/.test(recipient);
  return `${looksLikePhone ? 'phone' : 'recipient'} ending ${lastFour(recipient)}`;
}

/** The one-line summary shown in the inbox row. Uses only the hashed payload. */
export function summaryLine(approval: ApprovalRequest, timeZone: string): string {
  const t = typedApproval(approval);
  switch (t.bundleType) {
    case 'order_bundle':
      return `Pickup ${formatDateTime(t.payload.pickupAt, timeZone)}, link to ${recipientLabel(t.payload.messageRecipient)}`;
    case 'booking_bundle':
      return `${formatDateTime(t.payload.startUtc, t.payload.timezone)}, confirmation to ${recipientLabel(t.payload.messageRecipient)}`;
    case 'fact_edit': {
      const what = `${factKindLabel(t.payload.kind)}, ${factKeyLabel(t.payload.kind, t.payload.key)}`;
      return `${what}: ${formatFactValue(t.payload.kind, t.payload.after)} (now ${formatFactValue(t.payload.kind, t.payload.before)})`;
    }
    case 'price_edit':
      return `Price ${formatMoney(t.payload.fromPriceMinor, t.payload.currency)} to ${formatMoney(t.payload.newPriceMinor, t.payload.currency)}`;
  }
}

// ------------------------------------------------------- external systems

export type ActionStepView = {
  step: string;
  /** Where the write goes, for example "Square" or "Google Sheets". */
  system: string;
  description: string;
  /** False for local.* steps: they write only to this app's database. */
  isExternal: boolean;
  /** True when the step is not in the contract. The owner sees it as is. */
  isUnknown?: boolean;
};

/** Maps each step of the hashed action bundle to the system it writes to (screen data map, section 8). */
export function actionSteps(t: TypedApproval): ActionStepView[] {
  const channel =
    t.bundleType === 'order_bundle' || t.bundleType === 'booking_bundle' ? t.payload.messageChannel : 'the message channel';
  const to =
    t.bundleType === 'order_bundle' || t.bundleType === 'booking_bundle' ? recipientLabel(t.payload.messageRecipient) : 'the customer';
  return t.payload.actionBundle.map((step): ActionStepView => {
    switch (step) {
      case 'square.checkout.create':
        return {step, system: 'Square (sandbox)', description: 'Create a checkout link for the total above.', isExternal: true};
      case 'message.checkout.send':
        return {step, system: `Customer message (${channel})`, description: `Send the checkout link to ${to}.`, isExternal: true};
      case 'local.order.record':
        return {step, system: 'This app', description: 'Record the order. Nothing leaves the app.', isExternal: false};
      case 'sheets.order.append':
        return {step, system: 'Google Sheets', description: 'Add one report row after the payment is verified.', isExternal: true};
      case 'calendar.event.create': {
        const cal = t.bundleType === 'booking_bundle' ? ` on calendar ${t.payload.calendarId}` : '';
        return {step, system: 'Google Calendar', description: `Create the event${cal} after a fresh availability check.`, isExternal: true};
      }
      case 'message.booking.confirm':
        return {step, system: `Customer message (${channel})`, description: `Tell ${to} the booking is confirmed.`, isExternal: true};
      case 'local.booking.record':
        return {step, system: 'This app', description: 'Record the booking. Nothing leaves the app.', isExternal: false};
      case 'sheets.booking.append':
        return {step, system: 'Google Sheets', description: 'Add one report row after the booking is verified.', isExternal: true};
      case 'local.fact.update':
        return {step, system: 'This app', description: 'Save the new value in your business facts. Nothing is sent to a customer.', isExternal: false};
      case 'square.catalog.price.update':
        return {step, system: 'Square (sandbox)', description: 'Change the price in the Square catalog.', isExternal: true};
      case 'local.catalog.sync':
        return {step, system: 'This app', description: 'Refresh the local copy of the catalog.', isExternal: false};
      default:
        return {step, system: 'Unknown step', description: `The request lists a step this screen does not know: ${step}.`, isExternal: true, isUnknown: true};
    }
  });
}

// --------------------------------------------------------------- state

/**
 * The state to show. A PENDING approval whose expiresAt has passed is shown as
 * EXPIRED at once, before the server sweep reaches it, so it cannot be acted on.
 */
export function effectiveState(approval: Pick<ApprovalRequest, 'state' | 'expiresAt'>, now: number): ApprovalState {
  if (approval.state === 'PENDING' && secondsUntil(approval.expiresAt, now) <= 0) return 'EXPIRED';
  return approval.state;
}

export function canDecide(approval: Pick<ApprovalRequest, 'state' | 'expiresAt'>, now: number): boolean {
  return effectiveState(approval, now) === 'PENDING';
}

/** Pending first (soonest to expire first), then the rest, newest first. */
export function sortInbox(items: readonly ApprovalRequest[]): ApprovalRequest[] {
  const rank = (a: ApprovalRequest) => (a.state === 'PENDING' ? 0 : 1);
  return [...items].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    if (a.state === 'PENDING') return Date.parse(a.expiresAt) - Date.parse(b.expiresAt);
    const at = (x: ApprovalRequest) => Date.parse(x.decidedAt ?? x.createdAt);
    return at(b) - at(a);
  });
}

// --------------------------------------------------------------- errors

export type DecisionErrorView = {
  title: string;
  message: string;
  /** What the owner can do next. */
  next: 'reload' | 'retry' | 'sign_in' | 'close' | 'none';
  /** Banner status. */
  status: 'error' | 'warning';
  correlationId?: string;
  /** For APPROVAL_ALREADY_DECIDED: the state the server reports in details.state. */
  decidedState?: string;
};

/** What to tell the owner for each error the decision can return (API.md 3.7 and section 2). */
export function decisionErrorView(error: ApiError): DecisionErrorView {
  const correlationId = error.correlationId;
  switch (error.code) {
    case 'PAYLOAD_HASH_MISMATCH':
      return {
        title: 'This request changed since you opened it',
        message: 'Nothing was sent. Reload it and read the new details before you decide.',
        next: 'reload',
        status: 'warning',
        correlationId,
      };
    case 'APPROVAL_ALREADY_DECIDED': {
      const state = typeof error.details?.state === 'string' ? error.details.state : undefined;
      return {
        title: 'Already decided',
        message: 'A different decision was already recorded for this request. Nothing else was sent.',
        next: 'none',
        status: 'warning',
        correlationId,
        decidedState: state,
      };
    }
    case 'APPROVAL_EXPIRED':
      return {
        title: 'Expired, nothing was sent',
        message: 'This request passed its 10 minute limit. The caller has to ask again.',
        next: 'none',
        status: 'warning',
        correlationId,
      };
    case 'NOT_FOUND':
      return {
        title: 'Not found in this business',
        message: 'This request does not exist in the selected business. Go back to the list.',
        next: 'close',
        status: 'error',
        correlationId,
      };
    case 'ENVIRONMENT_MISMATCH':
      return {
        title: 'Square is not in sandbox',
        message: 'Square is not in sandbox. Nothing was sent.',
        next: 'none',
        status: 'error',
        correlationId,
      };
    case 'UNAUTHENTICATED':
      return {title: 'You are signed out', message: 'Sign in again, then open this request.', next: 'sign_in', status: 'error', correlationId};
    case 'FORBIDDEN_BUSINESS':
      return {title: 'No access', message: 'You do not have access to this business.', next: 'close', status: 'error', correlationId};
    default:
      if (error.kind === 'network') {
        return {
          title: 'Could not reach the server',
          message: 'Your decision may not have arrived. Try again: the retry is safe and is not counted twice.',
          next: 'retry',
          status: 'error',
          correlationId,
        };
      }
      return {
        title: 'The decision did not go through',
        message: error.message,
        next: error.retryable ? 'retry' : 'none',
        status: 'error',
        correlationId,
      };
  }
}
