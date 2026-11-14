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

const definitions = Object.values(ENDPOINTS) as EndpointDefinition[];
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};

/** This guard also protects contract routes registered by the builder plugin. */
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
