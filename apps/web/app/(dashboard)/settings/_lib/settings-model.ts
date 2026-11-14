/**
 * Pure logic for the Settings screen (U-09). No React here, so every rule is
 * unit tested in settings-model.test.ts.
 *
 * Hours values use the shape from docs/CONTRACTS.md and the fixtures:
 * { open: "HH:MM", close: "HH:MM" } or { closed: true }, one fact per weekday.
 */
import type {ActivityEvent, ActivityPayloads, ApprovalRequest, BusinessFact, FactEditApprovalPayload, FactKind} from '@/lib/api';
import {
  WEEKDAYS,
  WEEKDAY_NAMES,
  describeValue,
  factKeyLabel,
  sourceTypeLabel,
  type Weekday,
} from '../../knowledge/_components/knowledge-model';

export {WEEKDAYS, WEEKDAY_NAMES, type Weekday};

// ------------------------------------------------------------------ hours

export type HoursValue = {open: string; close: string} | {closed: true};

export type HoursRowModel = {day: Weekday; label: string; verified?: BusinessFact};

/**
 * One row per weekday, Monday first, from the verified hours facts only.
 * Drafts and replaced rows never show as the current hours.
 */
export function hoursRows(facts: readonly BusinessFact[]): HoursRowModel[] {
  return WEEKDAYS.map((day) => {
    let verified: BusinessFact | undefined;
    for (const fact of facts) {
      if (fact.kind !== 'hours' || fact.key !== day || fact.status !== 'verified') continue;
      // At most one verified row per kind and key. If the server ever sends two, keep the newer version.
      if (!verified || fact.version > verified.version) verified = fact;
    }
    return {day, label: WEEKDAY_NAMES[day], verified};
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isClosed(value: unknown): boolean {
  return isRecord(value) && value.closed === true;
}

/** The open and close times of a value, or undefined when the value is not an open-hours value. */
export function openClose(value: unknown): {open: string; close: string} | undefined {
  if (isRecord(value) && typeof value.open === 'string' && typeof value.close === 'string') {
    return {open: value.open, close: value.close};
  }
  return undefined;
}

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "9:05" and "09:05:00" become "09:05". Anything that is not a valid 24-hour time gives undefined. */
export function normalizeClock(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(input.trim());
  if (!match) return undefined;
  const text = `${match[1].padStart(2, '0')}:${match[2]}`;
  return CLOCK.test(text) ? text : undefined;
}

export type HoursInput = {closed: boolean; open?: string; close?: string};

export type HoursCheck =
  | {ok: true; value: HoursValue}
  | {ok: false; errors: {open?: string; close?: string; form?: string}};

/**
 * Checks the editor input and builds the value to propose. Close must be later
 * than open on the same day. No document defines hours past midnight, so they
 * are refused here rather than guessed.
 */
export function checkHoursInput(input: HoursInput, current?: unknown): HoursCheck {
  let value: HoursValue;
  if (input.closed) {
    value = {closed: true};
  } else {
    const open = normalizeClock(input.open);
    const close = normalizeClock(input.close);
    const errors: {open?: string; close?: string} = {};
    if (!input.open) errors.open = 'Enter an opening time.';
    else if (!open) errors.open = 'Enter a time like 11:00 AM.';
    if (!input.close) errors.close = 'Enter a closing time.';
    else if (!close) errors.close = 'Enter a time like 11:00 PM.';
    if (errors.open || errors.close) return {ok: false, errors};
    if (close! <= open!) {
      return {ok: false, errors: {close: 'The closing time must be later than the opening time on the same day.'}};
    }
    value = {open: open!, close: close!};
  }
  if (current !== undefined && sameHours(current, value)) {
    return {ok: false, errors: {form: 'These are already the hours for this day.'}};
  }
  return {ok: true, value};
}

export function sameHours(a: unknown, b: unknown): boolean {
  if (isClosed(a) || isClosed(b)) return isClosed(a) && isClosed(b);
  const x = openClose(a);
  const y = openClose(b);
  return !!x && !!y && normalizeClock(x.open) === normalizeClock(y.open) && normalizeClock(x.close) === normalizeClock(y.close);
}

/** The editor's starting input for a day: its current value, or closed when nothing is set. */
export function initialHoursInput(current: unknown): HoursInput {
  const times = openClose(current);
  if (times) return {closed: false, open: normalizeClock(times.open) ?? times.open, close: normalizeClock(times.close) ?? times.close};
  return {closed: isClosed(current), open: undefined, close: undefined};
}

// ------------------------------------------------------------- approvals

export type FactEditApproval = ApprovalRequest & {bundleType: 'fact_edit'; payload: FactEditApprovalPayload};

export function asFactEdit(approval: ApprovalRequest | undefined): FactEditApproval | undefined {
  return approval && approval.bundleType === 'fact_edit' ? (approval as FactEditApproval) : undefined;
}

/** The newest pending fact_edit approval for one kind and key. */
export function pendingEditFor(approvals: readonly ApprovalRequest[], kind: FactKind, key: string): FactEditApproval | undefined {
  let found: FactEditApproval | undefined;
  for (const approval of approvals) {
    const edit = asFactEdit(approval);
    if (!edit || edit.state !== 'PENDING') continue;
    if (edit.payload.kind !== kind || edit.payload.key !== key) continue;
    if (!found || edit.createdAt > found.createdAt) found = edit;
  }
  return found;
}

/**
 * Where a confirmation stands, for the row that proposed it.
 * - waiting: the owner has not confirmed yet.
 * - saving: approved, but the refetched verified fact does not show the change yet.
 * - saved: the verified fact is the new version.
 * - discarded, expired: nothing changed.
 */
export type EditPhase = 'waiting' | 'saving' | 'saved' | 'discarded' | 'expired';

export function editPhase(
  state: ApprovalRequest['state'],
  payload: Pick<FactEditApprovalPayload, 'fromVersion' | 'after'>,
  verified: BusinessFact | undefined,
): EditPhase {
  if (state === 'PENDING') return 'waiting';
  if (state === 'REJECTED') return 'discarded';
  if (state === 'EXPIRED') return 'expired';
  if (verified && verified.version > payload.fromVersion) return 'saved';
  return 'saving';
}

// ---------------------------------------------------------------- policies

/**
 * A policy value the owner can edit here. Only the two flat shapes in the
 * fixtures: { minutes: number } and { allowed: boolean }. Anything else is shown read-only.
 */
export type PolicyShape = {type: 'minutes'; minutes: number} | {type: 'allowed'; allowed: boolean};

export function policyShape(value: unknown): PolicyShape | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 1) return undefined;
  if (keys[0] === 'minutes' && typeof value.minutes === 'number' && Number.isInteger(value.minutes)) {
    return {type: 'minutes', minutes: value.minutes};
  }
  if (keys[0] === 'allowed' && typeof value.allowed === 'boolean') return {type: 'allowed', allowed: value.allowed};
  return undefined;
}

/** The longest window accepted here: one day. No document sets a limit. */
export const MAX_POLICY_MINUTES = 24 * 60;

export function checkMinutesInput(text: string, current?: number): {ok: true; value: {minutes: number}} | {ok: false; error: string} {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return {ok: false, error: 'Enter a whole number of minutes.'};
  const minutes = Number(trimmed);
  if (minutes < 1 || minutes > MAX_POLICY_MINUTES) return {ok: false, error: `Enter a number from 1 to ${MAX_POLICY_MINUTES}.`};
  if (current === minutes) return {ok: false, error: 'This is already the current value.'};
  return {ok: true, value: {minutes}};
}

// --------------------------------------------------------------- change log

export type ChangeLogEntry = {
  id: string;
  what: string;
  /** The value before, when the facts list still has it. */
  before?: string;
  /** The value after, when the facts list still has it. */
  after?: string;
  versions: string;
  who: string;
  occurredAt: string;
};

function factSubject(kind: FactKind, key: string, value: unknown): string {
  const label = factKeyLabel(kind, key, value);
  return kind === 'hours' ? `${label} opening hours` : label;
}

/**
 * Turns fact.changed events into plain lines, newest first. The event carries
 * versions only (CONTRACTS.md section 7), so the before and after values come
 * from the facts list: the new row by factId, the old row by supersedesId.
 */
export function changeLogEntries(events: readonly ActivityEvent[], facts: readonly BusinessFact[]): ChangeLogEntry[] {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const entries: ChangeLogEntry[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.type !== 'fact.changed' || seen.has(event.id)) continue;
    seen.add(event.id);
    const p = event.payload as unknown as Partial<ActivityPayloads['fact.changed']>;
    if (typeof p.kind !== 'string' || typeof p.key !== 'string') continue;
    const kind = p.kind as FactKind;
    const next = typeof p.factId === 'string' ? byId.get(p.factId) : undefined;
    const previous =
      (next?.supersedesId ? byId.get(next.supersedesId) : undefined) ??
      facts.find(
        (f) => f.kind === kind && f.key === p.key && f.version === p.fromVersion && f.verifiedAt !== undefined && f.id !== next?.id,
      );
    const fromVersion = typeof p.fromVersion === 'number' ? p.fromVersion : undefined;
    const toVersion = typeof p.toVersion === 'number' ? p.toVersion : undefined;
    entries.push({
      id: event.id,
      what: factSubject(kind, p.key, next?.value ?? previous?.value),
      before: fromVersion === 0 ? 'Not set' : previous ? describeValue(kind, previous.value).text : undefined,
      after: next ? describeValue(kind, next.value).text : undefined,
      versions:
        fromVersion !== undefined && toVersion !== undefined
          ? fromVersion === 0
            ? `New, version ${toVersion}`
            : `Version ${fromVersion} to ${toVersion}`
          : '',
      who: typeof p.sourceType === 'string' ? sourceTypeLabel(p.sourceType as BusinessFact['sourceType']) : 'Unknown',
      occurredAt: event.occurredAt,
    });
  }
  return entries.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

// ----------------------------------------------------------------- profile

export type ProfileInput = {name: string; phone: string; email: string; address: string};

export type ProfileCheck =
  | {ok: true; patch: {name: string; contact: {phone?: string; email?: string; address?: string}}}
  | {ok: false; errors: Partial<Record<keyof ProfileInput, string>>};

/**
 * Builds the PATCH body: name and contact only (docs/API.md 3.1). An empty
 * contact field is left out, because optional fields are absent, never null.
 */
export function checkProfileInput(input: ProfileInput): ProfileCheck {
  const errors: Partial<Record<keyof ProfileInput, string>> = {};
  const name = input.name.trim();
  if (!name) errors.name = 'Enter the business name.';
  const email = input.email.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter an email address like owner@example.com.';
  const phone = input.phone.trim();
  if (phone && !/^\+?[\d\s().-]{7,20}$/.test(phone)) errors.phone = 'Enter a phone number like +1 555 555 0100.';
  if (Object.keys(errors).length) return {ok: false, errors};
  const contact: {phone?: string; email?: string; address?: string} = {};
  if (phone) contact.phone = phone;
  if (email) contact.email = email;
  const address = input.address.trim();
  if (address) contact.address = address;
  return {ok: true, patch: {name, contact}};
}

export function profileFromBusiness(b: {name: string; contact?: {phone?: string; email?: string; address?: string}}): ProfileInput {
  return {name: b.name, phone: b.contact?.phone ?? '', email: b.contact?.email ?? '', address: b.contact?.address ?? ''};
}

export function sameProfile(a: ProfileInput, b: ProfileInput): boolean {
  return (
    a.name.trim() === b.name.trim() &&
    a.phone.trim() === b.phone.trim() &&
    a.email.trim() === b.email.trim() &&
    a.address.trim() === b.address.trim()
  );
}
