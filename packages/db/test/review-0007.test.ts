// Review of migration 0007 (SPEC D-12). It may only widen three checks: message_dispatches.channel,
// webhook_events.source and the channel list inside private.material. These tests compare the whole
// catalog and every row before and after it, on a database that already holds rows written under
// 0001 to 0006. Local PGlite only; the migration is applied by the non-superuser owner and the
// application statements run as abos_app.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { ORDER_BUNDLE, createOrder, createOwner, createSupabaseLikeDb, insert, migrationDb, uniq, type Owner } from './helpers';
import { applyMigrations, readMigrations } from '../src/migrate';
import * as runtime from '../src/runtime';

const NAME = '0007_agentphone_channel.sql';
const files = readMigrations();
const m0007 = files.find((f) => f.name === NAME)!;
const sha = (s: string) => 'sha256:' + createHash('sha256').update(s).digest('hex');

async function as<T>(db: PGlite, role: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec('reset role'); }
}

/** Everything the migration could change, keyed so a difference names the object. */
async function catalog(db: PGlite): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const add = async (kind: string, sql: string) => {
    for (const r of (await db.query<{ k: string; v: string }>(sql)).rows) out.set(`${kind} ${r.k}`, r.v);
  };
  await add('function', `select p.oid::regprocedure::text k, pg_catalog.concat_ws(' | ', pg_get_functiondef(p.oid), 'definer=' || p.prosecdef::text, 'volatile=' || p.provolatile::text,
      'config=' || coalesce(p.proconfig::text, ''), 'acl=' || coalesce(p.proacl::text, ''), 'owner=' || pg_get_userbyid(p.proowner)) v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private') and p.prokind in ('f', 'p')`);
  await add('constraint', `select c.conrelid::regclass::text || '.' || c.conname k, pg_get_constraintdef(c.oid) || ' validated=' || c.convalidated::text v
    from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname in ('public', 'private')`);
  await add('table', `select c.oid::regclass::text k, pg_catalog.concat_ws(' | ', 'kind=' || c.relkind::text, 'acl=' || coalesce(c.relacl::text, ''), 'owner=' || pg_get_userbyid(c.relowner),
      'rls=' || c.relrowsecurity::text, 'force=' || c.relforcerowsecurity::text) v
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'private') and c.relkind in ('r', 'v', 'S', 'i')`);
  await add('column', `select table_schema || '.' || table_name || '.' || column_name k,
      pg_catalog.concat_ws(' | ', data_type, is_nullable, coalesce(column_default, ''), ordinal_position::text) v
    from information_schema.columns where table_schema in ('public', 'private')`);
  await add('trigger', `select t.tgrelid::regclass::text || '.' || t.tgname k, pg_get_triggerdef(t.oid) || ' enabled=' || t.tgenabled::text v
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'private') and not t.tgisinternal`);
  await add('policy', `select schemaname || '.' || tablename || '.' || policyname k,
      pg_catalog.concat_ws(' | ', permissive, roles::text, cmd, coalesce(qual, ''), coalesce(with_check, '')) v from pg_policies`);
  await add('index', `select schemaname || '.' || indexname k, indexdef v from pg_indexes where schemaname in ('public', 'private')`);
  await add('schema', `select nspname k, 'acl=' || coalesce(nspacl::text, '') || ' owner=' || pg_get_userbyid(nspowner) v from pg_namespace where nspname in ('public', 'private')`);
  await add('role', `select rolname k, pg_catalog.concat_ws(' | ', 'super=' || rolsuper::text, 'bypassrls=' || rolbypassrls::text, 'createrole=' || rolcreaterole::text, 'login=' || rolcanlogin::text,
      'inherit=' || rolinherit::text, 'config=' || coalesce(rolconfig::text, '')) v from pg_roles where rolname in ('abos_app', 'anon', 'authenticated', 'service_role', 'supabase_postgres')`);
  await add('membership', `select pg_get_userbyid(roleid) || '<-' || pg_get_userbyid(member) k, 'admin=' || admin_option::text v from pg_auth_members`);
  await add('default-acl', `select pg_get_userbyid(defaclrole) || '.' || defaclnamespace::regnamespace::text || '.' || defaclobjtype::text k, defaclacl::text v from pg_default_acl`);
  await add('publication', `select pubname || '.' || schemaname || '.' || tablename k, 'published' v from pg_publication_tables`);
  return out;
}

