// Seed, Square catalog seed and reset against PGlite with the real migrations.
// Every provider is a fake; nothing here reaches Supabase Auth or Square.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentVersionSchema, BusinessFactSchema, BusinessSchema, CAPABILITY_LIST, CatalogModifierListSchema, FactConflictSchema,
  HoursValueSchema, LiveAgentSchema, ServiceOfferingSchema,
} from '@abos/contracts';
import { demoShopCatalog, demoShopFacts, pizzaCatalogRows } from '@abos/contracts/fixtures';
import {
  ALL_TABLES, ResetRefusedError, SEEDED_FACTS, TRUNCATED_TABLES, countRows, liveAgentNumberVars, runReset, seedDatabase, seedDemoShop, seedSquareCatalog,
  type AuthAdmin, type SeedDb, type SeedEnv, type SquareCatalogClient, type SquareCatalogObject,
} from '../src/seed';
import { createApprovedApproval, createExecution, createMigratedDb, createOrder, insert, type Owner } from './helpers';

const PHONE = '+15555550199';
const BASE_ENV: SeedEnv = {
  SUPABASE_URL: 'http://fake.test', SUPABASE_SERVICE_ROLE_KEY: 'fake-key', SEED_OWNER_EMAIL: 'owner@demo.test',
  SEED_OWNER_PASSWORD: 'fixed-test-password-1', TWILIO_PHONE_NUMBER: PHONE, SQUARE_ENVIRONMENT: 'sandbox',
  SQUARE_ACCESS_TOKEN: 'fake-square-token', SQUARE_LOCATION_ID: 'LOC_FAKE', MESSAGE_CHANNEL: 'qr_only',
};

function seedDb(db: PGlite): SeedDb {
  return { query: async <R,>(text: string, params?: unknown[]) => ({ rows: (await db.query<R>(text, params)).rows }) };
}

/** A fake Auth admin that also writes auth.users, as Supabase would. It records the passwords it got. */
function fakeAuth(db: PGlite): AuthAdmin & { passwords: string[]; creates: number } {
  const users = new Map<string, string>();
  const fake = {
    passwords: [] as string[],
    creates: 0,
    async findUserByEmail(email: string) {
      const id = users.get(email);
      return id ? { id } : undefined;
    },
    async createUser(email: string, password: string) {
      const id = randomUUID();
      users.set(email, id);
      fake.passwords.push(password);
      fake.creates += 1;
      await db.query('insert into auth.users (id, email) values ($1, $2)', [id, email]);
      return { id };
    },
  };
  return fake;
}

/** A fake Square catalog: assigns real-looking IDs to temp IDs and bumps versions on each upsert. */
function fakeSquare(): SquareCatalogClient & { upserts: number; store: Map<string, SquareCatalogObject> } {
  const store = new Map<string, SquareCatalogObject>();
  let seq = 0;
  let clock = 1_700_000_000_000;
  const fake = {
    upserts: 0,
    store,
    async listCatalog(types: string[]) {
      return [...store.values()].filter((o) => types.includes(o.type)).map((o) => structuredClone(o));
    },
    async batchUpsert(_key: string, objects: SquareCatalogObject[]) {
      fake.upserts += 1;
      clock += 1000;
      const mappings: { clientObjectId: string; objectId: string }[] = [];
      const real = (id: string) => {
        if (!id.startsWith('#')) return id;
        const found = mappings.find((m) => m.clientObjectId === id);
        if (found) return found.objectId;
        seq += 1;
        const objectId = `SQREAL${seq}`;
        mappings.push({ clientObjectId: id, objectId });
        return objectId;
      };
      const fix = (o: SquareCatalogObject): SquareCatalogObject => {
        const c = structuredClone(o);
        c.id = real(c.id);
        c.version = clock;
        if (c.item_data) {
          c.item_data.tax_ids = (c.item_data.tax_ids ?? []).map(real);
          c.item_data.modifier_list_info = (c.item_data.modifier_list_info ?? []).map((m) => ({ ...m, modifier_list_id: real(m.modifier_list_id) }));
          c.item_data.variations = (c.item_data.variations ?? []).map((v) => {
            const f = fix(v);
            if (f.item_variation_data?.item_id) f.item_variation_data.item_id = c.id;
            return f;
          });
        }
        if (c.modifier_list_data) c.modifier_list_data.modifiers = (c.modifier_list_data.modifiers ?? []).map(fix);
        return c;
      };
      const out = objects.map(fix);
      for (const o of out) store.set(o.id, o);
      return { objects: out.map((o) => structuredClone(o)), idMappings: mappings };
    },
  };
  return fake;
}

