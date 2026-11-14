// Test helpers: a fresh in-process Postgres (PGlite) with the Supabase stand-ins and every
// migration applied, plus small insert helpers. These rows exist only inside each test database.

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { decideApproval } from '../src/guarded-updates';
import { applyMigrations, type MigrationDb } from '../src/migrate';

const here = dirname(fileURLToPath(import.meta.url));
export const PRELUDE_SQL = readFileSync(join(here, 'supabase-prelude.sql'), 'utf8');

export const ORDER_BUNDLE = ['square.checkout.create', 'message.checkout.send', 'local.order.record', 'sheets.order.append'];
export const BOOKING_BUNDLE = ['calendar.event.create', 'message.booking.confirm', 'local.booking.record', 'sheets.booking.append'];

export function migrationDb(db: PGlite): MigrationDb {
  return {
    exec: (sql) => db.exec(sql),
    query: (text, params) => db.query(text, params),
  };
}

/** A new empty database with the test prelude only. */
export async function createEmptyDb(): Promise<PGlite> {
  const db = await PGlite.create({ extensions: { btree_gist, pgcrypto } });
  await db.exec(PRELUDE_SQL);
  return db;
}

/** A new database with the prelude and every migration applied. */
export async function createMigratedDb(): Promise<PGlite> {
  const db = await createEmptyDb();
  await applyMigrations(migrationDb(db));
  return db;
}

let counter = 0;
/** A short unique suffix for IDs and other unique values inside one test database. */
export function uniq(): string {
  counter += 1;
  return `${Date.now().toString(36)}${counter}`;
}

export function hash(seed: string = uniq()): string {
  return `sha256:${hex64(seed)}`;
}

export function hex64(seed: string = uniq()): string {
  // Not a real hash; any 64 lowercase hex characters pass the format checks.
  return Buffer.from(seed.padEnd(32, '0').slice(0, 32)).toString('hex').slice(0, 64).padEnd(64, '0');
}

type Row = Record<string, unknown>;

/** Inserts one row. Plain objects are sent as JSON; arrays are sent as Postgres arrays. */
export async function insert(db: PGlite, table: string, row: Row): Promise<Row> {
  const cols = Object.keys(row);
  const values = cols.map((c) => {
    const v = row[c];
    return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) ? JSON.stringify(v) : v;
  });
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const sql = `insert into public.${table} (${cols.join(', ')}) values (${placeholders}) returning *`;
  const { rows } = await db.query<Row>(sql, values);
  return rows[0]!;
}

export interface Owner {
  authUserId: string;
  userId: string;
  businessId: string;
  agentId: string;
  agentVersionId: string;
  callId: string;
}

/** One owner with one business, one live agent on a published version, and one test-console call. */
export async function createOwner(db: PGlite): Promise<Owner> {
  const s = uniq();
  const authUserId = randomUUID();
  await db.query('insert into auth.users (id, email) values ($1, $2)', [authUserId, `owner${s}@example.test`]);
  const userId = `usr_${s}`;
  await insert(db, 'users', { id: userId, auth_user_id: authUserId, email: `owner${s}@example.test` });
  const businessId = `biz_${s}`;
  await insert(db, 'businesses', {
    id: businessId, owner_id: userId, name: `Business ${s}`, category: 'restaurant', timezone: 'America/Los_Angeles',
  });
  const agentId = `agt_${s}`;
  await insert(db, 'agents', { id: agentId, business_id: businessId, name: 'Agent', template: 'restaurant_order_taker' });
  const agentVersionId = `agv_${s}`;
  await insert(db, 'agent_versions', {
    id: agentVersionId, business_id: businessId, agent_id: agentId, version: 1, spec: { name: 'Agent' },
    published_at: new Date(),
  });
  await db.query("update public.agents set state = 'live', active_version_id = $1 where id = $2", [agentVersionId, agentId]);
  const callId = `call_${s}`;
  await insert(db, 'calls', {
    id: callId, business_id: businessId, agent_id: agentId, agent_version_id: agentVersionId,
    channel: 'test_console', stage: 'CALL_STARTED',
  });
  return { authUserId, userId, businessId, agentId, agentVersionId, callId };
}

export async function createOrder(db: PGlite, o: Owner, extra: Row = {}): Promise<Row> {
  return insert(db, 'orders', {
    id: `ord_${uniq()}`, business_id: o.businessId, call_id: o.callId,
    cart: { lines: [] }, cart_hash: hash(), quote: { id: 'qte_1' }, total_minor: 1200,
    contact: { firstName: 'Sam' }, fulfillment: { type: 'pickup' },
    ...extra,
  });
}

export async function createApproval(db: PGlite, o: Owner, extra: Row = {}): Promise<Row> {
  const payload = extra.payload ?? { businessId: o.businessId, messageChannel: 'surge', messageRecipient: '+15555550123' };
  const canonical = String(extra.payload_canonical ?? JSON.stringify(payload));
  return insert(db, 'approval_requests', {
    id: `apv_${uniq()}`, business_id: o.businessId, actor_type: 'deployed_agent', actor_id: o.agentVersionId,
    bundle_type: 'order_bundle', action_bundle: ORDER_BUNDLE, subject_id: `ord_${uniq()}`,
    payload, payload_canonical: canonical, payload_hash: `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
    ...extra,
  });
}

/** Creates a PENDING approval and approves it through the guarded decision, as the owner. */
export async function createApprovedApproval(db: PGlite, o: Owner, extra: Row = {}): Promise<Row> {
  const pending = await createApproval(db, o, extra);
  const approved = await decideApproval(db, {
    approvalId: String(pending.id), businessId: o.businessId, decision: 'APPROVED', ownerUserId: o.userId,
    payloadHash: String(pending.payload_hash),
  });
  if (!approved) throw new Error('test setup: approval was not approved');
  return approved;
}

export async function createBooking(db: PGlite, o: Owner, extra: Row = {}): Promise<Row> {
  return insert(db, 'bookings', {
    id: `bkg_${uniq()}`, business_id: o.businessId, service_id: 'svc_cut', service_name: 'Haircut',
    calendar_id: 'cal_main', start_utc: '2026-11-20T18:00:00Z', end_utc: '2026-11-20T18:30:00Z',
    timezone: 'America/Los_Angeles', customer: { firstName: 'Sam' },
    ...extra,
  });
}

export async function createExecution(db: PGlite, o: Owner, approvalId: string, extra: Row = {}): Promise<Row> {
  return insert(db, 'action_executions', {
    id: `exe_${uniq()}`, business_id: o.businessId, approval_id: approvalId,
    action_type: 'square.checkout.create', step_index: 0, idempotency_key: hex64(),
    ...extra,
  });
}

/** Runs fn as the Supabase "authenticated" role with auth.uid() returning authUserId. */
export async function asOwner<T>(db: PGlite, authUserId: string, fn: () => Promise<T>): Promise<T> {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [authUserId]);
  await db.exec('set role authenticated');
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
  }
}
