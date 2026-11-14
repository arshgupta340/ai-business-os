// Appends one row to the first sheet, skipping it if the record ID is already in column A.
//   npm run append-row                          record ID spike_row_manual
//   npm run append-row -- --record spike_row_2

import { parseArgs, run } from "./cli.js";
import { authClient, sheetsClient } from "./google.js";
import { appendRowOnce } from "./sheets.js";

run({ sheet: true }, async (cfg) => {
  const recordId = parseArgs().record ?? "spike_row_manual";
  const api = sheetsClient(authClient(cfg.serviceAccount));
  const r = await appendRowOnce(api, cfg.sheetId, recordId, [
    new Date().toISOString(),
    "spike",
    "bkg_spike_manual",
    "Spike B-05 test row, safe to delete",
  ]);
  if (r.kind === "APPENDED") {
    console.log(`APPENDED ${recordId} at ${r.updatedRange}${r.headerCreated ? " (header row created first)" : ""}.`);
  } else {
    console.log(`SKIPPED ${recordId}: ${r.reason}.`);
  }
});