/** One digest per public table (schema_migrations aside, which the runner itself writes). */
async function rowDigests(db: PGlite): Promise<Record<string, string>> {
  const tables = (await db.query<{ t: string }>("select tablename t from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations' order by 1")).rows.map((r) => r.t);
  const out: Record<string, string> = {};
  for (const t of tables) {
    const r = (await db.query<{ n: number; d: string | null }>(`select count(*)::int n, md5(string_agg(x::text, '|' order by x::text)) d from public.${t} x`)).rows[0]!;
    out[t] = `${r.n}:${r.d ?? ''}`;
  }
  return out;
}

type Seeded = { owner: Owner; subjectId: string; executions: { id: string }[] };
async function approvedOrder(db: PGlite, messageChannel: string): Promise<Seeded> {
  const owner = await createOwner(db);
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const subject = await createOrder(db, owner);
  const payload = { businessId: owner.businessId, subjectId: String(subject.id), agentVersionId: owner.agentVersionId, cartHash: subject.cart_hash,
    totalMinor: 1200, currency: 'USD', pickupAt: null, messageRecipient: '+15555550123', messageChannel, actionBundle: ORDER_BUNDLE, expiresAt };
  const canonical = JSON.stringify(payload);
  return as(db, 'abos_app', async () => {
    const a = await runtime.createApproval(db, { businessId: owner.businessId, bundleType: 'order_bundle', subjectId: String(subject.id),
      actorType: 'deployed_agent', actorId: owner.agentVersionId, payload, canonical, payloadHash: sha(canonical), actionBundle: ORDER_BUNDLE, expiresAt });
    const { executions } = await runtime.runtimeDecideAndEnqueue(db, { businessId: owner.businessId, approvalId: a.id,
      ownerUserId: owner.userId, payloadHash: a.payload_hash, decision: 'APPROVED' });
    return { owner, subjectId: String(subject.id), executions };
  });
}

/** Runs the checkout step and sends the message step, leaving a SENT dispatch on the approved channel. */
async function sendMessageStep(db: PGlite, p: Seeded): Promise<{ dispatchId: string; channel: string }> {
  const businessId = p.owner.businessId;
  const checkout = { businessId, executionId: p.executions[0]!.id, workerId: 'w', attempt: 1 };
  const message = { businessId, executionId: p.executions[1]!.id, workerId: 'm', attempt: 1 };
  const providerId = 'msg_' + uniq();
  return as(db, 'abos_app', async () => {
    await runtime.runtimeClaimExecution(db, checkout);
    await runtime.saveCheckout(db, { ...checkout, squareOrderId: 'sq-' + p.subjectId, paymentLinkId: 'link-' + p.subjectId, url: 'https://example.test/c' });
    await runtime.finishExecution(db, { ...checkout, status: 'SUCCEEDED', externalRef: 'sq-' + p.subjectId });
    await runtime.runtimeClaimExecution(db, message);
    const d = await runtime.recordDispatch(db, { ...message, bodyHash: sha('body') });
    await runtime.updateDispatch(db, { ...message, dispatchId: d.id, status: 'SENT', providerMessageId: providerId });
    await runtime.finishExecution(db, { ...message, status: 'SUCCEEDED', externalRef: providerId });
    return { dispatchId: d.id, channel: d.channel };
  });
}

const constraintDef = async (db: PGlite, name: string) =>
  (await db.query<{ d: string }>('select pg_get_constraintdef(oid) d from pg_constraint where conname = $1', [name])).rows[0]?.d;
