// Seeds everything except the owner's Auth user: businesses, verified facts, capabilities,
// integrations, the two seeded agents with their published versions, and the live_agent row.
// The data comes from the fixtures in @abos/contracts, so mock mode and the database agree.
// This function opens no transaction itself; seedDatabase and runReset wrap it in one.

import { z } from 'zod';
import { CAPABILITY_LIST, type AgentVersion, type BusinessFact } from '@abos/contracts';
import {
  OWNER_USER_ID,
  barberAgent,
  barberBusiness,
  barberFacts,
  barberVersionV1,
  businesses,
  menuItemDraftFact,
  menuPriceConflict,
  pizzaAgent,
  pizzaBusiness,
  pizzaVerifiedFacts,
  pizzaVersionV1,
  pizzaVersionV2,
} from '@abos/contracts/fixtures';
import { json, tally, upsertRow, type Cell, type SeedDb, type TableTally } from './db';
import { envValue, type SeedEnv } from './env';

export const SEED_OWNER_ID = OWNER_USER_ID;

/** The verified facts the seed owns. Reset keeps exactly these rows and deletes every other fact. */
export const SEEDED_FACTS: readonly BusinessFact[] = [...pizzaVerifiedFacts, ...barberFacts];
export const SEEDED_FACT_IDS: readonly string[] = SEEDED_FACTS.map((f) => f.id);

export const SEEDED_AGENTS = [
  { agent: pizzaAgent, versions: [pizzaVersionV1, pizzaVersionV2] as AgentVersion[] },
  { agent: barberAgent, versions: [barberVersionV1] as AgentVersion[] },
] as const;

/** The agent the seeded live_agent row points at: the pizza agent on its latest version. */
export const LIVE_AGENT_TARGET = { businessId: pizzaAgent.businessId, agentId: pizzaAgent.id, agentVersionId: pizzaVersionV2.id };

const E164 = /^\+[1-9][0-9]{6,14}$/;
const BUSINESS_SLUG: Record<string, string> = { [pizzaBusiness.id]: 'pizza', [barberBusiness.id]: 'barber' };

export interface WorldOptions {
  env: SeedEnv;
  /** Also seed the draft menu_item fact and the open price conflict (the conflict banner demo). */
  withDemoConflict?: boolean;
}

export interface WorldResult {
  tables: TableTally;
  notes: string[];
}

