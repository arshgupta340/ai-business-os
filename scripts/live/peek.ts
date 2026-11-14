// Read-only peek at the demo database for the live verifier (prints statuses and short IDs only).
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createPool } from '../../apps/server/src/db/index';
import { parseEnv } from '../../apps/server/src/env';
let dir = process.cwd();
for (;;) { const f = join(dir, '.env.local'); if (existsSync(f)) { process.loadEnvFile(f); break; } const up = dirname(dir); if (up === dir) break; dir = up; }
const sql = process.argv[2]!;
if (!/^\s*select\b/i.test(sql)) throw new Error('select only');
const pool = createPool(parseEnv());
pool.query(sql, process.argv.slice(3)).then((r) => { console.table(r.rows); return pool.end(); });
