// The composition root. It builds the real dependencies from the environment once and connects
// every port the pieces declared to the piece that implements it:
//   routes' engine port          -> the approval engine (policy/engine.ts)
//   real toolset ports           -> catalog cache and facts (Postgres), Square quote, engine proposals,
//                                   order status (Postgres), Google Calendar availability
//   voice plugin ports           -> live_agent and its published spec, the calls table, the toolset
//                                   factory, the Twilio validator, the OpenAI socket factory
//   builder seams                -> BuilderAuth (Supabase JWT) and the live-agent reader
//   sim-call                     -> the same calls table and toolset factory, plus an agent model
//   executor and webhooks seams  -> fail-closed defaults until B-11 and B-13 land (seams.ts)
// Tests pass overrides for the database, the token verifier, the providers and the model.
import { randomUUID } from 'node:crypto';
import { ActivityEventSchema, type MessageChannelSetting } from '@abos/contracts';
import { assertRestrictedRuntimeRole } from '@abos/db';
import type { FastifyPluginAsync } from 'fastify';
// The in-memory engine in api/ports.ts is a test fake and is never wired here.
import type { CatalogPort as RouteCatalogPort, EnginePorts } from '../api/ports';
import { createBuilderAuth, createVerifier, type TokenVerifier } from '../auth/verify';
import type { BuilderPluginOptions } from '../builder/index';
import type { AgentModel } from '../builder/runner/agent-model';
import { OpenAiAgentModel } from '../builder/runner/openai-agent-model';
import { RecordedAgentModel } from '../builder/runner/recorded-agent-model';
import { createDb, createPool, unavailableDb, type Db } from '../db/index';
import type { Env } from '../env';
import { AppError } from '../errors';
import { emitActivity } from '../policy/activity';
import { createPolicyEngine, type PolicyEngine } from '../policy/engine';
import { createRealToolset, type FactsSnapshot, type RealToolset, type RealToolsetPorts } from '../tools/real/index';
import type { VoicePluginOptions } from '../voice/types';
import {
  calendarAvailabilityPort, dbCallsPort, dbVoiceEventsPort, dbCatalogPort, dbFactsPort, dbLiveAgentPort, dbOrderStatusPort, engineProposalPort, squareQuotePort,
  type CallsStore,
} from './ports';
import { buildProviders, type Providers } from './providers';
import { createDbExecutor } from './executor';
import { createDbWebhooks, type DbWebhooks } from './webhooks';
import { createHealthMonitor, type HealthMonitor } from './health';
import { createTelemetry, type TelemetryPluginOptions } from '../telemetry/index';
import { mapRow } from '../api/rows';
import type { PricesDependencies } from '../api/prices/index';
import type { RecoveryPorts } from '../api/recovery/index';
import { createDbRecoveryPorts } from './recovery';
import { createDbFallback, type FallbackDeps } from './fallback';
import { dbAgentVersionStore, dbLiveAgentStore, dbPublishEventSink, squareCatalogSync } from './builder-publish';
import { createCallDecisions, type CallDecisionsBus } from './decisions';
import { createProposeFactFromChat, dbAgentDraftStore, dbBuilderSessionStore, dbBusinessKnowledge, dbDraftFactStore, dbLiveAgentReader, type ProposeFactFromChat } from './builder';
import { notWiredExecutor, notWiredWebhooks, type Executor, type ExecutorFactory, type SeamDeps, type WebhooksFactory } from './seams';


export type { ExecutorFactory, WebhooksFactory, Executor, SeamDeps } from './seams';

export interface ComposeOptions {
  db?: Db;
  verifier?: TokenVerifier;
  /** Replaces the approval engine behind the routes (route tests use the in-memory fake). */
  ports?: EnginePorts;
  catalog?: RouteCatalogPort;
  providers?: Partial<Providers>;
  agentModel?: AgentModel;
  now?: () => Date;
  newId?: (prefix: string) => string;
  /** Defaults to the database executor (executor.ts) when a database is present. */
  executor?: ExecutorFactory;
  // PLUG-IN B-13: pass the webhooks plugin factory here, or replace `notWiredWebhooks` below.
  webhooks?: WebhooksFactory;
  log?: SeamDeps['log'];
  /** Human fallback condition (2): no contract field enables it yet, so the default refuses (compose/fallback.ts). */
  versionEnablesFallback?: FallbackDeps['versionEnablesFallback'];
  /** Bound on each integration health probe (tests use a short one). */
  healthProbeTimeoutMs?: number;
}