export async function seedWorld(db: SeedDb, opts: WorldOptions): Promise<WorldResult> {
  const t: TableTally = {};
  const notes: string[] = [];

  const owner = await db.query('select 1 from public.users where id = $1', [SEED_OWNER_ID]);
  if (owner.rows.length === 0) throw new Error(`The owner row ${SEED_OWNER_ID} does not exist. Run npm run seed first.`);

  // Businesses.
  for (const b of businesses) {
    tally(t, 'businesses', await upsertRow(db, 'businesses', {
      id: b.id, owner_id: SEED_OWNER_ID, name: b.name, category: b.category, timezone: b.timezone, currency: 'USD',
      contact: json(b.contact), settings: json(b.settings), created_at: b.createdAt,
    }, { conflict: ['id'], insertOnly: ['created_at'] }));
  }

  // Capabilities, with JSON Schemas generated from the Zod schemas so the registry cannot drift.
  for (const c of CAPABILITY_LIST) {
    tally(t, 'capabilities', await upsertRow(db, 'capabilities', {
      id: c.id, description: c.description, effect: c.effect, approval_mode: c.approvalMode, handler_id: c.handlerId,
      input_schema: json(toJsonSchema(c.inputSchema)), output_schema: json(toJsonSchema(c.outputSchema)),
      required_scopes: [...c.requiredScopes], timeout_ms: c.timeoutMs, tier: c.tier,
    }, { conflict: ['id'] }));
  }

  // Integrations: one row per provider per business. State reflects which variables are set; no secret is stored.
  for (const b of businesses) {
    for (const row of integrationRows(b.id, opts.env)) {
      tally(t, 'integrations', await upsertRow(db, 'integrations', row, { conflict: ['business_id', 'provider', 'alias'], insertOnly: ['id'] }));
    }
  }

  // Verified facts. An owner edit that already replaced a seeded fact is kept; the reset removes it.
  for (const f of SEEDED_FACTS) {
    const other = await db.query<{ id: string }>(
      "select id from public.business_facts where business_id = $1 and kind = $2 and key = $3 and status = 'verified' and id <> $4",
      [f.businessId, f.kind, f.key, f.id]);
    if (other.rows.length > 0) {
      notes.push(`kept ${other.rows[0]!.id}, a newer verified ${f.kind} fact for ${f.key}; npm run reset restores ${f.id}`);
      tally(t, 'business_facts', 'unchanged');
      continue;
    }
    tally(t, 'business_facts', await upsertRow(db, 'business_facts', factRow(f), { conflict: ['id'], insertOnly: ['created_at'], ignoreInCompare: ['updated_at'] }));
  }

  if (opts.withDemoConflict) {
    // The fixture draft points at the uploaded menu file. No files row or Storage object is seeded,
    // so file_id stays null; source_ref still names the page of the menu.
    tally(t, 'business_facts', await upsertRow(db, 'business_facts', { ...factRow(menuItemDraftFact), file_id: null },
      { conflict: ['id'], insertOnly: ['created_at'], ignoreInCompare: ['updated_at'] }));
    const c = menuPriceConflict;
    const open = await db.query<{ id: string }>(
      "select id from public.fact_conflicts where business_id = $1 and kind = $2 and key = $3 and state = 'open' and id <> $4",
      [c.businessId, c.kind, c.key, c.id]);
    if (open.rows.length > 0) {
      notes.push(`conflict ${open.rows[0]!.id} is already open for ${c.key}; the demo conflict was not added`);
    } else {
      tally(t, 'fact_conflicts', await upsertRow(db, 'fact_conflicts', {
        id: c.id, business_id: c.businessId, kind: c.kind, key: c.key, candidates: json(c.candidates), required: c.required,
        state: c.state, resolved_fact_id: null, resolved_by: null, resolved_at: null, created_at: c.createdAt,
      }, { conflict: ['id'], insertOnly: ['created_at'] }));
    }
  }

  // Agents and their published versions.
  for (const { agent, versions } of SEEDED_AGENTS) {
    const first = await upsertRow(db, 'agents', {
      id: agent.id, business_id: agent.businessId, name: agent.name, template: agent.template, channel: 'phone',
      draft_spec: json(agent.draftSpec), seeded: true, created_at: agent.createdAt,
    }, { conflict: ['id'], insertOnly: ['created_at'] });

    for (const v of versions) {
      const outcome = await upsertRow(db, 'agent_versions', {
        id: v.id, business_id: agent.businessId, agent_id: v.agentId, version: v.version, spec: json(v.spec),
        knowledge_snapshot_ref: json(v.knowledgeSnapshotRef), guardrail_version: v.spec.guardrailVersion,
        created_by: v.createdBy ?? null, created_at: v.publishedAt, published_at: v.publishedAt,
      }, { conflict: ['id'], update: false });
      if (outcome === 'unchanged') {
        const same = await db.query(
          'select 1 from public.agent_versions where id = $1 and spec = $2::jsonb and knowledge_snapshot_ref = $3::jsonb and version = $4',
          [v.id, JSON.stringify(v.spec), JSON.stringify(v.knowledgeSnapshotRef), v.version]);
        if (same.rows.length === 0) {
          notes.push(`agent version ${v.id} differs from the fixtures but is published and immutable; npm run reset replaces it`);
        }
      }
      tally(t, 'agent_versions', outcome);
    }

    // The agent goes live only after its version exists (agents_active_version_fk).
    const activate = await db.query(
      `update public.agents set state = $2, active_version_id = $3
       where id = $1 and (state, active_version_id) is distinct from ($2, $3) returning id`,
      [agent.id, agent.state, agent.activeVersionId]);
    const outcome = first === 'created' ? 'created' : first === 'updated' || activate.rows.length > 0 ? 'updated' : 'unchanged';
    tally(t, 'agents', outcome);
  }

  // The live_agent row for the one phone number (P-06).
  const phone = envValue(opts.env, 'TWILIO_PHONE_NUMBER');
  if (phone === undefined) {
    notes.push('TWILIO_PHONE_NUMBER is empty, so no live_agent row was seeded; set it and run npm run seed again');
  } else if (!E164.test(phone)) {
    throw new Error('TWILIO_PHONE_NUMBER is not an E.164 number such as +15555550199.');
  } else {
    tally(t, 'live_agent', await upsertRow(db, 'live_agent', {
      phone_number: phone, business_id: LIVE_AGENT_TARGET.businessId, agent_id: LIVE_AGENT_TARGET.agentId,
      agent_version_id: LIVE_AGENT_TARGET.agentVersionId,
    }, { conflict: ['phone_number'] }));
  }

  return { tables: t, notes };
}

