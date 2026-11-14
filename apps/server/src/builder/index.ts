import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AgentService, CreateAgentBodySchema, type LiveAgentReader } from './agents';
import { NotConfiguredAuth, requireBusiness, UnverifiedSeedOwnerAuth, type BuilderAuth } from './auth';
import { builderAuthMode, parseBuilderEnv } from './env';
import { registerExtractionRoutes, withConflicts, type ExtractionOptions } from './extraction/index';
import { createPublishStores, registerPublishRoutes, type PublishOptions } from './publish/index';
import { AgentRunRequestSchema, AgentStatusSchema, type ToolHandler } from './pending-contracts';
import type { AgentModel } from './runner/agent-model';
import { MockToolset } from './runner/mock-toolset';
import { OpenAiAgentModel } from './runner/openai-agent-model';
import { RecordedAgentModel } from './runner/recorded-agent-model';
import { AgentRunService } from './runner/service';
import { MockTextRunner } from './runner/text-runner';
import { FixtureBusinessKnowledge, type BusinessKnowledge } from './session/knowledge';
import type { BuilderModel } from './session/model';
import { OpenAiBuilderModel } from './session/openai-builder-model';
import { RecordedBuilderModel } from './session/recorded-builder-model';
import { BuilderSessionService } from './session/service';
import {
  InMemoryAgentDraftStore,
  InMemoryBuilderSessionStore,
  InMemoryDraftFactStore,
  type AgentDraftStore,
  type BuilderSessionStore,
  type DraftFactStore,
} from './session/stores';
import { parseOrThrow } from './util';
import { registerVoiceRoutes, type RealtimeMinter } from './voice/index';

// The builder on the server. Owner: Saina (decision D-07 in docs/SPEC.md).
//
// Routes (full paths from docs/API.md):
//   3.3  POST /api/builder/sessions, GET /api/builder/sessions/:id,
//        POST /api/builder/sessions/:id/messages
//   3.4  GET /api/agents, POST /api/agents, GET /api/agents/:id,
//        POST /api/agents/:id/preview, POST /api/agents/:id/test
//        POST /api/agents/:id/publish, POST /api/agents/:id/pause,
//        GET /api/agents/:id/versions, POST /api/agents/:id/rollback (publish/)
// sim-call and /api/live-agent are Arsh's.
//
// The server entry registers this plugin with no options, so every dependency
// has an in-memory or recorded default. Tests and later tasks pass real ones.

export interface BuilderPluginOptions {
  auth?: BuilderAuth;
  env?: Record<string, string | undefined>;
  builderModel?: BuilderModel;
  agentModel?: AgentModel;
  // Must report toolset "mock". The runner refuses anything else.
  toolset?: ToolHandler & { reset?(key: string): void };
  sessions?: BuilderSessionStore;
  agents?: AgentDraftStore;
  draftFacts?: DraftFactStore;
  knowledge?: BusinessKnowledge;
  liveAgent?: LiveAgentReader;
  now?: () => Date;
  realtimeMinter?: RealtimeMinter;
  extraction?: ExtractionOptions;
  publish?: PublishOptions;
}

