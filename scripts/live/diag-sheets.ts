// Diagnostic: lists the demo sheet's tab titles and tries the adapter's own column read. Read only.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sheets } from '@googleapis/sheets';
import { JWT } from 'google-auth-library';
let dir = process.cwd();
for (;;) { const f = join(dir, '.env.local'); if (existsSync(f)) { process.loadEnvFile(f); break; } const up = dirname(dir); if (up === dir) break; dir = up; }
const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!) as { client_email: string; private_key: string };
const c = sheets({ version: 'v4', auth: new JWT({ email: sa.client_email, key: sa.private_key, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] }) });
const id = process.env.GOOGLE_SHEET_ID!;
const meta = await c.spreadsheets.get({ spreadsheetId: id, fields: 'sheets.properties.title' });
console.log('tabs', meta.data.sheets?.map((s) => s.properties?.title));
for (const tab of ['Orders', 'Bookings']) {
  try { const r = await c.spreadsheets.values.get({ spreadsheetId: id, range: `'${tab}'!A:A`, majorDimension: 'COLUMNS' }); console.log(tab, 'rows', r.data.values?.[0]?.length ?? 0); }
  catch (e) { console.log(tab, 'error', (e as { code?: number }).code, String((e as Error).message).slice(0, 160)); }
}