export interface ComposedServer {
  env: Env;
  db: Db;
  /** Closes the pool, if this composition opened one. */
  close(): Promise<void>;
  verifier: TokenVerifier;
  engine: PolicyEngine;
  enginePorts: EnginePorts;
  catalogSync: RouteCatalogPort;
  providers: Providers;
  calls: CallsStore;
  toolsetPorts: RealToolsetPorts;
  toolsetFor(ctx: { businessId: string; agentVersionId: string; callId: string; capabilities: readonly import('@abos/contracts').CapabilityId[]; facts?: FactsSnapshot | undefined }): RealToolset;
  agentModel: AgentModel;
  /** Options for the builder plugin's own seams (auth, stores, knowledge, live agent). */
  builder: BuilderPluginOptions;
  /** Issue #65 item 5: a fact_edit approval from an owner chat answer. The builder plugin has no option for it yet. */
  proposeFactFromChat: ProposeFactFromChat;
  /** Voice plugin options, or the list of missing settings that keep the phone path off. */
  voice: { ok: true; options: VoicePluginOptions } | { ok: false; missing: string[] };
  executor: Executor;
  webhooksPlugin: FastifyPluginAsync;
  /** The database webhooks wiring, when it is the one in use (jobs, recovery, reconciliation). */
  webhooks: DbWebhooks | undefined;
  /** select 1 against the database, for GET /health?refresh=1. Absent without a database. */
  databaseProbe: (() => Promise<boolean>) | undefined;
  /** Owner decisions to the live call they belong to (FLOWS 3.1). */
  decisions: CallDecisionsBus;
  /** Human fallback router (B-28) and the relay hook it serves. */
  fallback: ReturnType<typeof createDbFallback>;
  /** POST /api/orders/:id/cancel and /api/executions/:id/resolve (B-32), on the 0005 routines. */
  recovery: RecoveryPorts;
  /** POST /api/businesses/:id/catalog/prices/propose (B-26): owner, catalog row, Square read, approval. */
  prices: PricesDependencies;
  /** Integration health: configuration plus cached read-only probe results (API 3.11). */
  health: HealthMonitor;
  /** GET /api/telemetry (B-30) and the recorder modules may record into. */
  telemetry: TelemetryPluginOptions;
  /**
   * Startup check (0006): throws unless the database connection is the restricted abos_app role.
   * index.ts refuses to start when it throws. Without a database there is nothing to check.
   */
  assertRuntimeRole(): Promise<void>;
  /** Background jobs: the approval expiry sweep (API 3.7) and the executor loop. */
  startJobs(): void;
  stopJobs(): Promise<void>;
  now(): Date;
  newId(prefix: string): string;
}

/** For server-side reads that no caller can cancel (the voice worker's pinned snapshot, sim-call). */
const NO_SIGNAL = new AbortController().signal;
const defaultNewId = (prefix: string) => `${prefix}${randomUUID().replaceAll('-', '')}`;
const silentLog: SeamDeps['log'] = { info() {}, warn() {}, error() {} };

