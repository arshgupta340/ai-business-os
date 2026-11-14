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
import { ActivityEventSchema, type ErrorCode, type MessageChannelSetting } from '@abos/contracts';
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
import { createFirstAudioTap, type FirstAudioTap } from '../telemetry/voice';
import { mapRow } from '../api/rows';
import type { PricesDependencies } from '../api/prices/index';
import type { RecoveryPorts } from '../api/recovery/index';
import { createDbRecoveryPorts } from './recovery';
import { createDbFallback, type FallbackDeps } from './fallback';
import { catalogOwnedElsewhere, dbAgentVersionStore, dbLiveAgentStore, dbPublishEventSink, squareCatalogSync } from './builder-publish';
import { createCallDecisions, type CallDecisionsBus } from './decisions';
import { dbExtractionOptions } from './builder-extraction';
import type { DocumentExtractor } from '../builder/extraction/index';
import { createProposeFactFromChat, dbAgentDraftStore, dbBuilderSessionStore, dbBusinessKnowledge, dbDraftFactStore, dbLiveAgentReader, type ProposeFactFromChat } from './builder';
import { notWiredExecutor, notWiredWebhooks, type Executor, type ExecutorFactory, type SeamDeps, type WebhooksFactory } from './seams';
import { buildTelephony, type Telephony } from '../telephony/index';
import type { HttpPort } from '../telephony/agentphone/client';
import { createAgentPhoneWiring, type AgentPhoneWiring } from './agentphone';


export type { ExecutorFactory, WebhooksFactory, Executor, SeamDeps } from './seams';

export interface ComposeOptions {
  db?: Db;
  verifier?: TokenVerifier;
  /** Replaces the approval engine behind the routes (route tests use the in-memory fake). */
  ports?: EnginePorts;
  catalog?: RouteCatalogPort;
  providers?: Partial<Providers>;
  agentModel?: AgentModel;
  /** Replaces the builder's document extractor (tests pass a fake, so no provider is called). */
  documentExtractor?: DocumentExtractor;
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
  /** D-12: the AgentPhone HTTP ports and voice-turn timings (tests inject fakes and short times). */
  telephony?: { http?: HttpPort; interimAfterMs?: number; turnTimeoutMs?: number };
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
  /** `consent` is the phone relay's trusted evidence reader (PROPOSED text step). Sim-call never passes it, so its proposals stay qr_only. */
  toolsetFor(ctx: { businessId: string; agentVersionId: string; callId: string; capabilities: readonly import('@abos/contracts').CapabilityId[]; facts?: FactsSnapshot | undefined; consent?: import('../tools/real/types').ConsentSource | undefined }): RealToolset;
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
  /** D-12: the selected telephony provider (TELEPHONY_PROVIDER) and, when used, the AgentPhone one. */
  telephony: Telephony;
  /** D-12: the AgentPhone webhook, voice turns and receipt polling, or why it is off. */
  agentphone: AgentPhoneWiring;
  /** GET /api/telemetry (B-30) and the recorder modules may record into. */
  telemetry: TelemetryPluginOptions;
  /** first_audio per phone call (B-30): app.ts wraps the voice logger with it. */
  firstAudio: FirstAudioTap;
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
  /** The server's structured logger (the one the seams use). */
  log: SeamDeps['log'];
}

