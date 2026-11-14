// The database surface the seed, the Square seed and the reset need, plus small SQL helpers.
// A pg Client or a PGlite instance fits through a thin adapter. Every call must reach the same
// session, because the callers wrap their work in one transaction.

export interface SeedDb {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

/** Marks a value that goes into a jsonb column. It is sent as JSON text and cast to jsonb. */
export class JsonCell {
  constructor(readonly value: unknown) {}
}

export function json(value: unknown): JsonCell {
  return new JsonCell(value);
}

export type Cell = string | number | boolean | null | readonly string[] | JsonCell;
export type Outcome = 'created' | 'updated' | 'unchanged';

export interface UpsertOptions {
  /** Columns of the unique key used for ON CONFLICT. */
  conflict: string[];
  /** When false, an existing row is left as it is. Default true. */
  update?: boolean;
  /** Columns written on insert only, never updated (for example created_at). */
  insertOnly?: string[];
  /** Columns that are updated along with a real change but do not count as a change themselves. */
  ignoreInCompare?: string[];
}

/**
 * Inserts one row, or updates the existing row only when a compared column differs.
 * Returns whether the row was created, updated or already matched, so a second run reports no change.
 */
export async function upsertRow(db: SeedDb, table: string, row: Record<string, Cell>, opts: UpsertOptions): Promise<Outcome> {
  const cols = Object.keys(row);
  const params: unknown[] = [];
  const placeholders = cols.map((c) => {
    const v = row[c];
    if (v instanceof JsonCell) {
      params.push(JSON.stringify(v.value));
      return `$${params.length}::jsonb`;
    }
    params.push(v);
    return `$${params.length}`;
  });
  const skip = new Set([...opts.conflict, ...(opts.insertOnly ?? [])]);
  const updateCols = cols.filter((c) => !skip.has(c));
  const ignore = new Set(opts.ignoreInCompare ?? []);
  const compareCols = updateCols.filter((c) => !ignore.has(c));

  let onConflict: string;
  if (opts.update === false || updateCols.length === 0) {
    onConflict = 'do nothing';
  } else {
    const set = updateCols.map((c) => `${c} = excluded.${c}`).join(', ');
    const where = compareCols.length === 0
      ? 'false'
      : `(${compareCols.map((c) => `t.${c}`).join(', ')}) is distinct from (${compareCols.map((c) => `excluded.${c}`).join(', ')})`;
    onConflict = `do update set ${set} where ${where}`;
  }
  const sql =
    `insert into public.${table} as t (${cols.join(', ')}) values (${placeholders.join(', ')}) ` +
    `on conflict (${opts.conflict.join(', ')}) ${onConflict} returning (t.xmax = 0) as inserted`;
  const { rows } = await db.query<{ inserted: boolean }>(sql, params);
  const first = rows[0];
  if (!first) return 'unchanged';
  return first.inserted ? 'created' : 'updated';
}

/** Runs fn inside one transaction and rolls back if it throws. */
export async function inTransaction<T>(db: SeedDb, fn: () => Promise<T>): Promise<T> {
  await db.query('begin');
  try {
    const result = await fn();
    await db.query('commit');
    return result;
  } catch (err) {
    await db.query('rollback');
    throw err;
  }
}

/** Per-table counts of created, updated and unchanged rows. */
export type TableTally = Record<string, Record<Outcome, number>>;

export function tally(t: TableTally, table: string, outcome: Outcome): void {
  const entry = (t[table] ??= { created: 0, updated: 0, unchanged: 0 });
  entry[outcome] += 1;
}

/** Every application table, in the order the summaries print them. */
export const ALL_TABLES = [
  'users', 'businesses', 'capabilities', 'integrations', 'files', 'business_facts', 'catalog_items', 'fact_conflicts',
  'agents', 'agent_versions', 'live_agent', 'builder_sessions', 'calls', 'approval_requests', 'orders', 'bookings',
  'action_executions', 'message_dispatches', 'webhook_events', 'sync_jobs', 'activity_events',
] as const;

export async function countRows(db: SeedDb, tables: readonly string[] = ALL_TABLES): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of tables) {
    const { rows } = await db.query<{ n: number | string }>(`select count(*)::int as n from public.${t}`);
    out[t] = Number(rows[0]?.n ?? 0);
  }
  return out;
}