export function factRow(f: BusinessFact): Record<string, Cell> {
  return {
    id: f.id, business_id: f.businessId, kind: f.kind, key: f.key, value: json(f.value), source_type: f.sourceType,
    source_ref: f.sourceRef ?? null, file_id: f.fileId ?? null, status: f.status, confidence: f.confidence, version: f.version,
    supersedes_id: f.supersedesId ?? null, verified_at: f.verifiedAt ?? null, verified_by: null,
    created_at: f.createdAt, updated_at: f.updatedAt,
  };
}

function toJsonSchema(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, { unrepresentable: 'any' });
}

interface ProviderRule {
  provider: string;
  /** Variables that must all be set for the integration to count as connected. */
  vars: string[];
  /** The variable config_ref names: where the server finds the credential. Never the value. */
  configRef: string;
  config: (env: SeedEnv) => Record<string, string>;
}

const PROVIDERS: ProviderRule[] = [
  { provider: 'square', vars: ['SQUARE_ACCESS_TOKEN', 'SQUARE_LOCATION_ID'], configRef: 'SQUARE_ACCESS_TOKEN',
    config: (env) => compact({ environment: 'sandbox', locationId: envValue(env, 'SQUARE_LOCATION_ID') }) },
  { provider: 'twilio', vars: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER'], configRef: 'TWILIO_AUTH_TOKEN',
    config: (env) => compact({ phoneNumber: envValue(env, 'TWILIO_PHONE_NUMBER') }) },
  { provider: 'openai', vars: ['OPENAI_API_KEY'], configRef: 'OPENAI_API_KEY', config: () => ({}) },
  { provider: 'google_calendar', vars: ['GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_CALENDAR_ID'], configRef: 'GOOGLE_SERVICE_ACCOUNT_JSON',
    config: (env) => compact({ calendarId: envValue(env, 'GOOGLE_CALENDAR_ID') }) },
  { provider: 'google_sheets', vars: ['GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_SHEET_ID'], configRef: 'GOOGLE_SERVICE_ACCOUNT_JSON',
    config: (env) => compact({ sheetId: envValue(env, 'GOOGLE_SHEET_ID') }) },
  { provider: 'message_channel', vars: ['MESSAGE_CHANNEL'], configRef: 'MESSAGE_CHANNEL',
    config: (env) => compact({ channel: envValue(env, 'MESSAGE_CHANNEL') }) },
];

const MESSAGE_CHANNELS = ['surge', 'android_gateway', 'whatsapp_sandbox', 'qr_only'];

export function integrationRows(businessId: string, env: SeedEnv): Record<string, Cell>[] {
  return PROVIDERS.map((p) => {
    let connected = p.vars.every((v) => envValue(env, v) !== undefined);
    if (p.provider === 'square' && envValue(env, 'SQUARE_ENVIRONMENT') !== 'sandbox') connected = false;
    if (p.provider === 'message_channel' && !MESSAGE_CHANNELS.includes(envValue(env, 'MESSAGE_CHANNEL') ?? '')) connected = false;
    return {
      id: `int_${BUSINESS_SLUG[businessId] ?? businessId}_${p.provider}`,
      business_id: businessId, provider: p.provider, alias: 'default',
      // "connected" means configured. last_checked_at stays null until the server runs a real health check.
      state: connected ? 'connected' : 'disconnected',
      config_ref: p.configRef, config: json(p.config(env)), last_checked_at: null, last_error: null,
    };
  });
}

function compact(o: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}
