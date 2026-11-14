import { E164Schema, ENDPOINTS, PAGE_LIMIT_DEFAULT } from '@abos/contracts';
import { DEMO_PHONE_NUMBER } from '@abos/contracts/fixtures';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AgentService, LiveAgentReader } from '../agents';
import { requireBusiness, type BuilderAuth } from '../auth';
import type { ConflictStore } from '../extraction/index';
import type { BusinessKnowledge } from '../session/knowledge';
import type { AgentDraftStore } from '../session/stores';
import { checkedResponse } from '../respond';
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

// The demo number of the shared fixtures (the API.md 3.6 example), used only
// when TWILIO_PHONE_NUMBER is not set, so the in-memory pointer has a number.
const PLACEHOLDER_NUMBER = DEMO_PHONE_NUMBER;

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
  const liveAgents = options?.liveAgents ?? new InMemoryLiveAgentStore(configured && E164Schema.safeParse(configured).success ? configured : PLACEHOLDER_NUMBER);
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

// Params, bodies and queries are parsed with the endpoint schemas of the
// package (ENDPOINTS). `confirm` must be exactly true (API.md 3.4); anything
// else is VALIDATION_FAILED.
const NoFields = z.strictObject({});
const E = {
  publish: ENDPOINTS.publishAgent,
  pause: ENDPOINTS.pauseAgent,
  versions: ENDPOINTS.listAgentVersions,
  rollback: ENDPOINTS.rollbackAgent,
};

export function registerPublishRoutes(app: FastifyInstance, deps: PublishRouteDeps) {
  const service = new PublishService(deps);

  app.post('/api/agents/:id/publish', async (request) => {
    const scope = await requireBusiness(deps.auth, request);
    const { id } = parseOrThrow(E.publish.params, request.params);
    const body = parseOrThrow(E.publish.body, request.body ?? {});
    const result = await service.publish({ businessId: scope.businessId, ownerId: scope.owner.userId, correlationId: request.correlationId }, id, { makeLive: body.makeLive ?? false });
    return checkedResponse('publishAgent', result);
  });

  app.post('/api/agents/:id/pause', async (request) => {
    const scope = await requireBusiness(deps.auth, request);
    const { id } = parseOrThrow(E.pause.params, request.params);
    parseOrThrow(E.pause.body, request.body ?? {});
    // The contract's empty body would drop unknown fields. The builder refuses
    // them, as it did before, so a mistyped field is not silently ignored.
    parseOrThrow(NoFields, request.body ?? {});
    return checkedResponse('pauseAgent', await service.pause({ businessId: scope.businessId, ownerId: scope.owner.userId, correlationId: request.correlationId }, id));
  });

  app.get('/api/agents/:id/versions', async (request) => {
    const scope = await requireBusiness(deps.auth, request);
    const { id } = parseOrThrow(E.versions.params, request.params);
    const query = parseOrThrow(E.versions.query, request.query ?? {});
    const page = await service.listVersions(scope.businessId, id, { limit: query.limit ?? PAGE_LIMIT_DEFAULT, ...(query.cursor !== undefined ? { cursor: query.cursor } : {}) });
    return checkedResponse('listAgentVersions', page);
  });

  app.post('/api/agents/:id/rollback', async (request) => {
    const scope = await requireBusiness(deps.auth, request);
    const { id } = parseOrThrow(E.rollback.params, request.params);
    const body = parseOrThrow(E.rollback.body, request.body ?? {});
    const result = await service.rollback({ businessId: scope.businessId, ownerId: scope.owner.userId, correlationId: request.correlationId }, id, {
      toVersionId: body.toVersionId,
      makeLive: body.makeLive ?? false,
    });
    return checkedResponse('rollbackAgent', result);
  });

  return { service };
}
