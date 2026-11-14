/**
 * What one price row shows, worked out only from what the server said: the
 * approval state, the execution events of its two steps
 * (square.catalog.price.update, then local.catalog.sync) and the catalog
 * cache. The new price counts as current only when the sync step succeeded
 * and the catalog returns it (screen data map, section 11).
 */
import type {ActivityEvent, ApprovalRequest, BusinessFact, CatalogItem, FactConflict, PriceEditApprovalPayload} from '@/lib/api';
import {errorCodeText} from '@/lib/error-text';
import {formatMoney} from '@/lib/format';
import {menuItemNames} from '@/lib/labels';
import {statusView, type StatusView} from '@/lib/status';
import {conflictVariationId} from '../../_components/knowledge-model';

export const SQUARE_STEP = 'square.catalog.price.update';
export const SYNC_STEP = 'local.catalog.sync';

export type StepOutcome =
  | {status: 'none'}
  | {status: 'running'}
  | {status: 'succeeded'}
  | {status: 'failed'; errorCode: string; nextStatus: string; retryable: boolean};

export type PricePhase =
  | {kind: 'idle'}
  | {kind: 'loading'}
  | {kind: 'pending'; payload: PriceEditApprovalPayload}
  | {kind: 'updating'; payload: PriceEditApprovalPayload}
  /** Square and the sync step succeeded, but the catalog the screen holds does not show the new price yet. */
  | {kind: 'awaiting_catalog'; payload: PriceEditApprovalPayload}
  | {kind: 'verified'; payload: PriceEditApprovalPayload}
  /** Square refused or the result is unknown. */
  | {kind: 'square_failed'; payload: PriceEditApprovalPayload; squarePrice: 'unchanged' | 'unknown'; errorCode: string}
  /** Square took the new price, but the local catalog step failed. */
  | {kind: 'sync_failed'; payload: PriceEditApprovalPayload; errorCode: string}
  | {kind: 'rejected'; payload: PriceEditApprovalPayload}
  | {kind: 'expired'; payload: PriceEditApprovalPayload};

/**
 * What the row says when a step failed. The error code never shows: the
 * sentence for it from errorCodeText says what happened.
 */
export function failureText(phase: Extract<PricePhase, {kind: 'square_failed' | 'sync_failed'}>): string {
  const error = errorCodeText(phase.errorCode);
  if (phase.kind === 'sync_failed') {
    return `Square accepted ${formatMoney(phase.payload.newPriceMinor, phase.payload.currency)} (sandbox), but the catalog here did not refresh. ${error} Run Sync from Square on Business Knowledge to check.`;
  }
  return phase.squarePrice === 'unknown'
    ? `Square did not confirm the change. ${error} The price in Square is unknown until the step is reviewed. The price above is the last one the catalog showed.`
    : `The price in Square is unchanged. Square refused the update. ${error} One cause is a price change in Square since you proposed. Propose again.`;
}

const EXECUTION_TYPES = new Set(['execution.started', 'execution.succeeded', 'execution.failed']);

/**
 * Merges event lists that are each newest first (the REST history and the
 * live feed), drops duplicates by id, keeps only execution events and returns
 * them oldest first. Several steps can share one occurredAt second, so the
 * lists are reversed first and the sort is stable for equal times.
 */
export function mergeExecutionEvents(...newestFirstLists: readonly (readonly ActivityEvent[])[]): ActivityEvent[] {
  const seen = new Map<string, ActivityEvent>();
  for (const list of newestFirstLists) {
    for (const e of [...list].reverse()) if (EXECUTION_TYPES.has(e.type) && !seen.has(e.id)) seen.set(e.id, e);
  }
  return [...seen.values()].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}

/**
 * The outcome of one step of one approval. execution.succeeded and
 * execution.failed carry no approvalId (CONTRACTS 7), so the step is found
 * through the executionId named by its execution.started event.
 */
export function stepOutcome(events: readonly ActivityEvent[], approvalId: string, actionType: string): StepOutcome {
  const ids = new Set<string>();
  for (const e of events) {
    if (e.type !== 'execution.started') continue;
    const p = e.payload as {executionId?: unknown; approvalId?: unknown; actionType?: unknown};
    if (p.approvalId === approvalId && p.actionType === actionType && typeof p.executionId === 'string') ids.add(p.executionId);
  }
  if (ids.size === 0) return {status: 'none'};
  // SUCCEEDED is terminal (CONTRACTS 6, execution), so it wins whatever order the events came in.
  const succeeded = events.some(
    (e) => e.type === 'execution.succeeded' && ids.has(String((e.payload as {executionId?: unknown}).executionId)),
  );
  if (succeeded) return {status: 'succeeded'};
  let outcome: StepOutcome = {status: 'running'};
  for (const e of events) {
    const p = e.payload as {executionId?: unknown; errorCode?: unknown; nextStatus?: unknown; retryable?: unknown};
    if (typeof p.executionId !== 'string' || !ids.has(p.executionId)) continue;
    if (e.type === 'execution.started') outcome = {status: 'running'};
    else if (e.type === 'execution.succeeded') outcome = {status: 'succeeded'};
    else if (e.type === 'execution.failed') {
      outcome = {
        status: 'failed',
        errorCode: typeof p.errorCode === 'string' ? p.errorCode : 'INTERNAL',
        nextStatus: typeof p.nextStatus === 'string' ? p.nextStatus : 'FAILED',
        retryable: p.retryable === true,
      };
    }
  }
  return outcome;
}

