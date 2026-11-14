import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { FastifyPluginAsync, FastifyPluginOptions, FastifyRequest } from 'fastify';
import { ENDPOINTS, type EndpointDefinition } from '@abos/contracts';
import type { Db } from '../db/index';
import type { Env } from '../env';
import { AppError } from '../errors';

export interface TokenVerifier {
  verify(token: string): Promise<{ authUserId: string }>;
}

export function createVerifier(env: Env): TokenVerifier {
  const base = env.SUPABASE_URL?.replace(/\/$/, '');
  const keys = base ? createRemoteJWKSet(new URL(`${base}/auth/v1/.well-known/jwks.json`)) : undefined;
  return {
    async verify(token) {
      if (!keys || !base) throw new AppError('INTEGRATION_UNAVAILABLE', 'Authentication is not configured.');
      const { payload } = await jwtVerify(token, keys, { issuer: `${base}/auth/v1`, audience: 'authenticated' });
      if (!payload.sub) throw new AppError('UNAUTHENTICATED', 'Invalid access token.');
      return { authUserId: payload.sub };
    },
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    ownerUserId: string;
    businessId: string | undefined;
  }
}

/**
 * Auth policy of a route, declared where the route is registered (route `config.auth`, set by
 * `withAuthPolicy` around a plugin). Review finding 8: every /api route is authenticated unless it
 * declares otherwise, whatever ENDPOINTS says about who wrote it.
 *   owner:   this guard authenticates the owner and scopes the business.
 *   builder: delegated to the builder plugin's own BuilderAuth seam (filled with createBuilderAuth
 *            below); guarding here too would bypass its fail-closed default when auth is unset.
 *   public:  no authentication (none is declared today).
 */
export type RouteAuthPolicy = 'owner' | 'builder' | 'public';
export const ROUTE_AUTH_POLICIES: readonly RouteAuthPolicy[] = ['owner', 'builder', 'public'];

/** Wraps a plugin so every route it registers carries `policy`, unless the route declared its own. */
export function withAuthPolicy<O extends FastifyPluginOptions>(policy: RouteAuthPolicy, plugin: FastifyPluginAsync<O>): FastifyPluginAsync<O> {
  return async (scope, options) => {
    scope.addHook('onRoute', (route) => {
      const config = (route.config ?? {}) as Record<string, unknown>;
      if (config.auth === undefined) route.config = { ...config, auth: policy } as typeof route.config;
    });
    await scope.register(plugin as FastifyPluginAsync<FastifyPluginOptions>, options);
  };
}

export function routeAuthPolicyOf(config: unknown): RouteAuthPolicy | undefined {
  const auth = (config as { auth?: unknown } | undefined)?.auth;
  return ROUTE_AUTH_POLICIES.includes(auth as RouteAuthPolicy) ? auth as RouteAuthPolicy : undefined;
}
export function routeAuthPolicy(request: FastifyRequest): RouteAuthPolicy | undefined {
  return routeAuthPolicyOf(request.routeOptions.config);
}

const definitions = Object.values(ENDPOINTS) as EndpointDefinition[];
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};

/**
 * Authenticates every /api route except those that declare `builder` or `public`. Routes outside
 * /api (health, provider webhooks with their own signatures, the phone socket) are not owner routes.
 */
export function createAuthGuard(db: Db, verifier: TokenVerifier) {
  return async (request: FastifyRequest): Promise<void> => {
    const url = request.routeOptions.url;
    if (typeof url !== 'string' || !(url === '/api' || url.startsWith('/api/'))) return;
    const policy = routeAuthPolicy(request);
    if (policy === 'builder' || policy === 'public') return;
    // Fastify also registers HEAD handlers for GET routes.
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    const endpoint = definitions.find((e) => e.method === method && e.path === url);
    const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? '');
    if (!bearer?.[1]) throw new AppError('UNAUTHENTICATED', 'A bearer access token is required.');
    let authUserId: string;
    try { ({ authUserId } = await verifier.verify(bearer[1])); }
    catch (error) {
      if (error instanceof AppError && error.code === 'INTEGRATION_UNAVAILABLE') throw error;
      throw new AppError('UNAUTHENTICATED', 'Invalid access token.');
    }
    const user = record((await db.query('select id from public.users where auth_user_id = $1', [authUserId])).rows[0]);
    if (typeof user.id !== 'string') throw new AppError('UNAUTHENTICATED', 'Owner profile was not found.');
    request.ownerUserId = user.id;
    const params = record(request.params);
    const query = record(request.query);
    const businessId = url.startsWith('/api/businesses/:id') ? params.id : query.businessId;
    if (typeof businessId === 'string') {
      const owned = await db.query('select id from public.businesses where id = $1 and owner_id = $2', [businessId, user.id]);
      if (!owned.rows.length) throw new AppError('FORBIDDEN_BUSINESS', 'This business is not owned by you.');
      request.businessId = businessId;
    }
  };
}

/** The authenticated owner for a bearer token, or null when the token is absent, invalid or has no owner profile. */
export async function ownerForRequest(db: Db, verifier: TokenVerifier, request: FastifyRequest): Promise<string | null> {
  const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? '');
  if (!bearer?.[1]) return null;
  let authUserId: string;
  try { ({ authUserId } = await verifier.verify(bearer[1])); }
  catch (error) {
    if (error instanceof AppError && error.code === 'INTEGRATION_UNAVAILABLE') throw error;
    return null;
  }
  const user = record((await db.query('select id from public.users where auth_user_id = $1', [authUserId])).rows[0]);
  return typeof user.id === 'string' ? user.id : null;
}

/**
 * The builder's BuilderAuth port (apps/server/src/builder/auth.ts) backed by the same Supabase JWT
 * verification and owner lookup as every other route. Structural type, so this file imports nothing
 * from the builder directory.
 */
export function createBuilderAuth(db: Db, verifier: TokenVerifier) {
  return {
    verified: true as const,
    async authenticate(request: FastifyRequest): Promise<{ userId: string } | null> {
      const userId = await ownerForRequest(db, verifier, request);
      return userId ? { userId } : null;
    },
    async ownsBusiness(owner: { userId: string }, businessId: string): Promise<boolean> {
      const owned = await db.query('select 1 from public.businesses where id = $1 and owner_id = $2', [businessId, owner.userId]);
      return owned.rows.length > 0;
    },
  };
}
