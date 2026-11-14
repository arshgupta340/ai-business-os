import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { FastifyRequest } from 'fastify';
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

// Builder routes (owner "saina", D-07) authenticate through the builder's own BuilderAuth seam,
// which the composition root fills with `createBuilderAuth` below. Guarding them here as well
// would bypass that seam and break the builder's fail-closed default when auth is not configured.
const definitions = (Object.values(ENDPOINTS) as EndpointDefinition[]).filter((e) => e.owner !== 'saina');
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};

/** Authenticates every contract route Arsh owns. Builder routes use `createBuilderAuth`. */
export function createAuthGuard(db: Db, verifier: TokenVerifier) {
  return async (request: FastifyRequest): Promise<void> => {
    // Fastify also registers HEAD handlers for GET routes.
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    const endpoint = definitions.find((e) => e.method === method && e.path === request.routeOptions.url);
    if (!endpoint) return;
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
    const businessId = endpoint.path.startsWith('/api/businesses/:id') ? params.id : query.businessId;
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