/** A failure that goes back to QUEUED is a retry in progress, not an end state (SPEC 2.9). */
function isRetry(o: StepOutcome): boolean {
  return o.status === 'failed' && o.nextStatus === 'QUEUED';
}

export function pricePhase(input: {
  approval?: ApprovalRequest;
  isApprovalLoading?: boolean;
  events: readonly ActivityEvent[];
  catalogPriceMinor: number;
}): PricePhase {
  const {approval, events, catalogPriceMinor} = input;
  if (!approval) return input.isApprovalLoading ? {kind: 'loading'} : {kind: 'idle'};
  const payload = approval.payload as PriceEditApprovalPayload;
  switch (approval.state) {
    case 'PENDING':
      return {kind: 'pending', payload};
    case 'REJECTED':
      return {kind: 'rejected', payload};
    case 'EXPIRED':
      return {kind: 'expired', payload};
    case 'APPROVED':
      break;
  }
  const square = stepOutcome(events, approval.id, SQUARE_STEP);
  if (square.status === 'failed' && !isRetry(square)) {
    return {
      kind: 'square_failed',
      payload,
      squarePrice: square.nextStatus === 'NEEDS_REVIEW' ? 'unknown' : 'unchanged',
      errorCode: square.errorCode,
    };
  }
  const sync = stepOutcome(events, approval.id, SYNC_STEP);
  if (sync.status === 'failed' && !isRetry(sync)) return {kind: 'sync_failed', payload, errorCode: sync.errorCode};
  if (square.status === 'succeeded' && sync.status === 'succeeded') {
    return catalogPriceMinor === payload.newPriceMinor ? {kind: 'verified', payload} : {kind: 'awaiting_catalog', payload};
  }
  return {kind: 'updating', payload};
}

/** The badge for a phase. Tones come from the shared tables; only the labels name the price change. */
export function phaseBadge(phase: PricePhase): StatusView | null {
  switch (phase.kind) {
    case 'idle':
    case 'loading':
      return null;
    case 'pending':
      return {label: 'Waiting for your confirmation', tone: statusView('approval', 'PENDING').tone};
    case 'updating':
    case 'awaiting_catalog':
      return {label: 'Change approved, updating Square', tone: statusView('approval', 'APPROVED').tone};
    case 'verified':
      return {label: 'Price updated in Square (sandbox)', tone: statusView('execution', 'SUCCEEDED').tone};
    case 'square_failed':
      return phase.squarePrice === 'unknown'
        ? {label: 'Square result unknown', tone: statusView('execution', 'NEEDS_REVIEW').tone}
        : {label: 'Square refused the change', tone: statusView('execution', 'FAILED').tone};
    case 'sync_failed':
      return {label: 'Catalog not refreshed', tone: statusView('execution', 'FAILED').tone};
    case 'rejected':
      return {label: 'Rejected, price unchanged', tone: statusView('approval', 'REJECTED').tone};
    case 'expired':
      return {label: 'Expired, price unchanged', tone: statusView('approval', 'EXPIRED').tone};
  }
}

/** A phase in which a new change may be proposed for the row. */
export function canProposeAgain(phase: PricePhase): boolean {
  return !['pending', 'updating', 'awaiting_catalog', 'loading'].includes(phase.kind);
}

// ------------------------------------------------------------ approvals per row

/**
 * Which approval each variation row follows. An approval proposed on this
 * screen wins. Otherwise the newest pending price_edit approval from the
 * server, so a pending confirmation shows after a reload too.
 */
export function approvalByVariation(
  sessionApprovals: Readonly<Record<string, string>>,
  pending: readonly ApprovalRequest[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const newestFirst = [...pending]
    .filter((a) => a.bundleType === 'price_edit' && a.state === 'PENDING')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const a of newestFirst) {
    const variationId = (a.payload as Partial<PriceEditApprovalPayload>).variationId;
    if (typeof variationId === 'string' && !(variationId in out)) out[variationId] = a.id;
  }
  return {...out, ...sessionApprovals};
}

// ------------------------------------------------------------- price conflicts

export type PriceConflictView = {conflictId: string; uploadedPriceMinor?: number};

const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The open menu price conflict for a variation, if any. The docs say a draft
 * menu_item fact is compared with the catalog on item and variation names
 * (DATA-MODEL section 5). A conflict may also name the Square variation, in a
 * candidate's `value.variationId` (the shared fixtures) or as its key. Either
 * match counts.
 */
export function priceConflictFor(
  item: Pick<CatalogItem, 'name'>,
  variation: {id: string; name: string},
  conflicts: readonly FactConflict[],
  facts: readonly BusinessFact[],
): PriceConflictView | null {
  for (const c of conflicts) {
    if (c.kind !== 'menu_item' || c.state !== 'open') continue;
    const upload = c.candidates.find((x) => x.sourceType === 'upload');
    const draft = upload?.factId ? facts.find((f) => f.id === upload.factId) : undefined;
    const names = menuItemNames(draft?.value);
    const byKey = conflictVariationId(c) === variation.id;
    const byName =
      names.item !== undefined &&
      names.variation !== undefined &&
      normalize(names.item) === normalize(item.name) &&
      normalize(names.variation) === normalize(variation.name);
    if (!byKey && !byName) continue;
    const value = (upload?.value ?? {}) as {priceMinor?: unknown};
    return {conflictId: c.id, ...(typeof value.priceMinor === 'number' ? {uploadedPriceMinor: value.priceMinor} : {})};
  }
  return null;
}