const materialDef = async (db: PGlite) => (await db.query<{ d: string }>("select pg_get_functiondef('private.material(text,jsonb)'::regprocedure) d")).rows[0]!.d;

describe('0007 is written to be applied safely', () => {
  it('replaces each check in one statement, so no statement boundary leaves a table without its check', () => {
    const statements = m0007.sql.replace(/--[^\n]*/g, '').split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
    const drops = statements.filter((s) => /\bdrop\s+constraint\b/i.test(s));
    expect(drops).toHaveLength(2);
    for (const s of drops) {
      const name = /\bdrop\s+constraint\s+(\w+)/i.exec(s)![1]!;
      expect(s, name).toMatch(new RegExp(`\\badd\\s+constraint\\s+${name}\\s+check\\b`, 'i'));
    }
  });

  it('has no statement that needs a superuser, changes a role or grants anything', () => {
    const sql = m0007.sql.replace(/--[^\n]*/g, '');
    expect(sql).not.toMatch(/\b(grant|revoke|alter\s+role|create\s+role|set\s+role|security\s+definer|alter\s+default\s+privileges|create\s+extension|disable\s+trigger|owner\s+to)\b/i);
    expect(sql).not.toMatch(/\b(drop\s+table|drop\s+function|truncate|delete\s+from|update\s+public\.|insert\s+into)\b/i);
  });
});

