// Append one row to the first sheet, at most once per record ID.
// A plain values.append is not idempotent (PRD 14), so we read column A first.

import type { sheets_v4 } from "@googleapis/sheets";

export const HEADER = ["record_id", "recorded_at", "kind", "subject_id", "detail"];

/** A1 notation for a sheet title, quoting it so spaces and quotes are safe. */
export function quoteSheetTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

export async function firstSheetTitle(api: sheets_v4.Sheets, spreadsheetId: string): Promise<string> {
  const res = await api.spreadsheets.get({ spreadsheetId, fields: "sheets.properties(title,index)" });
  const sheetsList = (res.data.sheets ?? [])
    .map((s) => s.properties)
    .filter((p): p is sheets_v4.Schema$SheetProperties => !!p?.title)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const title = sheetsList[0]?.title;
  if (!title) throw new Error("The spreadsheet has no sheets.");
  return title;
}

export async function readRecordIds(
  api: sheets_v4.Sheets,
  spreadsheetId: string,
  title: string,
): Promise<string[]> {
  const res = await api.spreadsheets.values.get({
    spreadsheetId,
    range: `${quoteSheetTitle(title)}!A:A`,
    majorDimension: "COLUMNS",
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const col = res.data.values?.[0] ?? [];
  return col.map((v) => String(v ?? ""));
}

export type AppendResult =
  | { kind: "APPENDED"; updatedRange: string; headerCreated: boolean }
  | { kind: "SKIPPED"; reason: "record ID already present" };

export async function appendRowOnce(
  api: sheets_v4.Sheets,
  spreadsheetId: string,
  recordId: string,
  rest: (string | number)[],
): Promise<AppendResult> {
  if (!recordId.trim()) throw new Error("Record ID must not be empty");
  const title = await firstSheetTitle(api, spreadsheetId);
  const ids = await readRecordIds(api, spreadsheetId, title);
  if (ids.includes(recordId)) return { kind: "SKIPPED", reason: "record ID already present" };

  let headerCreated = false;
  if (ids.every((v) => v.trim() === "")) {
    await api.spreadsheets.values.update({
      spreadsheetId,
      range: `${quoteSheetTitle(title)}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADER] },
    });
    headerCreated = true;
  }

  const res = await api.spreadsheets.values.append({
    spreadsheetId,
    range: `${quoteSheetTitle(title)}!A1`,
    // RAW stores text as typed, so a value starting with "=" is never run as a formula.
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[recordId, ...rest]] },
  });
  return { kind: "APPENDED", updatedRange: res.data.updates?.updatedRange ?? "?", headerCreated };
}

export async function countRecordId(
  api: sheets_v4.Sheets,
  spreadsheetId: string,
  recordId: string,
): Promise<number> {
  const title = await firstSheetTitle(api, spreadsheetId);
  const ids = await readRecordIds(api, spreadsheetId, title);
  return ids.filter((v) => v === recordId).length;
}