/** A checksum of every application table. Columns in `ignore` are left out (for rows rewritten by the reset). */
async function checksum(db: PGlite, ignore: string[] = []): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of ALL_TABLES) {
    const { rows } = await db.query<{ h: string }>(
      `select md5(coalesce(string_agg(r, '|' order by r), '')) as h
       from (select (to_jsonb(x) - $1::text[])::text as r from public.${t} x) s`, [ignore]);
    out[t] = rows[0]!.h;
  }
  return out;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

let db: PGlite;
let sdb: SeedDb;
let dir: string;

beforeEach(async () => {
  db = await createMigratedDb();
  sdb = seedDb(db);
  dir = mkdtempSync(join(tmpdir(), 'abos-seed-'));
});
afterEach(async () => {
  await db.close();
});

describe('seed', () => {
  it('creates exactly the expected rows, and a second run changes nothing', async () => {
    const auth = fakeAuth(db);
    const first = await seedDatabase(sdb, { env: BASE_ENV, auth, envFilePath: undefined });
    const counts = await countRows(sdb);
    expect(counts).toMatchObject({
      users: 1, businesses: 2, capabilities: CAPABILITY_LIST.length, integrations: 12, business_facts: SEEDED_FACTS.length,
      agents: 2, agent_versions: 3, live_agent: 1, fact_conflicts: 0, catalog_items: 0, files: 0,
      calls: 0, orders: 0, bookings: 0, approval_requests: 0, action_executions: 0, message_dispatches: 0,
      sync_jobs: 0, webhook_events: 0, activity_events: 0, builder_sessions: 0,
    });
    expect(first.tables.business_facts!.created).toBe(SEEDED_FACTS.length);
    expect(first.owner.authUser).toBe('created');

    const sum = await checksum(db);
    const second = await seedDatabase(sdb, { env: BASE_ENV, auth, envFilePath: undefined });
    expect(await countRows(sdb)).toEqual(counts);
    expect(await checksum(db)).toEqual(sum);
    expect(auth.creates).toBe(1);
    expect(second.owner.authUser).toBe('present');
    for (const [table, c] of Object.entries(second.tables)) {
      expect({ table, created: c.created, updated: c.updated }).toEqual({ table, created: 0, updated: 0 });
    }
  });

  it('seeds rows that parse with the contract schemas and match the fixtures', async () => {
    await seedDatabase(sdb, { env: BASE_ENV, auth: fakeAuth(db), envFilePath: undefined });

    const biz = await db.query<Record<string, unknown>>('select * from public.businesses order by id');
    for (const b of biz.rows) {
      BusinessSchema.parse({ id: b.id, name: b.name, category: b.category, timezone: b.timezone, contact: b.contact,
        settings: b.settings, createdAt: iso(b.created_at), updatedAt: iso(b.updated_at) });
      expect(b.owner_id).toBe('usr_owner_01');
    }

    const facts = await db.query<Record<string, unknown>>('select * from public.business_facts');
    for (const f of facts.rows) {
      BusinessFactSchema.parse({ id: f.id, businessId: f.business_id, kind: f.kind, key: f.key, value: f.value,
        sourceType: f.source_type, sourceRef: f.source_ref ?? undefined, status: f.status, confidence: Number(f.confidence),
        version: f.version, verifiedAt: f.verified_at ? iso(f.verified_at) : undefined,
        createdAt: iso(f.created_at), updatedAt: iso(f.updated_at) });
      expect(f.status).toBe('verified');
      if (f.kind === 'hours') HoursValueSchema.parse(f.value);
      if (f.kind === 'service') ServiceOfferingSchema.parse(f.value);
    }
    const hours = facts.rows.filter((f) => f.kind === 'hours' && f.business_id === 'biz_pizza_01').map((f) => f.key).sort();
    expect(hours).toEqual(['fri', 'mon', 'sat', 'sun', 'thu', 'tue', 'wed']);
    expect(facts.rows.filter((f) => f.kind === 'service').map((f) => f.key).sort()).toEqual(['svc_beard_trim', 'svc_haircut', 'svc_haircut_beard']);
    expect(facts.rows.some((f) => f.kind === 'menu_item')).toBe(false);

    const versions = await db.query<Record<string, unknown>>('select * from public.agent_versions');
    for (const v of versions.rows) {
      AgentVersionSchema.parse({ id: v.id, agentId: v.agent_id, version: v.version, spec: v.spec,
        knowledgeSnapshotRef: v.knowledge_snapshot_ref, createdBy: v.created_by ?? undefined, publishedAt: iso(v.published_at) });
      expect(v.published_at).not.toBeNull();
    }

    const agents = await db.query<Record<string, unknown>>('select id, state, active_version_id, seeded from public.agents order by id');
    expect(agents.rows).toEqual([
      { id: 'agt_barber_01', state: 'live', active_version_id: 'agv_barber_01_v1', seeded: true },
      { id: 'agt_pizza_01', state: 'live', active_version_id: 'agv_pizza_01_v2', seeded: true },
    ]);

    const live = await db.query<Record<string, unknown>>('select * from public.live_agent');
    expect(live.rows).toHaveLength(1);
    const l = live.rows[0]!;
    LiveAgentSchema.parse({ phoneNumber: l.phone_number, businessId: l.business_id, agentId: l.agent_id,
      agentVersionId: l.agent_version_id, updatedAt: iso(l.updated_at) });
    expect(l).toMatchObject({ phone_number: PHONE, agent_id: 'agt_pizza_01', agent_version_id: 'agv_pizza_01_v2' });

    const caps = await db.query<Record<string, unknown>>('select * from public.capabilities');
    expect(caps.rows.map((c) => c.id).sort()).toEqual(CAPABILITY_LIST.map((c) => c.id).sort());
    for (const c of caps.rows) expect(typeof c.input_schema).toBe('object');

    // Integrations hold no secret: config never carries a token, and config_ref names a variable.
    const ints = await db.query<Record<string, unknown>>('select * from public.integrations');
    const text = JSON.stringify(ints.rows);
    for (const secret of ['fake-key', 'fake-square-token']) expect(text).not.toContain(secret);
    expect(ints.rows.find((r) => r.id === 'int_pizza_square')).toMatchObject({ state: 'connected', config: { environment: 'sandbox', locationId: 'LOC_FAKE' } });
    expect(ints.rows.find((r) => r.id === 'int_pizza_openai')).toMatchObject({ state: 'disconnected' });

    // Every constraint is validated; nothing was inserted with a check bypassed.
    const unvalidated = await db.query("select conname from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public' and not c.convalidated");
    expect(unvalidated.rows).toEqual([]);
  });

  it('adds the draft menu fact and the open conflict only with --with-demo-conflict', async () => {
    await seedDatabase(sdb, { env: BASE_ENV, auth: fakeAuth(db), envFilePath: undefined, withDemoConflict: true });
    const conflicts = await db.query<Record<string, unknown>>('select * from public.fact_conflicts');
    expect(conflicts.rows).toHaveLength(1);
    const c = conflicts.rows[0]!;
    FactConflictSchema.parse({ id: c.id, businessId: c.business_id, kind: c.kind, key: c.key, required: c.required,
      candidates: c.candidates, state: c.state, createdAt: iso(c.created_at) });
    const draft = await db.query("select status from public.business_facts where kind = 'menu_item'");
    expect(draft.rows).toEqual([{ status: 'draft' }]);
  });

  it('skips the live_agent row with a note when TWILIO_PHONE_NUMBER is empty', async () => {
    const s = await seedDatabase(sdb, { env: { ...BASE_ENV, TWILIO_PHONE_NUMBER: '' }, auth: fakeAuth(db), envFilePath: undefined });
    expect((await countRows(sdb, ['live_agent'])).live_agent).toBe(0);
    expect(s.notes.join(' ')).toContain('TWILIO_PHONE_NUMBER is empty');
  });

  it('D-12: with TELEPHONY_PROVIDER=agentphone the pizza agent is also live on AGENTPHONE_PHONE_NUMBER, and a second run changes nothing', async () => {
    const AP = '+15555550123';
    const env = { ...BASE_ENV, TELEPHONY_PROVIDER: 'agentphone', AGENTPHONE_PHONE_NUMBER: AP };
    await seedDatabase(sdb, { env, auth: fakeAuth(db), envFilePath: undefined });
    const rows = async () => (await db.query<Record<string, unknown>>('select phone_number, business_id, agent_id, agent_version_id from public.live_agent order by phone_number')).rows;
    const first = await rows();
    expect(first).toEqual([
      { phone_number: AP, business_id: 'biz_pizza_01', agent_id: 'agt_pizza_01', agent_version_id: 'agv_pizza_01_v2' },
      { phone_number: PHONE, business_id: 'biz_pizza_01', agent_id: 'agt_pizza_01', agent_version_id: 'agv_pizza_01_v2' },
    ].sort((a, b) => a.phone_number.localeCompare(b.phone_number)));
    const again = await seedDatabase(sdb, { env, auth: fakeAuth(db), envFilePath: undefined });
    expect(await rows()).toEqual(first);
    expect(again.tables.live_agent).toMatchObject({ unchanged: 2 });
    // With the provider unset, AGENTPHONE_PHONE_NUMBER alone adds no row (Twilio behaviour unchanged).
    expect(liveAgentNumberVars({ AGENTPHONE_PHONE_NUMBER: AP })).toEqual(['TWILIO_PHONE_NUMBER']);
  });

  it('D-12: agentphone selected with no AGENTPHONE_PHONE_NUMBER seeds the Twilio row and says what is missing', async () => {
    const s = await seedDatabase(sdb, { env: { ...BASE_ENV, TELEPHONY_PROVIDER: 'agentphone' }, auth: fakeAuth(db), envFilePath: undefined });
    expect((await countRows(sdb, ['live_agent'])).live_agent).toBe(1);
    expect(s.notes.join(' ')).toContain('AGENTPHONE_PHONE_NUMBER is empty');
  });

  it('generates a password, writes it only to the given env file, and never prints or returns it', async () => {
    const envFile = join(dir, '.env.local');
    writeFileSync(envFile, 'OTHER=1\nSEED_OWNER_PASSWORD=\n');
    const auth = fakeAuth(db);
    const logged: string[] = [];
    const original = { log: console.log, error: console.error, warn: console.warn };
    console.log = (...a: unknown[]) => logged.push(a.join(' '));
    console.error = console.log;
    console.warn = console.log;
    let summaryText: string;
    try {
      const s = await seedDatabase(sdb, { env: { ...BASE_ENV, SEED_OWNER_PASSWORD: undefined }, auth, envFilePath: envFile });
      summaryText = JSON.stringify(s);
    } finally {
      Object.assign(console, original);
    }
    const password = auth.passwords[0]!;
    expect(password.length).toBeGreaterThanOrEqual(32);
    const content = readFileSync(envFile, 'utf8');
    expect(content).toContain(`SEED_OWNER_PASSWORD=${password}`);
    expect(content).toContain('SEED_OWNER_EMAIL=owner@demo.test');
    expect(content).toContain('OTHER=1');
    expect(content.match(/SEED_OWNER_PASSWORD=/g)).toHaveLength(1);
    expect(summaryText).not.toContain(password);
    expect(logged.join('\n')).not.toContain(password);
  });

  it('fails clearly when no password is set and there is no env file to save one', async () => {
    await expect(seedDatabase(sdb, { env: { ...BASE_ENV, SEED_OWNER_PASSWORD: '' }, auth: fakeAuth(db), envFilePath: undefined }))
      .rejects.toThrow(/SEED_OWNER_PASSWORD is empty/);
  });
});