const SessionIdParams = z.object({ id: z.string().regex(/^bld_[A-Za-z0-9_]{1,64}$/) });
const AgentIdParams = z.object({ id: z.string().regex(/^agt_[A-Za-z0-9_]{1,64}$/) });
const CreateSessionBody = z.strictObject({ agentId: z.string().min(1).optional() });
const MessageBody = z.strictObject({
  text: z.string().trim().min(1).max(4000),
  inputMode: z.enum(['text', 'voice']).default('text'),
});
const PreviewBody = z.strictObject({ scenarios: z.array(z.string().max(60)).max(10).optional() });
const ListAgentsQuery = z.object({
  state: AgentStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

export const builderPlugin: FastifyPluginAsync<BuilderPluginOptions> = async (app, options) => {
  const source = options.env ?? process.env;
  const env = parseBuilderEnv(source);
  const now = options.now ?? (() => new Date());

  // Fail closed: without a real auth option, the unverified stand-in runs only
  // on the explicit BUILDER_DEV_AUTH=1 opt-in, and never in production.
  let auth: BuilderAuth;
  if (options.auth) {
    auth = options.auth;
  } else {
    const mode = builderAuthMode(source);
    if (mode === 'dev') {
      auth = new UnverifiedSeedOwnerAuth();
      app.log.warn('BUILDER_DEV_AUTH=1: builder routes use UnverifiedSeedOwnerAuth and the bearer token is NOT verified');
    } else {
      auth = new NotConfiguredAuth();
      if (mode === 'refused_in_production') {
        app.log.error('BUILDER_DEV_AUTH=1 is refused because NODE_ENV is production: builder routes answer UNAUTHENTICATED');
      } else {
        app.log.warn('builder auth is not configured: builder routes answer UNAUTHENTICATED (waiting on auth task B-08)');
      }
    }
  }

  const builderModel =
    options.builderModel ?? (env.mode === 'openai' ? new OpenAiBuilderModel({ apiKey: env.apiKey, model: env.model }) : new RecordedBuilderModel());
  const agentModel =
    options.agentModel ?? (env.mode === 'openai' ? new OpenAiAgentModel({ apiKey: env.apiKey, model: env.model }) : new RecordedAgentModel());
  app.log.info({ builderModel: builderModel.kind, agentModel: agentModel.kind }, 'builder models ready');

  const sessions = options.sessions ?? new InMemoryBuilderSessionStore();
  const agents = options.agents ?? new InMemoryAgentDraftStore();
  const draftFacts = options.draftFacts ?? new InMemoryDraftFactStore();
  const baseKnowledge = options.knowledge ?? new FixtureBusinessKnowledge();

  // ---- 3.2 Files and extraction, 3.12 conflict resolve (task B-21)
  // Registered first so the interview and the test runs below see open
  // conflicts from uploads as stop conditions.
  const extraction = registerExtractionRoutes(app, { ...options.extraction, auth, knowledge: baseKnowledge, env, now });
  const knowledge = withConflicts(baseKnowledge, extraction.conflicts);
  const toolset = options.toolset ?? new MockToolset(now);

  // ---- publish, pause, versions, rollback (tasks B-17, B-27). Draft writers
  // get a guarded store, so a draft write cannot undo a publish or a pause.
  const publish = createPublishStores(options.publish, source);
  const draftAgents = publish.guardDraftWrites(agents);
  const builder = new BuilderSessionService({ sessions, agents: draftAgents, draftFacts, knowledge, model: builderModel, now });
  const agentService = new AgentService({ agents: draftAgents, sessions, liveAgent: options.liveAgent ?? publish.liveAgentReader, activeVersions: publish.versions, now });
  const runs = new AgentRunService({ agents, knowledge, runner: new MockTextRunner(toolset, agentModel, now), toolset });

  registerVoiceRoutes(app, { auth, sessions, env: source, now, minter: options.realtimeMinter });

  app.get('/api/builder/ping', async () => ({ ok: true, lane: 'builder' }));


  // ---- 3.3 Builder sessions
  app.post('/api/builder/sessions', async (request, reply) => {
    const scope = await requireBusiness(auth, request);
    const body = parseOrThrow(CreateSessionBody, request.body ?? {});
    const session = await builder.create({ businessId: scope.businessId, ownerId: scope.owner.userId, ...(body.agentId ? { agentId: body.agentId } : {}) });
    return reply.status(201).send(session);
  });

  app.get('/api/builder/sessions/:id', async (request) => {
    const scope = await requireBusiness(auth, request);
    const { id } = parseOrThrow(SessionIdParams, request.params);
    return builder.get(scope.businessId, id);
  });

  app.post('/api/builder/sessions/:id/messages', async (request) => {
    const scope = await requireBusiness(auth, request);
    const { id } = parseOrThrow(SessionIdParams, request.params);
    const body = parseOrThrow(MessageBody, request.body ?? {});
    return builder.message(scope.businessId, id, body);
  });

  // ---- 3.4 Agents (builder lane part)
  app.get('/api/agents', async (request) => {
    const scope = await requireBusiness(auth, request);
    const { businessId: _b, ...rest } = (request.query ?? {}) as Record<string, unknown>;
    const query = parseOrThrow(ListAgentsQuery, rest);
    return agentService.list(scope.businessId, query);
  });

  app.post('/api/agents', async (request, reply) => {
    const scope = await requireBusiness(auth, request);
    const body = parseOrThrow(CreateAgentBodySchema, request.body ?? {});
    return reply.status(201).send(await agentService.create(scope.businessId, body));
  });

  app.get('/api/agents/:id', async (request) => {
    const scope = await requireBusiness(auth, request);
    const { id } = parseOrThrow(AgentIdParams, request.params);
    return agentService.summary(await agentService.get(scope.businessId, id));
  });

  app.post('/api/agents/:id/preview', async (request) => {
    const scope = await requireBusiness(auth, request);
    const { id } = parseOrThrow(AgentIdParams, request.params);
    const body = parseOrThrow(PreviewBody, request.body ?? {});
    return runs.preview(scope.businessId, id, body.scenarios, request.correlationId);
  });

  app.post('/api/agents/:id/test', async (request) => {
    const scope = await requireBusiness(auth, request);
    const { id } = parseOrThrow(AgentIdParams, request.params);
    const body = parseOrThrow(AgentRunRequestSchema, request.body ?? {});
    return runs.test(scope.businessId, id, body, request.correlationId);
  });

  registerPublishRoutes(app, { ...publish, auth, agents, agentService, conflicts: extraction.conflicts, knowledge: baseKnowledge, now });
};