export function composeServer(env: Env, options: ComposeOptions = {}): ComposedServer {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? defaultNewId;
  const log = options.log ?? silentLog;

  const pool = !options.db && env.DATABASE_URL ? createPool(env) : undefined;
  const db = options.db ?? (pool ? createDb(pool) : unavailableDb);
  const hasDb = db !== unavailableDb;
  const verifier = options.verifier ?? createVerifier(env);
  const authConfigured = options.verifier !== undefined || env.SUPABASE_URL !== undefined;

  const providers = buildProviders(env, now, options.providers);
  const messageChannel: MessageChannelSetting = providers.messageChannel;
  const engine = createPolicyEngine(db, { now, newId, squareEnvironment: env.SQUARE_ENVIRONMENT });

  const facts = dbFactsPort(db);
  const toolsetPorts: RealToolsetPorts = {
    catalog: dbCatalogPort(db),
    facts,
    quotes: squareQuotePort(db, providers),
    proposals: engineProposalPort(engine, (businessId) => facts.readVerified({ businessId, signal: NO_SIGNAL }), providers, now),
    orderStatus: dbOrderStatusPort(db),
    availability: calendarAvailabilityPort(providers, (businessId) => facts.readVerified({ businessId, signal: NO_SIGNAL })),
  };
  // One pinned snapshot per call (AC-16, review finding 4): the toolset's own fact reads, availability
  // and the booking proposal all read the same facts, taken once, however the owner edits them mid-call.
  // Telemetry (B-30): one in-memory recorder. tool_latency is timed here around each tool call and
  // webhook_delay in webhooks.ts; the voice relay and the executor take no telemetry port.
  const telemetry = createTelemetry({ now: () => now().getTime() });
  const toolsetFor: ComposedServer['toolsetFor'] = (ctx) => {
    let snapshot: Promise<FactsSnapshot> | undefined = ctx.facts ? Promise.resolve(ctx.facts) : undefined;
    const pinned = (businessId: string) => {
      if (businessId !== ctx.businessId) return Promise.reject(new AppError('FORBIDDEN_BUSINESS', 'Another business.'));
      snapshot ??= facts.readVerified({ businessId, signal: NO_SIGNAL });
      return snapshot;
    };
    const ports: RealToolsetPorts = { ...toolsetPorts, facts: { readVerified: ({ businessId }) => pinned(businessId) },
      proposals: engineProposalPort(engine, pinned, providers, now), availability: calendarAvailabilityPort(providers, pinned) };
    const ts = createRealToolset({ businessId: ctx.businessId, messageChannel, ports, capabilities: ctx.capabilities, now, ...(ctx.facts ? { factsSnapshot: ctx.facts } : {}) });
    // The fourth argument (the relay's cancellation and deadline) is passed through unchanged (voice NOTES 7).
    const call: RealToolset['handler']['call'] = (name, input, c, control) => {
      const stop = telemetry.time('tool_latency', { businessId: ctx.businessId, correlationId: ctx.callId });
      return ts.handler.call(name, input, c, control).finally(stop);
    };
    return { businessId: ts.businessId, handler: { ...ts.handler, call }, tools: ts.tools, trace: () => ts.trace(), clearTrace: () => ts.clearTrace(), dispose: () => ts.dispose() };
  };
  const calls = dbCallsPort(db, newId);

  const decisions = createCallDecisions();
  const seamDeps: SeamDeps = { env, db, engine, providers, now, newId, log };
  const defaultExecutor: ExecutorFactory = hasDb ? (deps) => createDbExecutor(deps) : notWiredExecutor;
  const executor = (options.executor ?? defaultExecutor)(seamDeps);
  // Provider webhooks and payment reconciliation (B-13). Without a database or the signature settings
  // the routes keep the 503 default, which reads and stores nothing.
  const webhooks = !options.webhooks && hasDb ? createDbWebhooks(seamDeps, notWiredWebhooks(seamDeps), { afterJob: () => executor.kick(''), telemetry }) : undefined;
  const webhooksPlugin = options.webhooks ? options.webhooks(seamDeps) : webhooks?.plugin ?? notWiredWebhooks(seamDeps);

  // Routes' engine port. After an approval the executor is told to look for work.
  const enginePorts: EnginePorts = options.ports ?? {
    async decide(input) {
      const result = await engine.decide(input);
      if (result.approval.state === 'APPROVED') executor.kick(result.approval.businessId);
      await decisions.publish(db, { businessId: result.approval.businessId, approvalId: result.approval.id, state: result.approval.state }).catch(() => undefined);
      return result;
    },
    proposeFactEdit: (input) => engine.proposeFactEdit(input),
  };

  // POST /api/businesses/:id/catalog/sync (P-10): a provider read into our own cache, no approval needed.
  const catalogSync: RouteCatalogPort = options.catalog ?? {
    async sync({ businessId }) {
      const square = providers.square;
      if (!square) throw new AppError('INTEGRATION_UNAVAILABLE', 'Square is not configured.', undefined, undefined, { provider: 'square' });
      const jobId = newId('job_');
      const event = async (type: 'sync.queued' | 'sync.succeeded', extra = {}) => emitActivity(db, { id: newId('evt_'), businessId, correlationId: jobId, type, actorType: 'system', occurredAt: now().toISOString(), payload: { target: 'catalog', jobId, ...extra } });
      await event('sync.queued');
      void square.syncCatalog(db, businessId).then(
        () => event('sync.succeeded'),
        () => emitActivity(db, { id: newId('evt_'), businessId, correlationId: jobId, type: 'sync.failed', actorType: 'system', occurredAt: now().toISOString(), payload: { target: 'catalog', jobId, attempts: 1, final: true } }),
      ).catch(() => undefined);
      return { jobId };
    },
  };

  const recovery = createDbRecoveryPorts({ db, now, newId, providers, reconcile: webhooks ? () => webhooks.reconcileNow() : undefined });

  // P-11 price change: a proposal reads Square's current price and stores a pending price_edit approval.
  // The global guard has already authenticated the owner and checked the business (auth/verify.ts).
  const prices: PricesDependencies = {
    auth: { async requireOwner(request, businessId) {
      const r = request as { ownerUserId?: string; businessId?: string };
      return r.ownerUserId && r.businessId === businessId ? { ownerUserId: r.ownerUserId } : null;
    } },
    catalog: { async findVariation(businessId, variationId) {
      const row = (await db.query('select id, square_item_id, square_variation_id from public.catalog_items where business_id = $1 and square_variation_id = $2', [businessId, variationId])).rows[0] as Record<string, unknown> | undefined;
      return row ? { businessId, subjectId: String(row.id), squareItemId: String(row.square_item_id), variationId: String(row.square_variation_id) } : null;
    } },
    square: { readVariationPrice(variationId) {
      if (!providers.prices) throw new AppError('INTEGRATION_UNAVAILABLE', 'Square is not configured.');
      return providers.prices.readVariationPrice(variationId);
    } },
    approvals: { createPendingPriceEditApproval: async (input) => {
      const r = await engine.createPriceEditApproval({ ownerUserId: input.ownerUserId, payload: input.payload, payloadHash: input.payloadHash });
      return r.kind === 'conflict' ? r : { kind: r.kind, approval: r.approval as Extract<typeof r.approval, { bundleType: 'price_edit' }> };
    } },
    now,
  };

  const agentModel: AgentModel = options.agentModel
    ?? (env.OPENAI_API_KEY && env.OPENAI_BUILDER_MODEL ? new OpenAiAgentModel({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_BUILDER_MODEL }) : new RecordedAgentModel());

  // The builder's own seams (issue #65). Without a database it keeps its in-memory defaults, and
  // without a way to verify tokens it keeps its fail-closed auth default.
  const proposeFactFromChat = createProposeFactFromChat(engine);
  // Publish stops on a disconnected integration (Twilio, OpenAI, Square, Calendar as the spec needs).
  // A publish runs the bounded read-only probes now, so a provider never checked is not taken as down
  // and a provider that went down since the last check is caught.
  const integrations = { read: () => health.read({ refresh: true }) };
  // Extraction keeps its in-memory stores: uploaded bytes have no database column or storage bucket
  // wired, and upload facts reference their files row, so the set moves together (see the report).
  // With a database but no way to verify tokens, the builder answers INTEGRATION_UNAVAILABLE (a server
  // setting is missing), not UNAUTHENTICATED, so the web app does not sign a valid owner out. The
  // explicit local opt-in BUILDER_DEV_AUTH=1 keeps the builder's own loopback-only stand-in.
  const unconfiguredAuth: NonNullable<BuilderPluginOptions['auth']> = {
    verified: true,
    async authenticate() { throw new AppError('INTEGRATION_UNAVAILABLE', 'Sign-in is not configured on this server.'); },
    async ownsBusiness() { return false; },
  };
  const devAuth = process.env.BUILDER_DEV_AUTH === '1';
  const builder: BuilderPluginOptions = hasDb ? {
    ...(authConfigured ? { auth: createBuilderAuth(db, verifier) } : devAuth ? {} : { auth: unconfiguredAuth }),
    liveAgent: dbLiveAgentReader(db), sessions: dbBuilderSessionStore(db), agents: dbAgentDraftStore(db),
    draftFacts: dbDraftFactStore(db), knowledge: dbBusinessKnowledge(db), proposeFactFromChat,
    publish: {
      versions: dbAgentVersionStore(db), events: dbPublishEventSink(db), syncCatalog: squareCatalogSync(db, providers, now), integrations,
      ...(env.TWILIO_PHONE_NUMBER ? { liveAgents: dbLiveAgentStore(db, env.TWILIO_PHONE_NUMBER) } : {}),
    },
  } : { proposeFactFromChat, publish: { integrations } };

  const fallback = createDbFallback({ db, providers, ownedNumber: env.TWILIO_PHONE_NUMBER, newId,
    ...(options.versionEnablesFallback ? { versionEnablesFallback: options.versionEnablesFallback } : {}) });

  const voiceMissing = [
    ...(env.PUBLIC_SERVER_URL ? [] : ['PUBLIC_SERVER_URL']),
    ...(providers.twilioValidator ? [] : ['TWILIO_AUTH_TOKEN']),
    ...(providers.openaiSocketFactory ? [] : ['OPENAI_API_KEY']),
    ...(hasDb ? [] : ['DATABASE_URL']),
  ];
  const voice: ComposedServer['voice'] = voiceMissing.length === 0 && env.PUBLIC_SERVER_URL && providers.twilioValidator && providers.openaiSocketFactory
    ? { ok: true, options: {
      publicServerUrl: env.PUBLIC_SERVER_URL, liveAgent: dbLiveAgentPort(db), calls,
      facts: { snapshot: (businessId) => facts.readVerified({ businessId, signal: NO_SIGNAL }) },
      events: dbVoiceEventsPort(db, newId, now, env.TWILIO_PHONE_NUMBER),
      toolsetFactory: (ctx) => { const ts = toolsetFor(ctx); return { handler: ts.handler, dispose: () => ts.dispose() }; },
      twilioValidator: providers.twilioValidator,
      openaiSocketFactory: providers.openaiSocketFactory, messageChannel, fallback: fallback.relay, decisions,
      ...(env.OPENAI_REALTIME_MODEL ? { model: env.OPENAI_REALTIME_MODEL } : {}),
      redactSecrets: [env.OPENAI_API_KEY, env.TWILIO_AUTH_TOKEN].filter((s): s is string => typeof s === 'string'),
    } }
    : { ok: false, missing: voiceMissing };
  // Health reports the phone path as off, with the settings that keep it off (names only, never values).
  if (!voice.ok) providers.status.twilio = { configured: false, detail: `phone voice off: missing ${voiceMissing.join(', ')}` };

  const health = createHealthMonitor({ status: providers.status, probes: providers.probes ?? {}, now, ...(options.healthProbeTimeoutMs ? { timeoutMs: options.healthProbeTimeoutMs } : {}) });

  // Telemetry (B-30): one in-memory recorder (created above); approval_time is derived from activity events.
  const telemetryOptions: TelemetryPluginOptions = {
    recorder: telemetry,
    async guard(request, businessId) {
      const owner = (request as { ownerUserId?: string }).ownerUserId;
      if (!owner) return { ok: false, code: 'UNAUTHENTICATED' };
      const owned = await db.query('select 1 from public.businesses where id = $1 and owner_id = $2', [businessId, owner]);
      return owned.rows.length ? { ok: true } : { ok: false, code: 'FORBIDDEN_BUSINESS' };
    },
    eventSource: hasDb ? {
      async listEvents({ businessId, since, types }) {
        const found = await db.query(`select * from public.activity_events where business_id = $1 and type = any($2::text[])
          and ($3::timestamptz is null or occurred_at >= $3) order by occurred_at limit 5000`, [businessId, [...types], since ?? null]);
        return found.rows.flatMap((r) => { const p = ActivityEventSchema.safeParse(mapRow(r)); return p.success ? [p.data] : []; });
      },
    } : undefined,
  };

  let sweep: ReturnType<typeof setInterval> | undefined;
  return {
    env, db, verifier, engine, enginePorts, catalogSync, providers, calls, toolsetPorts, toolsetFor, agentModel, builder, proposeFactFromChat, voice, executor, webhooksPlugin, webhooks, prices, recovery, fallback, decisions,
    databaseProbe: hasDb ? async () => (await db.query('select 1 as ok', [])).rows.length === 1 : undefined, telemetry: telemetryOptions, health, now, newId,
    async close() { if (pool) await pool.end(); },
    async assertRuntimeRole() { if (hasDb) await assertRestrictedRuntimeRole(db); },
    startJobs() {
      if (!hasDb || sweep) return;
      // API 3.7: a background job moves past-due approvals to EXPIRED. The routine writes the events.
      sweep = setInterval(() => { engine.expireDue().then(async (expired) => {
        for (const e of expired) await decisions.publish(db, { businessId: e.business_id, approvalId: e.id, state: 'EXPIRED' }).catch(() => undefined);
      }).catch((error: unknown) => log.error({ job: 'expiry', code: error instanceof Error ? error.name : 'unknown' }, 'approval expiry sweep failed')); }, 30_000);
      sweep.unref();
      executor.start();
      webhooks?.start();
    },
    async stopJobs() {
      if (sweep) clearInterval(sweep);
      sweep = undefined;
      await executor.stop();
      await webhooks?.stop();
    },
  };
}