/** For server-side reads that no caller can cancel (the voice worker's pinned snapshot, sim-call). */
const NO_SIGNAL = new AbortController().signal;
/** The most menu items written into the phone prompt. A longer menu is cut by the prompt size cap. */
const VOICE_MENU_LIMIT = 60;
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
  // webhook_delay in webhooks.ts. The voice relay takes no telemetry port: first_audio is read from
  // its call-end line through the tap below (telemetry/voice.ts). The executor records nothing.
  const telemetry = createTelemetry({ now: () => now().getTime() });
  const firstAudio = createFirstAudioTap(telemetry);
  const toolsetFor: ComposedServer['toolsetFor'] = (ctx) => {
    let snapshot: Promise<FactsSnapshot> | undefined = ctx.facts ? Promise.resolve(ctx.facts) : undefined;
    const pinned = (businessId: string) => {
      if (businessId !== ctx.businessId) return Promise.reject(new AppError('FORBIDDEN_BUSINESS', 'Another business.'));
      snapshot ??= facts.readVerified({ businessId, signal: NO_SIGNAL });
      return snapshot;
    };
    const ports: RealToolsetPorts = { ...toolsetPorts, facts: { readVerified: ({ businessId }) => pinned(businessId) },
      proposals: engineProposalPort(engine, pinned, providers, now), availability: calendarAvailabilityPort(providers, pinned) };
    // The evidence reader is bound to this call; the toolset also refuses evidence for any other call or version.
    const consent = ctx.consent !== undefined && ctx.consent.callId === ctx.callId && ctx.consent.agentVersionId === ctx.agentVersionId ? ctx.consent : undefined;
    const ts = createRealToolset({ businessId: ctx.businessId, messageChannel, ports, capabilities: ctx.capabilities, now, ...(ctx.facts ? { factsSnapshot: ctx.facts } : {}), ...(consent ? { consent } : {}) });
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
      if (await catalogOwnedElsewhere(db, businessId)) throw new AppError('CAPABILITY_NOT_ALLOWED', 'The Square catalog on this server belongs to another business.');
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
      const row = (await db.query('select id, square_item_id, square_variation_id, item_name, variation_name from public.catalog_items where business_id = $1 and square_variation_id = $2', [businessId, variationId])).rows[0] as Record<string, unknown> | undefined;
      const name = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
      const itemName = name(row?.item_name);
      const variationName = name(row?.variation_name);
      return row ? { businessId, subjectId: String(row.id), squareItemId: String(row.square_item_id), variationId: String(row.square_variation_id),
        ...(itemName ? { itemName } : {}), ...(variationName ? { variationName } : {}) } : null;
    } },
    square: { readVariationPrice(variationId) {
      if (!providers.prices) throw new AppError('INTEGRATION_UNAVAILABLE', 'Square is not configured.');
      return providers.prices.readVariationPrice(variationId);
    } },
    approvals: { createPendingPriceEditApproval: async (input) => {
      const r = await engine.createPriceEditApproval({ ownerUserId: input.ownerUserId, payload: input.payload, payloadHash: input.payloadHash,
        ...(input.resolvesConflictId ? { resolvesConflictId: input.resolvesConflictId } : {}) })
        // The prices route answers an AppError with its code. A refusal when the proposal names a conflict
        // (issue #96) is passed on as one. Without a named conflict the old mapping stays (a PolicyError
        // answers INTERNAL); apps/web/test/real-server/knowledge.test.ts tracks that as an expected failure.
        .catch((error: unknown) => {
          throw input.resolvesConflictId && error instanceof Error && error.name === 'PolicyError'
            ? new AppError((error as Error & { code: ErrorCode }).code, error.message) : error;
        });
      return r.kind === 'conflict' ? r : { kind: r.kind, approval: r.approval as Extract<typeof r.approval, { bundleType: 'price_edit' }> };
    } },
    now,
  };

  // What keeps the Twilio phone path off, by name. Also the Twilio telephony provider's `missing`.
  const voiceMissing = [
    ...(env.PUBLIC_SERVER_URL ? [] : ['PUBLIC_SERVER_URL']),
    ...(providers.twilioValidator ? [] : ['TWILIO_AUTH_TOKEN']),
    ...(providers.openaiSocketFactory ? [] : ['OPENAI_API_KEY']),
    ...(hasDb ? [] : ['DATABASE_URL']),
  ];
  const telephony = buildTelephony(env, { now,
    twilio: { validator: providers.twilioValidator, probe: providers.probes?.twilio, missing: voiceMissing },
    ...(options.telephony?.http ? { http: options.telephony.http } : {}) });
  const phoneLine = telephony.active.phoneNumber;
  // The AgentPhone path answers with the text agent model; without one it stays off (never the recorded stand-in).
  const modelMissing = options.agentModel || (env.OPENAI_API_KEY && env.OPENAI_BUILDER_MODEL) ? [] : ['OPENAI_API_KEY', 'OPENAI_BUILDER_MODEL'].filter((k) => !env[k as keyof Env]);

  const agentModel: AgentModel = options.agentModel
    ?? (env.OPENAI_API_KEY && env.OPENAI_BUILDER_MODEL ? new OpenAiAgentModel({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_BUILDER_MODEL }) : new RecordedAgentModel());

  // The builder's own seams (issue #65). Without a database it keeps its in-memory defaults, and
  // without a way to verify tokens it keeps its fail-closed auth default.
  const proposeFactFromChat = createProposeFactFromChat(engine);
  // Publish stops on a disconnected integration (Twilio, OpenAI, Square, Calendar as the spec needs).
  // A publish runs the bounded read-only probes now, so a provider never checked is not taken as down
  // and a provider that went down since the last check is caught.
  const integrations = { read: () => health.read({ refresh: true }) };
  // Extraction (uploads, the draft facts drawn from them, their conflicts) is on the database too
  // (builder-extraction.ts). File contents have no column and no bucket: they stay in this process
  // only while one extraction runs. Without a database the builder keeps its in-memory defaults.
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
    extraction: dbExtractionOptions(db, options.documentExtractor),
    publish: {
      versions: dbAgentVersionStore(db), events: dbPublishEventSink(db), syncCatalog: squareCatalogSync(db, providers, now), integrations,
      // D-12: publish binds the live agent to the number of the selected telephony provider.
      ...(phoneLine ? { liveAgents: dbLiveAgentStore(db, phoneLine) } : {}),
    },
  } : { proposeFactFromChat, publish: { integrations }, ...(options.documentExtractor ? { extraction: { extractor: options.documentExtractor } } : {}) };

  const fallback = createDbFallback({ db, providers, ownedNumber: env.TWILIO_PHONE_NUMBER, newId,
    ...(options.versionEnablesFallback ? { versionEnablesFallback: options.versionEnablesFallback } : {}) });

  const voice: ComposedServer['voice'] = voiceMissing.length === 0 && env.PUBLIC_SERVER_URL && providers.twilioValidator && providers.openaiSocketFactory
    ? { ok: true, options: {
      publicServerUrl: env.PUBLIC_SERVER_URL, liveAgent: dbLiveAgentPort(db), calls,
      facts: { snapshot: (businessId) => facts.readVerified({ businessId, signal: NO_SIGNAL }) },
      menu: { snapshot: (businessId) => toolsetPorts.catalog.search({ businessId, limit: VOICE_MENU_LIMIT, signal: NO_SIGNAL }) },
      events: dbVoiceEventsPort(db, newId, now, env.TWILIO_PHONE_NUMBER),
      // The relay disposes the call's toolset just before it logs the call end; the tap pairs the two.
      toolsetFactory: (ctx) => { const ts = toolsetFor(ctx); return { handler: ts.handler, dispose: () => { firstAudio.callEnding({ callId: ctx.callId, businessId: ctx.businessId }); ts.dispose(); } }; },
      twilioValidator: providers.twilioValidator,
      openaiSocketFactory: providers.openaiSocketFactory, messageChannel, fallback: fallback.relay, decisions,
      ...(env.OPENAI_REALTIME_MODEL ? { model: env.OPENAI_REALTIME_MODEL } : {}),
      redactSecrets: [env.OPENAI_API_KEY, env.TWILIO_AUTH_TOKEN].filter((s): s is string => typeof s === 'string'),
    } }
    : { ok: false, missing: voiceMissing };
  // Health reports the phone path as off, with the settings that keep it off (names only, never values).
  if (!voice.ok) providers.status.twilio = { configured: false, detail: `phone voice off: missing ${voiceMissing.join(', ')}` };

  // D-12: with TELEPHONY_PROVIDER=agentphone the phone-line entry (key `twilio`, "the phone line your agent
  // answers") reports AgentPhone and runs AgentPhone's read-only probe. It never falls back to Twilio.
  // The same probes object as before (tests and the publish check read and patch it in place).
  const probes = providers.probes ?? (providers.probes = {});
  if (telephony.name === 'agentphone') {
    const ap = telephony.agentphone!;
    const off = [...ap.missing, ...(hasDb ? [] : ['DATABASE_URL']), ...modelMissing];
    providers.status.twilio = off.length ? { configured: false, detail: `telephony provider agentphone: missing ${off.join(', ')}` } : { configured: true, detail: 'telephony provider agentphone' };
    if (ap.probe) probes.twilio = ap.probe; else delete probes.twilio;
  }
  // D-12: MESSAGE_CHANNEL=agentphone has a read-only check, with either telephony provider: the number's
  // outbound SMS state. The channel is connected only when AgentPhone reports outbound texting enabled, so
  // publish refuses an agent with a message capability while the 10DLC registration is still pending.
  // (The other message channels have no read-only check and stay "not confirmed", as on main.)
  if (messageChannel === 'agentphone' && providers.status.message_channel.configured && telephony.agentphone?.messageProbe) {
    probes.message_channel ??= telephony.agentphone.messageProbe;
  }

  const health = createHealthMonitor({ status: providers.status, probes, now, ...(options.healthProbeTimeoutMs ? { timeoutMs: options.healthProbeTimeoutMs } : {}) });

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

  const agentphone = createAgentPhoneWiring({ telephony, db, hasDb, calls, toolsetFor, model: agentModel, messageChannel, decisions, now, newId, log,
    ...(options.telephony?.interimAfterMs !== undefined ? { interimAfterMs: options.telephony.interimAfterMs } : {}),
    ...(options.telephony?.turnTimeoutMs !== undefined ? { turnTimeoutMs: options.telephony.turnTimeoutMs } : {}),
    receiptsEnabled: messageChannel === 'agentphone', modelMissing });

  let sweep: ReturnType<typeof setInterval> | undefined;
  return {
    env, db, verifier, engine, enginePorts, catalogSync, providers, calls, toolsetPorts, toolsetFor, agentModel, builder, proposeFactFromChat, voice, executor, webhooksPlugin, webhooks, prices, recovery, fallback, decisions,
    databaseProbe: hasDb ? async () => (await db.query('select 1 as ok', [])).rows.length === 1 : undefined, telemetry: telemetryOptions, firstAudio, health, telephony, agentphone, now, newId, log,
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
      agentphone.start();
      // Review finding 4: one bounded, read-only health refresh in the background at startup, so the
      // health screens show checked results on a fresh deploy. It never blocks listen; publish refreshes too.
      void health.read({ refresh: true }).catch(() => log.warn({ job: 'health' }, 'startup integration check failed'));
    },
    async stopJobs() {
      if (sweep) clearInterval(sweep);
      sweep = undefined;
      await executor.stop();
      await webhooks?.stop();
      await agentphone.stop();
    },
  };
}
