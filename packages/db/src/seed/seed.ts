// npm run seed: the owner, then the seeded world, in one transaction after the Auth call.
// Idempotent: a second run finds every row in place and reports no change.

import { inTransaction, tally, type SeedDb, type TableTally } from './db';
import type { SeedEnv } from './env';
import { ensureAuthOwner, upsertOwnerRow, type AuthAdmin, type OwnerResult } from './owner';
import { seedWorld } from './world';

export interface SeedOptions {
  env: SeedEnv;
  auth: AuthAdmin;
  envFilePath: string | undefined;
  withDemoConflict?: boolean;
}

export interface SeedSummary {
  owner: OwnerResult;
  tables: TableTally;
  notes: string[];
}

export async function seedDatabase(db: SeedDb, opts: SeedOptions): Promise<SeedSummary> {
  const { authUserId, result } = await ensureAuthOwner(opts);
  return inTransaction(db, async () => {
    const usersRow = await upsertOwnerRow(db, authUserId, result.email);
    const world = await seedWorld(db, { env: opts.env, withDemoConflict: opts.withDemoConflict ?? false });
    const tables: TableTally = {};
    tally(tables, 'users', usersRow);
    Object.assign(tables, world.tables);
    return { owner: { ...result, usersRow }, tables, notes: [...result.notes, ...world.notes] };
  });
}

/** A short plain-text summary. It carries no secret: the summary objects hold none. */
export function formatTally(tables: TableTally): string[] {
  return Object.entries(tables).map(([table, c]) => {
    const parts = [`${c.created} created`, `${c.updated} updated`, `${c.unchanged} already present`];
    return `  ${table.padEnd(16)} ${parts.join(', ')}`;
  });
}

export function formatSeedSummary(s: SeedSummary): string[] {
  return [
    `owner ${s.owner.email}: Auth user ${s.owner.authUser}, users row ${s.owner.usersRow}`,
    ...formatTally(s.tables),
    ...s.notes.map((n) => `note: ${n}`),
  ];
}