describe('seed:square', () => {
  it('writes one catalog_items row per variation and is safe to run twice', async () => {
    await seedDatabase(sdb, { env: BASE_ENV, auth: fakeAuth(db), envFilePath: undefined });
    const square = fakeSquare();
    const now = () => new Date('2026-11-13T09:00:00Z');
    const first = await seedSquareCatalog(sdb, { env: BASE_ENV, client: square, now });
    expect(first.upserted).toBe(true);
    const rows = await db.query<Record<string, unknown>>('select * from public.catalog_items order by id');
    expect(rows.rows.map((r) => r.id)).toEqual(pizzaCatalogRows.map((r) => r.id).sort());
    for (const r of rows.rows) {
      expect(String(r.square_variation_id)).toMatch(/^SQREAL/);
      for (const list of r.modifier_lists as unknown[]) CatalogModifierListSchema.parse(list);
    }
    const sum = await checksum(db);

    const second = await seedSquareCatalog(sdb, { env: BASE_ENV, client: square, now: () => new Date('2026-11-13T10:00:00Z') });
    expect(second.upserted).toBe(false);
    expect(square.upserts).toBe(1);
    expect(await checksum(db)).toEqual(sum);
  });

  it('fails fast without Square keys and refuses outside sandbox', async () => {
    await seedDatabase(sdb, { env: BASE_ENV, auth: fakeAuth(db), envFilePath: undefined });
    await expect(seedSquareCatalog(sdb, { env: { ...BASE_ENV, SQUARE_ACCESS_TOKEN: '' }, client: fakeSquare() }))
      .rejects.toThrow(/SQUARE_ACCESS_TOKEN/);
    await expect(seedSquareCatalog(sdb, { env: { ...BASE_ENV, SQUARE_ENVIRONMENT: 'production' }, client: fakeSquare() }))
      .rejects.toThrow(/sandbox/);
  });
});

