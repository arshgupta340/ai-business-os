import type { ToolFailure } from '@abos/contracts';

export type ReportingRow = (string | number)[];
export type ReportingFailure = ToolFailure & { retryable: boolean };
export type ReportingResult = { ok: true; status: 'appended' | 'skipped' } | ReportingFailure;

export type AppendOnceInput = {
  sheetId: string;
  /** The tab must already exist. */
  tab: string;
  /** Written to column A: the order or booking id, or the sync job's key. Must equal `row[0]`. */
  recordId: string;
  row: ReportingRow;
};

export interface ReportingAdapter {
  appendOnce(input: AppendOnceInput): Promise<ReportingResult>;
}

export type ValuesGetRequest = { spreadsheetId: string; range: string; majorDimension: 'COLUMNS'; valueRenderOption: 'UNFORMATTED_VALUE' };
export type ValuesUpdateRequest = { spreadsheetId: string; range: string; valueInputOption: 'RAW'; requestBody: { values: ReportingRow[] } };
export type ValuesAppendRequest = { spreadsheetId: string; range: string; valueInputOption: 'RAW'; insertDataOption: 'INSERT_ROWS'; requestBody: { values: ReportingRow[] } };

/**
 * Only the SDK surface this adapter uses. A real `sheets_v4.Sheets` from
 * `@googleapis/sheets` satisfies it (checked in the tests).
 */
export interface GoogleSheetsClient {
  spreadsheets: {
    values: {
      get(input: ValuesGetRequest): Promise<{ data: { values?: unknown[][] | null } }>;
      update(input: ValuesUpdateRequest): Promise<unknown>;
      append(input: ValuesAppendRequest): Promise<{ data: { updates?: { updatedRows?: number | null } | null } }>;
    };
  };
}

export interface SheetsDependencies {
  client: GoogleSheetsClient;
  /** Per provider call. Default 8000 ms. */
  timeoutMs?: number;
}
