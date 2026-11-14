// The seeded owner: a Supabase Auth user plus the matching public.users row.
// The Auth calls go through the AuthAdmin interface so tests use a fake. The password is never
// printed and never returned: it goes only to the Auth API and, when generated, to the env file.

import { ownerUser } from '@abos/contracts/fixtures';
import { upsertRow, type Outcome, type SeedDb } from './db';
import { envValue, generatePassword, writeEnvVars, type SeedEnv } from './env';
import { SEED_OWNER_ID } from './world';

export const DEFAULT_OWNER_EMAIL = 'owner@demo.test';

export interface AuthAdmin {
  /** Returns the Auth user's ID for this email, or undefined when there is none. */
  findUserByEmail(email: string): Promise<{ id: string } | undefined>;
  /** Creates a confirmed Auth user and returns its ID. */
  createUser(email: string, password: string): Promise<{ id: string }>;
}

export interface OwnerOptions {
  env: SeedEnv;
  auth: AuthAdmin;
  /** Where a generated password is written. Required only when SEED_OWNER_PASSWORD is empty. */
  envFilePath: string | undefined;
}

export interface OwnerResult {
  email: string;
  authUser: 'created' | 'present';
  usersRow: Outcome;
  /** True when a password was generated and written to the env file. The value is never returned. */
  passwordGenerated: boolean;
  notes: string[];
}

/** Creates the Auth user when missing. Runs before the database transaction, because it calls the Auth API. */
export async function ensureAuthOwner(opts: OwnerOptions): Promise<{ authUserId: string; result: Omit<OwnerResult, 'usersRow'> }> {
  const email = envValue(opts.env, 'SEED_OWNER_EMAIL') ?? DEFAULT_OWNER_EMAIL;
  const notes: string[] = [];
  const existing = await opts.auth.findUserByEmail(email);
  if (existing) {
    if (envValue(opts.env, 'SEED_OWNER_PASSWORD') === undefined) {
      notes.push('the Auth user already exists and SEED_OWNER_PASSWORD is empty, so its password was left unchanged');
    }
    return { authUserId: existing.id, result: { email, authUser: 'present', passwordGenerated: false, notes } };
  }

  let password = envValue(opts.env, 'SEED_OWNER_PASSWORD');
  let passwordGenerated = false;
  if (password === undefined) {
    if (!opts.envFilePath) {
      throw new Error('SEED_OWNER_PASSWORD is empty and no .env.local was found to save a generated one. Set SEED_OWNER_PASSWORD.');
    }
    password = generatePassword();
    // Saved before the user is created, so the password is never lost if the Auth call succeeds.
    writeEnvVars(opts.envFilePath, { SEED_OWNER_EMAIL: email, SEED_OWNER_PASSWORD: password });
    passwordGenerated = true;
    notes.push('generated an owner password and saved SEED_OWNER_EMAIL and SEED_OWNER_PASSWORD to .env.local');
  }
  const created = await opts.auth.createUser(email, password);
  return { authUserId: created.id, result: { email, authUser: 'created', passwordGenerated, notes } };
}

/** The public.users row for the owner, linked to the Auth user. */
export async function upsertOwnerRow(db: SeedDb, authUserId: string, email: string): Promise<Outcome> {
  return upsertRow(db, 'users', {
    id: SEED_OWNER_ID, auth_user_id: authUserId, email, display_name: ownerUser.displayName, role: 'owner',
    created_at: ownerUser.createdAt,
  }, { conflict: ['id'], insertOnly: ['created_at'] });
}
