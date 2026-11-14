import { ERROR_CODE_INFO, type Booking, type Order } from '@abos/contracts';
import type { AppendOnceInput, ReportingAdapter, ReportingFailure, ReportingResult, ReportingRow, SheetsDependencies } from './types';

export type * from './types';

const DEFAULT_TIMEOUT_MS = 8000;

/** Reporting columns. No phone number and no customer name, ever. */
export const REPORTING_HEADER: readonly string[] = ['record_id', 'type', 'business', 'status', 'total_minor', 'currency', 'service', 'start_utc', 'created_at', 'environment'];

/**
 * Reporting row for a paid order. `recordId` defaults to the order id; pass the
 * sync job's idempotency key instead if the job runner uses that (CONTRACTS 5).
 * Amounts are integer minor units. Payment data is always labelled sandbox.
 */
export function orderRow(order: Order, recordId: string = order.id): ReportingRow {
  return [recordId, 'order', order.businessId, order.status, order.totalMinor, order.currency, '', '', order.createdAt, 'sandbox'];
}

/** Reporting row for a verified booking. No customer fields. */
export function bookingRow(booking: Booking, recordId: string = booking.id): ReportingRow {
  return [recordId, 'booking', booking.businessId, booking.status, '', '', booking.serviceName, booking.startUtc, booking.createdAt, ''];
}

function unavailable(): ReportingFailure {
  return { ok: false, reason: 'INTEGRATION_UNAVAILABLE', retryable: ERROR_CODE_INFO.INTEGRATION_UNAVAILABLE.retryable };
}
function invalid(): ReportingFailure {
  return { ok: false, reason: 'VALIDATION_FAILED', retryable: ERROR_CODE_INFO.VALIDATION_FAILED.retryable };
}

class ProviderTimeout extends Error {
  override name = 'ProviderTimeout';
}

/** Rejects when the call takes longer than `ms`. The provider call itself may still complete. */
async function withTimeout<T>(ms: number, call: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ProviderTimeout()), ms); });
  try { return await Promise.race([call(), timeout]); }
  finally { clearTimeout(timer); }
}

function isBlank(value: unknown): boolean {
  return value === '' || value === null || value === undefined;
}

/**
 * Google Sheets reporting adapter. Only the reporting sync job calls it, after
 * the order reaches PAID_VERIFIED or the booking BOOKED_VERIFIED (SPEC 2.9).
 * Every provider error or timeout becomes a typed retryable failure.
 */
export function createSheetsAdapter(deps: SheetsDependencies): ReportingAdapter {
  const values = deps.client.spreadsheets.values;
  const ms = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Serializes calls per tab inside this instance only.
  const pending = new Map<string, Promise<ReportingResult>>();

  async function append(input: AppendOnceInput): Promise<ReportingResult> {
    if (!input.sheetId.trim() || !input.tab.trim() || !input.recordId.trim() || input.row[0] !== input.recordId) return invalid();
    try {
      const title = `'${input.tab.replace(/'/g, "''")}'`;
      // Google Sheets has no conditional append and no idempotency key, so
      // read-then-append is not atomic. That is safe because exactly one sync
      // job exists per record (sync_jobs is unique on target, record type and
      // record id, enforced by the job runner), so two appends for the same
      // record never race. The same read also reconciles a retry after an
      // append whose response was lost.
      const response = await withTimeout(ms, () => values.get({
        spreadsheetId: input.sheetId, range: `${title}!A:A`, majorDimension: 'COLUMNS', valueRenderOption: 'UNFORMATTED_VALUE',
      }));
      const ids = response.data.values?.[0] ?? [];
      if (ids.some(id => String(id) === input.recordId)) return { ok: true, status: 'skipped' };
      if (ids.every(isBlank)) {
        await withTimeout(ms, () => values.update({
          spreadsheetId: input.sheetId, range: `${title}!A1`, valueInputOption: 'RAW', requestBody: { values: [[...REPORTING_HEADER]] },
        }));
      }
      // RAW so provider or caller text can never become a formula.
      const result = await withTimeout(ms, () => values.append({
        spreadsheetId: input.sheetId, range: `${title}!A1`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [[...input.row]] },
      }));
      // No success before the provider confirms it.
      if (result.data.updates?.updatedRows !== 1) return unavailable();
      return { ok: true, status: 'appended' };
    } catch {
      return unavailable();
    }
  }

  return {
    async appendOnce(input) {
      const key = JSON.stringify([input.sheetId, input.tab]);
      const previous = pending.get(key);
      // Snapshot before waiting so a caller cannot change the queued payload.
      const snapshot: AppendOnceInput = { ...input, row: [...input.row] };
      const work = (previous ?? Promise.resolve()).then(() => append(snapshot));
      pending.set(key, work);
      try { return await work; }
      finally { if (pending.get(key) === work) pending.delete(key); }
    },
  };
}
