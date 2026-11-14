import { ENDPOINTS } from '@abos/contracts';
import type { FastifyInstance } from 'fastify';
import { requireBusiness, type BuilderAuth } from '../auth';
import type { BuilderSessionStore } from '../session/stores';
import { checkedResponse } from '../respond';
import { apiError, parseOrThrow } from '../util';
import { parseVoiceEnv, REALTIME_MODEL } from './env';
import { OpenAiRealtimeMinter, UnavailableRealtimeMinter, type RealtimeMinter } from './minter';
import { SlidingWindowLimiter } from './rate-limit';
import { builderVoiceClientSecretRequest } from './session-config';

// Owner voice for the builder (docs/API.md 3.5, task B-24).
//
//   POST /api/realtime/client-secret?businessId=   body { builderSessionId }
//
// Returns a short-lived OpenAI Realtime client secret (RealtimeClientSecret in
// docs/CONTRACTS.md). The server's OPENAI_API_KEY never leaves the server: it is
// used only in the request to OpenAI, and is never in a response, header, error
// or log line. The client secret is not stored and not logged either.

export type { RealtimeMinter } from './minter';

// A few mints per owner per minute. API.md lists RATE_LIMITED with Retry-After.
export const MINTS_PER_WINDOW = 5;
export const MINT_WINDOW_MS = 60_000;

export interface VoiceRouteDeps {
  auth: BuilderAuth;
  sessions: BuilderSessionStore;
  env: Record<string, string | undefined>;
  now: () => Date;
  // Tests pass a fake. Otherwise it is chosen from the environment.
  minter?: RealtimeMinter;
}


function chooseMinter(app: FastifyInstance, env: Record<string, string | undefined>): RealtimeMinter {
  const voiceEnv = parseVoiceEnv(env);
  if (voiceEnv.mode === 'openai') {
    return new OpenAiRealtimeMinter({ apiKey: voiceEnv.apiKey, log: app.log });
  }
  if (voiceEnv.mode === 'misconfigured') {
    app.log.warn(`owner voice is off: ${voiceEnv.reason}`);
  }
  return new UnavailableRealtimeMinter();
}

export function registerVoiceRoutes(app: FastifyInstance, deps: VoiceRouteDeps): void {
  const minter = deps.minter ?? chooseMinter(app, deps.env);
  const limiter = new SlidingWindowLimiter(MINTS_PER_WINDOW, MINT_WINDOW_MS, deps.now);
  app.log.info({ realtimeMinter: minter.kind }, 'owner voice ready');

  app.post('/api/realtime/client-secret', async (request, reply) => {
    const scope = await requireBusiness(deps.auth, request);
    const { builderSessionId } = parseOrThrow(ENDPOINTS.createRealtimeClientSecret.body, request.body ?? {});
    const session = await deps.sessions.get(scope.businessId, builderSessionId);
    if (!session) throw apiError('NOT_FOUND', 'Builder session not found.');

    const limit = limiter.take(scope.owner.userId);
    if (!limit.ok) {
      reply.header('Retry-After', String(limit.retryAfterSeconds));
      throw apiError('RATE_LIMITED', 'Too many voice sessions started. Try again shortly.', {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    const minted = await minter.mint(builderVoiceClientSecretRequest(REALTIME_MODEL));
    request.log.info({ builderSessionId, expiresAt: minted.expiresAt.toISOString() }, 'realtime client secret minted');
    reply.header('Cache-Control', 'no-store');
    return checkedResponse('createRealtimeClientSecret', {
      clientSecret: minted.value,
      expiresAt: minted.expiresAt.toISOString(),
      model: REALTIME_MODEL,
      builderSessionId,
    });
  });
}