describe('seed:demo-shop (issue #161)', () => {
  it('replaces the two-pizza menu with 16 pizzas in three sizes, with no toppings list, and is safe to run twice', async () => {
    await seedDatabase(sdb, { env: BASE_ENV, auth: fakeAuth(db), envFilePath: undefined });
    const square = fakeSquare();
    const now = () => new Date('2026-11-14T09:00:00Z');
    await seedSquareCatalog(sdb, { env: BASE_ENV, client: square, now });
    const oldPepperoni = await db.query<{ square_variation_id: string }>("select square_variation_id from public.catalog_items where id = 'cat_pep_lg'");

    const first = await seedDemoShop(sdb, { env: BASE_ENV, client: square, now });
    expect(first.catalog.upserted).toBe(true);
    const rows = (await db.query<Record<string, unknown>>("select * from public.catalog_items where business_id = 'biz_pizza_01' order by item_name, price_minor")).rows;
    expect(rows).toHaveLength(48);
    expect([...new Set(rows.map((r) => r.item_name))]).toEqual(demoShopCatalog.map((i) => i.name).sort());
    expect(rows.some((r) => r.item_name === 'Margherita')).toBe(false);
    for (const r of rows) {
      expect(r.modifier_lists).toEqual([]);
      expect([[`Small`, 1495], ['Medium', 2595], ['Large', 3445]]).toContainEqual([r.variation_name, r.price_minor]);
      expect(String(r.square_variation_id)).toMatch(/^SQREAL/);
    }
    // The Pepperoni that was already in Square is updated in place: same variation ID, new price, no toppings.
    const pepperoni = rows.find((r) => r.item_name === 'Pepperoni' && r.variation_name === 'Large')!;
    expect(pepperoni.square_variation_id).toBe(oldPepperoni.rows[0]!.square_variation_id);
    expect(pepperoni.price_minor).toBe(3445);
    const squareItem = [...square.store.values()].find((o) => o.type === 'ITEM' && o.item_data?.name === 'Pepperoni')!;
    expect(squareItem.item_data?.modifier_list_info).toEqual([]);

    const sum = await checksum(db);
    const second = await seedDemoShop(sdb, { env: BASE_ENV, client: square, now: () => new Date('2026-11-14T10:00:00Z') });
    expect(second.catalog.upserted).toBe(false);
    expect(second.facts.business_facts).toEqual({ created: 0, updated: 0, unchanged: demoShopFacts.length });
    expect(first.facts.businesses).toEqual({ created: 0, updated: 1, unchanged: 0 });
    expect(second.facts.businesses).toEqual({ created: 0, updated: 0, unchanged: 1 });
    expect((await db.query<{ name: string }>("select name from public.businesses where id = 'biz_pizza_01'")).rows[0]!.name).toBe("Woodstock's Pizza");
    expect(second.retired).toBe(0);
    expect(await checksum(db)).toEqual(sum);
  });

  it('versions the shop facts over the seeded ones and retires what does not hold', async () => {
    await seedDatabase(sdb, { env: BASE_ENV, auth: fakeAuth(db), envFilePath: undefined });
    await db.query("insert into public.business_facts (id, business_id, kind, key, value, source_type, status, verified_at) values ('fact_smoke_1', 'biz_pizza_01', 'faq', 'live_abc', '{\"question\":\"Is this a live check?\",\"answer\":\"Yes.\"}', 'owner_ui', 'verified', now())");
    const summary = await seedDemoShop(sdb, { env: BASE_ENV, client: fakeSquare(), now: () => new Date('2026-11-14T09:00:00Z') });
    expect(summary.retired).toBe(2); // the parking FAQ and the smoke check's FAQ

    const verified = (await db.query<{ kind: string; key: string; value: unknown; version: number; supersedes_id: string | null; source_ref: string | null }>(
      "select kind, key, value, version, supersedes_id, source_ref from public.business_facts where business_id = 'biz_pizza_01' and status = 'verified'")).rows;
    const fact = (kind: string, key: string) => verified.find((f) => f.kind === kind && f.key === key);
    for (const f of demoShopFacts) expect(fact(f.kind, f.key)?.value).toEqual(f.value);
    // Monday was 11:00 to 21:00 in the seed: the new row is version 2 and points at the seeded row.
    expect(fact('hours', 'mon')).toMatchObject({ value: { open: '11:00', close: '23:59' }, version: 2, supersedes_id: 'fact_pizza_hours_mon', source_ref: 'issue-161' });
    expect(fact('contact', 'address')?.value).toEqual({ address: '1000 Higuera Street, San Luis Obispo, CA 93401' });
    expect(fact('faq', 'gluten_free')).toMatchObject({ version: 2, supersedes_id: 'fact_pizza_faq_gluten_free' });
    expect(fact('faq', 'price')).toMatchObject({ version: 1, supersedes_id: null });
    expect(fact('faq', 'parking')).toBeUndefined();
    expect(fact('faq', 'live_abc')).toBeUndefined();
    // Facts this seed does not own stay as they were.
    expect(fact('policy', 'pickup_window')?.value).toEqual({ minutes: 20 });
    expect(fact('policy', 'no_refunds_by_phone')).toBeDefined();
    for (const f of verified) if (f.kind === 'hours') HoursValueSchema.parse(f.value);
    const old = await db.query<{ status: string }>("select status from public.business_facts where id = 'fact_pizza_hours_mon'");
    expect(old.rows[0]!.status).toBe('superseded');
  });
});

