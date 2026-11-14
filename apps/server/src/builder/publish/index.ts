import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AgentService, LiveAgentReader } from '../agents';
import { requireBusiness, type BuilderAuth } from '../auth';
import type { ConflictStore } from '../extraction/index';
import type { BusinessKnowledge } from '../session/knowledge';
import type { AgentDraftStore } from '../session/stores';
import { parseOrThrow } from '../util';
import { RecordingCatalogSync, type CatalogSync } from './catalog-sync';
import { KeyedLock } from './lock';
import { PublishService } from './service';
import {
  InMemoryAgentVersionStore,
  InMemoryLiveAgentStore,
  InMemoryPublishEventSink,
  type AgentVersionStore,
  type LiveAgentStore,
  type PublishEventSink,
} from './stores';

// Publish, pause, versions and rollback routes (tasks B-17 and B-27).
//
//   API.md 3.4  POST /api/agents/:id/publish, POST /api/agents/:id/pause,
//               GET /api/agents/:id/versions, POST /api/agents/:id/rollback
//
// GET and PUT /api/live-agent are the backend lead's and are not registered
// here. Publish only reads and moves the pointer through LiveAgentStore.

export { RecordingCatalogSync, type CatalogSync, type CatalogSyncInput } from './catalog-sync';
export * from './stores';

// Everything here has an in-memory or recording default.
export interface PublishOptions {
  versions?: AgentVersionStore;
  liveAgents?: LiveAgentStore;
  events?: PublishEventSink;
  syncCatalog?: CatalogSync;
}

// TEMPORARY. The number from API.md 3.6, used only when TWILIO_PHONE_NUMBER is
// not set, so the in-memory pointer has a number to hold.
const PLACEHOLDER_NUMBER = '+15555550199';
const E164 = /^\+[1-9]\d{6,14}$/;

export interface PublishStores {
  versions: AgentVersionStore;
  liveAgents: LiveAgentStore;
  events: PublishEventSink;
  syncCatalog: CatalogSync;
  lock: KeyedLock;
  // Reads isLiveAgent from the live-agent pointer, for agent summaries.
  liveAgentReader: LiveAgentReader;
  // The agent store that draft writers (the builder interview) use. Its update
  // runs under the agent's publish lock and never changes state or
  // activeVersionId, so a draft write can never undo a publish or a pause.
  guardDraftWrites(store: AgentDraftStore): AgentDraftStore;
}

export function createPublishStores(options: PublishOptions | undefined, env: Record<string, string | undefined>): PublishStores {
  const configured = env.TWILIO_PHONE_NUMBER?.trim();
  const liveAgents = options?.liveAgents ?? new InMemoryLiveAgentStore(configured && E164.test(configured) ? configured : PLACEHOLDER_NUMBER);
  const lock = new KeyedLock();
  return {
    versions: options?.versions ?? new InMemoryAgentVersionStore(),
    liveAgents,
    events: options?.events ?? new InMemoryPublishEventSink(),
    syncCatalog: options?.syncCatalog ?? new RecordingCatalogSync().sync,
    lock,
    liveAgentReader: {
      async isLiveAgent(businessId, agentId) {
        const pointer = await liveAgents.get();
        return pointer?.businessId === businessId && pointer.agentId === agentId;
      },
    },
    guardDraftWrites(store) {
      return {
        insert: (agent) => store.insert(agent),
        get: (businessId, id) => store.get(businessId, id),
        list: (businessId) => store.list(businessId),
        update: (agent) =>
          lock.run(agent.id, async () => {
            const current = await store.get(agent.businessId, agent.id);
            if (!current) return store.update(agent);
            const { activeVersionId: _ignored, ...rest } = agent;
            await store.update({ ...rest, state: current.state, ...(current.activeVersionId ? { activeVersionId: current.activeVersionId } : {}) });
          }),
      };
    },
  };
}

export interface PublishRouteDeps extends PublishStores {
  auth: BuilderAuth;
  // The plain store, not the guarded one: publish writes state and activeVersionId.
  agents: AgentDraftStore;
  agentService: AgentService;
  conflicts: ConflictStore;
  knowledge: BusinessKnowledge;
  now: () => Date;
}

const AgentIdParams = z.object({ id: z.string().regex(/^agt_[A-Za-z0-9_]{1,64}$/) });
// confirm must be exactly true (API.md 3.4). Anything else is VALIDATION_FAILED.
const PublishBody = z.strictObject({ confirm: z.literal(true), makeLive: z.boolean().default(false) });
const PauseBody = z.strictObject({});
const RollbackBody = z.strictObject({ toVersionId: z.string().regex(/^agv_[A-Za-z0-9_]{1,64}$/), confirm: z.literal(true) });
const VersionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

export function registerPublishRoutes(app: FastifyInstance, deps: PublishRouteDeps) {
  const service = new PublishService(deps);

  app.post('/api/agents/:id/publish', async (request) => {
    const scope = await requireBusiness(deps.auth, request);
    const { id } = parseOrThrow(AgentIdParams, request.params);
    const body = parseOrThrow(PublishBody, request.body ?? {});
    return service.publish({ businessId: scope.businessId, ownerId: scope.owner.userId, correlationId: request.correlationId }, id, { makeLive: body.makeLive });
  });

  app.post('/api/agents/:id/pause', async (request) => {
    const scope = await requireBusiness(deps.auth, request);
    const { id } = parseOrThrow(AgentIdParams, request.params);
    parseOrThrow(PauseBody, request.body ?? {});
    return service.pause({ businessId: scope.businessId, ownerId: scope.owner.userId, correlationId: request.correlationId }, id);
  });

  app.get('/api/agents/:id/versions', async (request) => {
    const scope = await requireBusiness(deps.auth, request);
    const { id } = parseOrThrow(AgentIdParams, request.params);
    const { businessId: _b, ...rest } = (request.query ?? {}) as Record<string, unknown>;
    const query = parseOrThrow(VersionsQuery, rest);
    return service.listVersions(scope.businessId, id, query);
  });

  app.post('/api/agents/:id/rollback', async (request) => {
    const scope = await requireBusiness(deps.auth, request);
    const { id } = parseOrThrow(AgentIdParams, request.params);
    const body = parseOrThrow(RollbackBody, request.body ?? {});
    return service.rollback({ businessId: scope.businessId, ownerId: scope.owner.userId, correlationId: request.correlationId }, id, { toVersionId: body.toVersionId });
  });

  return { service };
}
