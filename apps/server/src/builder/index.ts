import { ENDPOINTS, PAGE_LIMIT_DEFAULT, type ToolHandler } from '@abos/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AgentService, CreateAgentEnvelopeSchema, type LiveAgentReader } from './agents';
import { NotConfiguredAuth, requireBusiness, UnverifiedSeedOwnerAuth, type BuilderAuth } from './auth';
import { builderAuthMode, parseBuilderEnv } from './env';
import { registerExtractionRoutes, withConflicts, type ExtractionOptions } from './extraction/index';
import { createPublishStores, registerPublishRoutes, type PublishOptions } from './publish/index';
import { checkedResponse } from './respond';
import type { AgentModel } from './runner/agent-model';
import { OpenAiAgentModel } from './runner/openai-agent-model';
import { RecordedAgentModel } from './runner/recorded-agent-model';
import { AgentRunService } from './runner/service';
import { SessionMockToolset } from './runner/session-toolset';
import { MockTextRunner } from './runner/text-runner';
import { FixtureBusinessKnowledge, type BusinessKnowledge } from './session/knowledge';
import type { BuilderModel } from './session/model';
import { OpenAiBuilderModel } from './session/openai-builder-model';
import { RecordedBuilderModel } from './session/recorded-builder-model';
import { BuilderSessionService, type ProposeFactFromChat } from './session/service';
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
  // Opens a fact_edit approval for an owner's chat answer (P-09). Without it,
  // chat answers stay drafts and a turn never carries proposedChange.
  proposeFactFromChat?: ProposeFactFromChat;
}

// Params, queries and bodies are parsed with the endpoint schemas of the
// package (ENDPOINTS). The builder's own limits are checked on top, after the
// contract schema passes: they cap what reaches a model call.
const E = ENDPOINTS;
const MessageLimits = z.object({ text: z.string().trim().min(1).max(4000) });
const PreviewLimits = z.object({ scenarios: z.array(z.string().max(60)).max(10).optional() });
const RunLimits = z.object({ message: z.string().max(2000) });