describe('reset', () => {
  it('refuses without --yes and outside sandbox, and touches nothing', async () => {
    await seedDatabase(sdb, { env: BASE_ENV, auth: fakeAuth(db), envFilePath: undefined });
    const sum = await checksum(db);
    await expect(runReset(sdb, { env: BASE_ENV, confirmed: false })).rejects.toBeInstanceOf(ResetRefusedError);
    await expect(runReset(sdb, { env: { ...BASE_ENV, SQUARE_ENVIRONMENT: 'production' }, confirmed: true })).rejects.toThrow(/sandbox/);
    await expect(runReset(sdb, { env: { ...BASE_ENV, SQUARE_ENVIRONMENT: undefined }, confirmed: true })).rejects.toBeInstanceOf(ResetRefusedError);
    expect(await checksum(db)).toEqual(sum);
  });

  it('clears run data, keeps the seeds, and a seed after reset changes nothing', async () => {
    const auth = fakeAuth(db);
    await seedDatabase(sdb, { env: BASE_ENV, auth, envFilePath: undefined, withDemoConflict: true });
    await seedSquareCatalog(sdb, { env: BASE_ENV, client: fakeSquare(), now: () => new Date('2026-11-13T09:00:00Z') });
    await db.query('delete from public.fact_conflicts');
    await db.query("delete from public.business_facts where kind = 'menu_item'");
    // updated_at changes when the reset rewrites rows, so the comparison leaves it out.
    const seeded = await checksum(db, ['updated_at']);

    // Sample run data on the seeded pizza business.
    const call = await insert(db, 'calls', { id: 'call_t1', business_id: 'biz_pizza_01', agent_id: 'agt_pizza_01',
      agent_version_id: 'agv_pizza_01_v2', channel: 'test_console', stage: 'CALL_STARTED' });
    const owner: Owner = { authUserId: '', userId: 'usr_owner_01', businessId: 'biz_pizza_01', agentId: 'agt_pizza_01',
      agentVersionId: 'agv_pizza_01_v2', callId: String(call.id) };
    await createOrder(db, owner);
    const approval = await createApprovedApproval(db, owner);
    await createExecution(db, owner, String(approval.id));
    await insert(db, 'activity_events', { business_id: 'biz_pizza_01', type: 'call.started', agent_id: 'agt_pizza_01',
      correlation_id: 'cor_1', actor_type: 'system' });
    await insert(db, 'builder_sessions', { business_id: 'biz_pizza_01', owner_id: 'usr_owner_01', agent_id: 'agt_pizza_01' });
    // A non-seeded agent with a published (immutable) version.
    await insert(db, 'agents', { id: 'agt_custom_1', business_id: 'biz_pizza_01', name: 'Custom', template: 'custom' });
    await insert(db, 'agent_versions', { id: 'agv_custom_1', business_id: 'biz_pizza_01', agent_id: 'agt_custom_1', version: 1,
      spec: { name: 'Custom' }, published_at: new Date() });
    await db.query("update public.agents set state = 'live', active_version_id = 'agv_custom_1' where id = 'agt_custom_1'");
    await db.query("update public.live_agent set business_id = 'biz_barber_01', agent_id = 'agt_barber_01', agent_version_id = 'agv_barber_01_v1'");
    // An uploaded file, a draft fact from it, and an owner edit that superseded a seeded hours fact.
    await insert(db, 'files', { id: 'file_t1', business_id: 'biz_pizza_01', storage_path: 'biz_pizza_01/file_t1/m.pdf', name: 'm.pdf',
      mime: 'application/pdf', sha256: `sha256:${'a'.repeat(64)}`, size_bytes: 10, uploaded_by: 'usr_owner_01' });
    await insert(db, 'business_facts', { id: 'fact_up_1', business_id: 'biz_pizza_01', kind: 'faq', key: 'x', value: { a: 1 },
      source_type: 'upload', file_id: 'file_t1' });
    await db.query("update public.business_facts set status = 'superseded' where id = 'fact_pizza_hours_fri'");
    await insert(db, 'business_facts', { id: 'fact_fri_v2', business_id: 'biz_pizza_01', kind: 'hours', key: 'fri',
      value: { open: '11:00', close: '23:00' }, source_type: 'owner_chat', status: 'verified', version: 2,
      supersedes_id: 'fact_pizza_hours_fri', verified_at: new Date() });
    await insert(db, 'fact_conflicts', { business_id: 'biz_pizza_01', kind: 'faq', key: 'x',
      candidates: JSON.stringify([{ a: 1 }, { a: 2 }]) });

    // A plain seed keeps the owner edit rather than overwriting it.
    const plain = await seedDatabase(sdb, { env: BASE_ENV, auth, envFilePath: undefined });
    expect(plain.notes.join(' ')).toContain('fact_fri_v2');

    const summary = await runReset(sdb, { env: BASE_ENV, confirmed: true });
    expect(summary.before.orders).toBe(1);
    for (const t of [...TRUNCATED_TABLES.filter((x) => !['agents', 'agent_versions', 'live_agent'].includes(x)), 'files']) {
      expect({ t, n: summary.after[t] }).toEqual({ t, n: 0 });
    }
    expect(await checksum(db, ['updated_at'])).toEqual(seeded);

    const afterReset = await checksum(db);
    const again = await seedDatabase(sdb, { env: BASE_ENV, auth, envFilePath: undefined });
    for (const c of Object.values(again.tables)) expect(c.created + c.updated).toBe(0);
    expect(await checksum(db)).toEqual(afterReset);
  });
});
