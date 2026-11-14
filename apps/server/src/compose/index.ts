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
import type { MessageChannelSetting } from '@abos/contracts';
import type { FastifyPluginAsync } from 'fastify';
// The in-memory engine in api/ports.ts is a test fake and is never wired here.
import type { CatalogPort as RouteCatalogPort, EnginePorts } from '../api/ports';
import { createBuilderAuth, createVerifier, type TokenVerifier } from '../auth/verify';
import type { AgentModel } from '../builder/runner/agent-model';
import { OpenAiAgentModel } from '../builder/runner/openai-agent-model';
import { RecordedAgentModel } from '../builder/runner/recorded-agent-model';
import { createDb, createPool, unavailableDb, type Db } from '../db/index';
import type { Env } from '../env';
import { AppError } from '../errors';
import { emitActivity } from '../policy/activity';
import { createPolicyEngine, type PolicyEngine } from '../policy/engine';
import { createRealToolset, type RealToolset, type RealToolsetPorts } from '../tools/real/index';
import type { VoicePluginOptions } from '../voice/types';
import {
  calendarAvailabilityPort, dbCallsPort, dbCatalogPort, dbFactsPort, dbLiveAgentPort, dbOrderStatusPort, engineProposalPort, squareQuotePort,
  type CallsStore,
} from './ports';
import { buildProviders, type Providers } from './providers';
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
  // PLUG-IN B-11: pass the executor factory here, or replace `notWiredExecutor` below.
  executor?: ExecutorFactory;
  // PLUG-IN B-13: pass the webhooks plugin factory here, or replace `notWiredWebhooks` below.
  webhooks?: WebhooksFactory;
  log?: SeamDeps['log'];
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
  toolsetFor(ctx: { businessId: string; agentVersionId: string; callId: string; capabilities: readonly import('@abos/contracts').CapabilityId[] }): RealToolset;
  agentModel: AgentModel;
  /** Options for the builder plugin's own seams. Empty when auth cannot be verified, so the builder fails closed. */
  builder: { auth?: ReturnType<typeof createBuilderAuth>; liveAgent?: { isLiveAgent(businessId: string, agentId: string): Promise<boolean> } };
  /** Voice plugin options, or the list of missing settings that keep the phone path off. */
  voice: { ok: true; options: VoicePluginOptions } | { ok: false; missing: string[] };
  executor: Executor;
  webhooksPlugin: FastifyPluginAsync;
  /** Background jobs: the approval expiry sweep (API 3.7) and the executor loop. */
  startJobs(): void;
  stopJobs(): Promise<void>;
  now(): Date;
  newId(prefix: string): string;
}

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
    proposals: engineProposalPort(engine, facts, providers),
    orderStatus: dbOrderStatusPort(db),
    availability: calendarAvailabilityPort(facts, providers),
  };
  const toolsetFor: ComposedServer['toolsetFor'] = (ctx) => createRealToolset({ businessId: ctx.businessId, messageChannel, ports: toolsetPorts, capabilities: ctx.capabilities, now });
  const calls = dbCallsPort(db, newId);

  const seamDeps: SeamDeps = { env, db, engine, providers, now, newId, log };
  const executor = (options.executor ?? notWiredExecutor)(seamDeps);
  const webhooksPlugin = (options.webhooks ?? notWiredWebhooks)(seamDeps);

  // Routes' engine port. After an approval the executor is told to look for work.
  const enginePorts: EnginePorts = options.ports ?? {
    async decide(input) {
      const result = await engine.decide(input);
      if (result.approval.state === 'APPROVED') executor.kick(result.approval.businessId);
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

  const agentModel: AgentModel = options.agentModel
    ?? (env.OPENAI_API_KEY && env.OPENAI_BUILDER_MODEL ? new OpenAiAgentModel({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_BUILDER_MODEL }) : new RecordedAgentModel());

  const builder: ComposedServer['builder'] = hasDb && authConfigured ? {
    auth: createBuilderAuth(db, verifier),
    liveAgent: {
      async isLiveAgent(businessId, agentId) {
        const row = await db.query('select 1 from public.live_agent where business_id = $1 and agent_id = $2', [businessId, agentId]);
        return row.rows.length > 0;
      },
    },
  } : {};

  const voiceMissing = [
    ...(env.PUBLIC_SERVER_URL ? [] : ['PUBLIC_SERVER_URL']),
    ...(providers.twilioValidator ? [] : ['TWILIO_AUTH_TOKEN']),
    ...(providers.openaiSocketFactory ? [] : ['OPENAI_API_KEY']),
    ...(hasDb ? [] : ['DATABASE_URL']),
  ];
  const voice: ComposedServer['voice'] = voiceMissing.length === 0 && env.PUBLIC_SERVER_URL && providers.twilioValidator && providers.openaiSocketFactory
    ? { ok: true, options: {
      publicServerUrl: env.PUBLIC_SERVER_URL, liveAgent: dbLiveAgentPort(db), calls,
      toolsetFactory: (ctx) => toolsetFor(ctx).handler, twilioValidator: providers.twilioValidator,
      openaiSocketFactory: providers.openaiSocketFactory, messageChannel,
      ...(env.OPENAI_REALTIME_MODEL ? { model: env.OPENAI_REALTIME_MODEL } : {}),
      redactSecrets: [env.OPENAI_API_KEY, env.TWILIO_AUTH_TOKEN].filter((s): s is string => typeof s === 'string'),
    } }
    : { ok: false, missing: voiceMissing };

  let sweep: ReturnType<typeof setInterval> | undefined;
  return {
    env, db, verifier, engine, enginePorts, catalogSync, providers, calls, toolsetPorts, toolsetFor, agentModel, builder, voice, executor, webhooksPlugin, now, newId,
    async close() { if (pool) await pool.end(); },
    startJobs() {
      if (!hasDb || sweep) return;
      // API 3.7: a background job moves past-due approvals to EXPIRED. The routine writes the events.
      sweep = setInterval(() => { engine.expireDue().catch((error: unknown) => log.error({ job: 'expiry', code: error instanceof Error ? error.name : 'unknown' }, 'approval expiry sweep failed')); }, 30_000);
      sweep.unref();
      executor.start();
    },
    async stopJobs() {
      if (sweep) clearInterval(sweep);
      sweep = undefined;
      await executor.stop();
    },
  };
}