describe('0007 on a database that already holds rows from 0001 to 0006', () => {
  let db: PGlite;
  let before: Map<string, string>;
  let after: Map<string, string>;
  let rowsBefore: Record<string, string>;
  let rowsAfter: Record<string, string>;
  let materialBefore = '';
  let pending: Seeded;
  let sent: { dispatchId: string; channel: string; businessId: string }[] = [];

  beforeAll(async () => {
    db = await createSupabaseLikeDb();
    await as(db, 'supabase_postgres', () => applyMigrations(migrationDb(db), files.filter((f) => f.name < NAME)));
    // Rows under the old checks: a dispatch on every old channel, a qr_only approval, an approval that
    // is approved but not yet claimed, and a stored webhook from every old source.
    for (const channel of ['surge', 'android_gateway', 'whatsapp_sandbox']) {
      const p = await approvedOrder(db, channel);
      sent.push({ ...(await sendMessageStep(db, p)), businessId: p.owner.businessId });
    }
    await approvedOrder(db, 'qr_only');
    pending = await approvedOrder(db, 'surge');
    await as(db, 'abos_app', async () => {
      for (const source of ['square', 'twilio_voice', 'twilio_status']) await insert(db, 'webhook_events', { source, provider_event_id: 'ev-' + uniq(), event_type: 'x' });
    });
    before = await catalog(db);
    rowsBefore = await rowDigests(db);
    materialBefore = await materialDef(db);
    // Exactly 0007 (later migrations have their own reviews).
    const applied = await as(db, 'supabase_postgres', () => applyMigrations(migrationDb(db), files.filter((f) => f.name <= NAME)));
    expect(applied.applied).toEqual([NAME]);
    after = await catalog(db);
    rowsAfter = await rowDigests(db);
  }, 120_000);
  afterAll(async () => { await db.close(); });

  it('is applied by the non-superuser owner; abos_app cannot apply it', async () => {
    expect((await db.query<{ s: boolean }>("select rolsuper s from pg_roles where rolname = 'supabase_postgres'")).rows[0]).toEqual({ s: false });
    const other = await createSupabaseLikeDb();
    try {
      await as(other, 'supabase_postgres', () => applyMigrations(migrationDb(other), files.filter((f) => f.name < NAME)));
      await expect(as(other, 'abos_app', () => other.exec(m0007.sql))).rejects.toThrow(/must be owner|permission denied/);
    } finally { await other.close(); }
  }, 120_000);

  it('changes exactly three catalog objects and adds or removes none', () => {
    expect([...after.keys()].filter((k) => !before.has(k))).toEqual([]);
    expect([...before.keys()].filter((k) => !after.has(k))).toEqual([]);
    const changed = [...after.keys()].filter((k) => before.get(k) !== after.get(k)).sort();
    expect(changed).toEqual([
      'constraint message_dispatches.message_dispatches_channel_check',
      'constraint webhook_events.webhook_events_source_check',
      'function private.material(text,jsonb)',
    ]);
  });

  it('the two checks keep every old value, add agentphone only, and stay validated', async () => {
    const strip = (d: string) => [...d.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(strip(before.get('constraint message_dispatches.message_dispatches_channel_check')!)).toEqual(['surge', 'android_gateway', 'whatsapp_sandbox']);
    expect(strip(after.get('constraint message_dispatches.message_dispatches_channel_check')!)).toEqual(['surge', 'android_gateway', 'whatsapp_sandbox', 'agentphone']);
    expect(strip(before.get('constraint webhook_events.webhook_events_source_check')!)).toEqual(['square', 'twilio_voice', 'twilio_status']);
    expect(strip(after.get('constraint webhook_events.webhook_events_source_check')!)).toEqual(['square', 'twilio_voice', 'twilio_status', 'agentphone']);
    for (const k of ['constraint message_dispatches.message_dispatches_channel_check', 'constraint webhook_events.webhook_events_source_check']) {
      expect(after.get(k)).toMatch(/^CHECK /);
      expect(after.get(k)).toMatch(/validated=true$/);
    }
    // qr_only still never has a dispatch row.
    expect(after.get('constraint message_dispatches.message_dispatches_channel_check')).not.toContain('qr_only');
  });

  it('private.material differs from its 0004 definition by one line: the routing list gains agentphone', async () => {
    const a = materialBefore.split('\n');
    const b = (await materialDef(db)).split('\n');
    expect(b).toHaveLength(a.length);
    const diff = a.map((line, i) => [line, b[i]!] as const).filter(([x, y]) => x !== y);
    expect(diff).toHaveLength(1);
    expect(diff[0]![0]).toContain("not in ('surge','android_gateway','whatsapp_sandbox','qr_only')");
    expect(diff[0]![1]).toBe(diff[0]![0].replace("'qr_only')", "'qr_only','agentphone')"));
  });

  it('private.material keeps its owner, privileges, invoker rights, volatility and empty search_path', async () => {
    const part = (m: Map<string, string>) => m.get('function private.material(text,jsonb)')!.split(' | ').slice(-5);
    expect(part(after)).toEqual(part(before));
    expect(part(after)).toEqual(['definer=false', 'volatile=i', 'config={"search_path=\\"\\""}', expect.stringMatching(/^acl=/), 'owner=supabase_postgres']);
    // 0004 closed this helper to every role but its owner; only the definer routines call it.
    for (const role of ['public', 'anon', 'authenticated', 'service_role', 'abos_app']) {
      const r = (await db.query<{ ok: boolean }>("select has_function_privilege($1, 'private.material(text,jsonb)', 'EXECUTE') ok", [role])).rows[0]!;
      expect(r.ok, role).toBe(false);
    }
  });

  it('every routine that calls private.material is unchanged, and the entry points stay definer, empty search_path, abos_app only', async () => {
    const callers = (await db.query<{ sig: string; name: string; definer: boolean; config: string }>(`select p.oid::regprocedure::text sig, p.proname as name, p.prosecdef definer,
        coalesce(p.proconfig::text, '') config
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname <> 'material' and p.prosrc like '%private.material(%'`)).rows;
    // create_approval builds the signed material; check_subject re-checks it before every claim.
    expect(callers.map((c) => c.name).sort()).toEqual(['check_subject', 'create_approval']);
    const can = async (role: string, sig: string) => (await db.query<{ ok: boolean }>("select has_function_privilege($1, $2::regprocedure, 'EXECUTE') ok", [role, sig])).rows[0]!.ok;
    for (const c of callers) {
      // Not replaced by 0007: definition, owner, privileges and settings are byte for byte what 0006 left.
      expect(after.get(`function ${c.sig}`), c.sig).toBe(before.get(`function ${c.sig}`));
      expect(c.config, c.sig).toBe('{"search_path=\\"\\""}');
      for (const role of ['public', 'anon', 'authenticated', 'service_role']) expect(await can(role, c.sig), `${c.sig} ${role}`).toBe(false);
    }
    // The entry point the server calls is SECURITY DEFINER and open to abos_app only.
    const entry = callers.filter((c) => c.name === 'create_approval');
    expect(entry).toHaveLength(1);
    for (const c of entry) { expect(c.definer, c.sig).toBe(true); expect(await can('abos_app', c.sig), c.sig).toBe(true); }
    // The internal helper is callable by its owner only, like private.material.
    for (const c of callers.filter((x) => x.name === 'check_subject')) expect(await can('abos_app', c.sig), c.sig).toBe(false);
  });

  it('leaves every existing row of every table as it was', () => {
    expect(Object.keys(rowsAfter)).toEqual(Object.keys(rowsBefore));
    expect(rowsAfter).toEqual(rowsBefore);
    expect(Number(rowsBefore.message_dispatches!.split(':')[0])).toBe(3);
    expect(Number(rowsBefore.webhook_events!.split(':')[0])).toBe(3);
  });

  it('work started before the migration finishes after it: an approved step is claimed, a SENT dispatch takes its receipt', async () => {
    const businessId = pending.owner.businessId;
    await as(db, 'abos_app', async () => {
      // claim_execution compares the stored payload with private.material again.
      const x = await runtime.runtimeClaimExecution(db, { businessId, executionId: pending.executions[0]!.id, workerId: 'after-0007' });
      expect(x?.status).toBe('RUNNING');
      for (const d of sent) expect((await runtime.updateDispatchStatus(db, { businessId: d.businessId, dispatchId: d.dispatchId, status: 'DELIVERED' })).status).toBe('DELIVERED');
    });
  });

  it('still accepts every old channel and source, and refuses an unlisted one', async () => {
    for (const channel of ['surge', 'android_gateway', 'whatsapp_sandbox', 'qr_only', 'agentphone']) await approvedOrder(db, channel);
    await expect(approvedOrder(db, 'telnyx')).rejects.toThrow(/MATERIAL: message routing/);
    await expect(approvedOrder(db, '')).rejects.toThrow(/MATERIAL/);
    await as(db, 'abos_app', async () => {
      for (const source of ['square', 'twilio_voice', 'twilio_status', 'agentphone']) await insert(db, 'webhook_events', { source, provider_event_id: 'ev-' + uniq(), event_type: 'x' });
      await expect(insert(db, 'webhook_events', { source: 'telnyx', provider_event_id: 'ev-' + uniq(), event_type: 'x' })).rejects.toThrow(/webhook_events_source_check/);
    });
    const p = await approvedOrder(db, 'agentphone');
    expect((await sendMessageStep(db, p)).channel).toBe('agentphone');
  });
});

describe('0007 is all or nothing', () => {
  it('a failure after the last statement leaves both checks and private.material exactly as 0006 left them', async () => {
    const db = await createSupabaseLikeDb();
    try {
      await as(db, 'supabase_postgres', () => applyMigrations(migrationDb(db), files.filter((f) => f.name < NAME)));
      const before = await catalog(db);
      const broken = { ...m0007, sql: `${m0007.sql}\nselect 1 / 0;\n` };
      await expect(as(db, 'supabase_postgres', () => applyMigrations(migrationDb(db), [...files.filter((f) => f.name < NAME), broken]))).rejects.toThrow(/division by zero/);
      await db.exec('rollback').catch(() => undefined);
      await db.exec('reset role');
      expect(await catalog(db)).toEqual(before);
      expect(await constraintDef(db, 'message_dispatches_channel_check')).not.toContain('agentphone');
      expect((await db.query("select 1 from public.schema_migrations where name = $1", [NAME])).rows).toHaveLength(0);
    } finally { await db.close(); }
  }, 120_000);
});