export const builderPlugin: FastifyPluginAsync<BuilderPluginOptions> = async (app, options) => {
  const source = options.env ?? process.env;
  const env = parseBuilderEnv(source);
  const now = options.now ?? (() => new Date());

  // Every route below declares that the builder's own BuilderAuth guards it,
  // so the server's default-deny guard leaves it to the builder (auth/verify.ts).
  // Registered first, so it sees every route this plugin and its parts add.
  app.addHook('onRoute', (route) => {
    const config = (route.config ?? {}) as Record<string, unknown>;
    if (config.auth === undefined) route.config = { ...config, auth: 'builder' } as typeof route.config;
  });

  // Fail closed: without a real auth option, the unverified stand-in runs only
  // on the explicit BUILDER_DEV_AUTH=1 opt-in, and never in production.
  let auth: BuilderAuth;
  if (options.auth) {
    auth = options.auth;
  } else {
    const mode = builderAuthMode(source);
    if (mode === 'dev') {
      auth = new UnverifiedSeedOwnerAuth();
      app.log.warn(
        'BUILDER_DEV_AUTH=1: builder routes use UnverifiedSeedOwnerAuth and the bearer token is NOT verified. It answers only requests from the loopback address (127.0.0.1, ::1); any other address gets UNAUTHENTICATED',
      );
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
  // The shared mock toolset, one instance per test session, on the runner's clock.
  const toolset = options.toolset ?? new SessionMockToolset(now);

  // ---- publish, pause, versions, rollback (tasks B-17, B-27). Draft writers
  // get a guarded store, so a draft write cannot undo a publish or a pause.
  const publish = createPublishStores(options.publish, source);
  const draftAgents = publish.guardDraftWrites(agents);
  const builder = new BuilderSessionService({ sessions, agents: draftAgents, draftFacts, knowledge, model: builderModel, now, log: app.log,
    ...(options.proposeFactFromChat ? { proposeFactFromChat: options.proposeFactFromChat } : {}) });
  const agentService = new AgentService({ agents: draftAgents, sessions, liveAgent: options.liveAgent ?? publish.liveAgentReader, activeVersions: publish.versions, now });
  const runs = new AgentRunService({ agents, knowledge, runner: new MockTextRunner(toolset, agentModel, now), toolset });

  registerVoiceRoutes(app, { auth, sessions, env: source, now, minter: options.realtimeMinter });

  // ---- 3.3 Builder sessions
  app.post('/api/builder/sessions', async (request, reply) => {
    const scope = await requireBusiness(auth, request);
    const body = parseOrThrow(E.createBuilderSession.body, request.body ?? {});
    const session = await builder.create({ businessId: scope.businessId, ownerId: scope.owner.userId, ...(body.agentId ? { agentId: body.agentId } : {}) });
    return reply.status(E.createBuilderSession.successStatus).send(checkedResponse('createBuilderSession', session));
  });

  app.get('/api/builder/sessions/:id', async (request) => {
    const scope = await requireBusiness(auth, request);
    const { id } = parseOrThrow(E.getBuilderSession.params, request.params);
    return checkedResponse('getBuilderSession', await builder.get(scope.businessId, id));
  });

  app.post('/api/builder/sessions/:id/messages', async (request) => {
    const scope = await requireBusiness(auth, request);
    const { id } = parseOrThrow(E.sendBuilderMessage.params, request.params);
    const body = parseOrThrow(E.sendBuilderMessage.body, request.body ?? {});
    const { text } = parseOrThrow(MessageLimits, body);
    return checkedResponse('sendBuilderMessage', await builder.message(scope.businessId, id, { text, inputMode: body.inputMode }));
  });

  // ---- 3.4 Agents (builder lane part)
  app.get('/api/agents', async (request) => {
    const scope = await requireBusiness(auth, request);
    const query = parseOrThrow(E.listAgents.query, request.query ?? {});
    const page = await agentService.list(scope.businessId, {
      limit: query.limit ?? PAGE_LIMIT_DEFAULT,
      ...(query.state !== undefined ? { state: query.state } : {}),
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    });
    return checkedResponse('listAgents', page);
  });

  app.post('/api/agents', async (request, reply) => {
    const scope = await requireBusiness(auth, request);
    const body = parseOrThrow(CreateAgentEnvelopeSchema, request.body ?? {});
    const agent = await agentService.create(scope.businessId, body);
    return reply.status(E.createAgent.successStatus).send(checkedResponse('createAgent', agent));
  });

  app.get('/api/agents/:id', async (request) => {
    const scope = await requireBusiness(auth, request);
    const { id } = parseOrThrow(E.getAgent.params, request.params);
    return checkedResponse('getAgent', await agentService.summary(await agentService.get(scope.businessId, id)));
  });

  app.post('/api/agents/:id/preview', async (request) => {
    const scope = await requireBusiness(auth, request);
    const { id } = parseOrThrow(E.previewAgent.params, request.params);
    const body = parseOrThrow(E.previewAgent.body, request.body ?? {});
    parseOrThrow(PreviewLimits, body);
    return checkedResponse('previewAgent', await runs.preview(scope.businessId, id, body.scenarios, request.correlationId));
  });

  app.post('/api/agents/:id/test', async (request) => {
    const scope = await requireBusiness(auth, request);
    const { id } = parseOrThrow(E.testAgent.params, request.params);
    const body = parseOrThrow(E.testAgent.body, request.body ?? {});
    parseOrThrow(RunLimits, body);
    return checkedResponse('testAgent', await runs.test(scope.businessId, id, body, request.correlationId));
  });

  registerPublishRoutes(app, { ...publish, auth, agents, agentService, conflicts: extraction.conflicts, knowledge: baseKnowledge, now });
};
