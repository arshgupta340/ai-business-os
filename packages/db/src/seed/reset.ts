// npm run reset: returns the database to the state right after seeding.
// Published agent versions, approvals, executions and audit events refuse row deletes, so the run
// data is cleared with one TRUNCATE (it fires no row trigger), and the seeded agents, their versions
// and the live_agent row are written again. The TRUNCATE names every table and has no CASCADE, so a
// new table that references one of them makes the reset fail loudly instead of being emptied silently.
// Square sandbox orders, Calendar events, Sheets rows and Storage objects are not touched.

import { countRows, inTransaction, type SeedDb, type TableTally } from './db';
import { envValue, type SeedEnv } from './env';
import { SEEDED_FACT_IDS, seedWorld } from './world';

export const TRUNCATED_TABLES = [
  'message_dispatches', 'action_executions', 'sync_jobs', 'orders', 'bookings', 'approval_requests', 'calls',
  'webhook_events', 'activity_events', 'fact_conflicts', 'builder_sessions', 'live_agent', 'agent_versions', 'agents',
] as const;

export class ResetRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResetRefusedError';
  }
}

export interface ResetOptions {
  env: SeedEnv;
  /** The operator passed --yes. */
  confirmed: boolean;
  withDemoConflict?: boolean;
}

export interface ResetSummary {
  before: Record<string, number>;
  after: Record<string, number>;
  reseeded: TableTally;
  notes: string[];
}

export async function runReset(db: SeedDb, opts: ResetOptions): Promise<ResetSummary> {
  if (!opts.confirmed) {
    throw new ResetRefusedError('Reset deletes every call, order, booking, approval and audit event. Run it again with --yes.');
  }
  if (envValue(opts.env, 'SQUARE_ENVIRONMENT') !== 'sandbox') {
    throw new ResetRefusedError('Reset refuses to run unless SQUARE_ENVIRONMENT is "sandbox".');
  }
  const before = await countRows(db);
  const world = await inTransaction(db, async () => {
    await db.query(`truncate table ${TRUNCATED_TABLES.map((t) => `public.${t}`).join(', ')}`);
    // Drafts, owner edits and upload facts go; the seeded rows are rewritten to verified below.
    await db.query('delete from public.business_facts where not (id = any($1::text[]))', [[...SEEDED_FACT_IDS]]);
    await db.query('delete from public.files');
    return seedWorld(db, { env: opts.env, withDemoConflict: opts.withDemoConflict ?? false });
  });
  const after = await countRows(db);
  return { before, after, reseeded: world.tables, notes: world.notes };
}

export function formatResetSummary(s: ResetSummary): string[] {
  const lines = ['table              before  after'];
  for (const [t, n] of Object.entries(s.before)) {
    lines.push(`  ${t.padEnd(18)} ${String(n).padStart(6)} ${String(s.after[t] ?? 0).padStart(6)}`);
  }
  if ((s.before.files ?? 0) > 0) lines.push('note: files rows were deleted; remove their objects from the business-files Storage bucket by hand');
  return [...lines, ...s.notes.map((n) => `note: ${n}`)];
}
