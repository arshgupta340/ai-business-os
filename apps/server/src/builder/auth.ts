import { BARBER_BUSINESS_ID, BusinessScopeQuerySchema, PIZZA_BUSINESS_ID } from '@abos/contracts';
import { OWNER_USER_ID } from '@abos/contracts/fixtures';
import type { FastifyRequest } from 'fastify';
import { apiError, parseOrThrow } from './util';

// The one auth and business-scope seam for every builder route (API.md section 1).
//
// What a route needs: who the owner is, and proof that the owner owns the
// `businessId` in the query. Every builder route calls `requireBusiness` first
// and passes the result on. Resource lookups then check that the resource
// belongs to that business and answer NOT_FOUND if not.
//
// TODAY (auth task B-08 has not landed) the builder fails closed. With no
// `auth` option passed to the plugin, the default is `NotConfiguredAuth`:
// every route that needs an owner answers UNAUTHENTICATED with the message
// "Builder auth is not configured.", whatever header is sent.
//
// For local development only, `BUILDER_DEV_AUTH=1` opts in to
// `UnverifiedSeedOwnerAuth`. It does NOT verify the Supabase JWT: any
// `Authorization: Bearer <something>` header is treated as the one seeded
// owner (P-14), who owns the two seeded businesses. That is not security. The
// plugin logs a warning naming the variable while it is in use, and refuses
// the opt-in (logs an error, stays not configured) when NODE_ENV is
// "production".
//
// The server listens on all interfaces, so the stand-in also refuses every
// request that does not come from the loopback address (127.0.0.1, ::1 or
// ::ffff:127.0.0.1). It reads the socket's own remote address. It never reads
// X-Forwarded-For or any other header, because a client can set those. The real fix is a `BuilderAuth` passed to the plugin once B-08
// provides JWT verification and owner lookup.

export interface Owner {
  userId: string; // usr_
}

export interface BuilderAuth {
  // Returns the owner, or null when the request carries no valid credentials.
  authenticate(request: FastifyRequest): Promise<Owner | null>;
  ownsBusiness(owner: Owner, businessId: string): Promise<boolean>;
  readonly verified: boolean;
}

export const SEED_OWNER_ID = OWNER_USER_ID;
export const SEED_BUSINESS_IDS = [PIZZA_BUSINESS_ID, BARBER_BUSINESS_ID] as const;

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// True only for a loopback socket address. An absent address is not loopback.
export function isLoopbackAddress(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_ADDRESSES.has(address);
}

export class UnverifiedSeedOwnerAuth implements BuilderAuth {
  readonly verified = false;

  async authenticate(request: FastifyRequest): Promise<Owner | null> {
    // The TCP peer, not request.ip: request.ip would follow X-Forwarded-For if
    // trustProxy were ever turned on for the app.
    if (!isLoopbackAddress(request.raw.socket?.remoteAddress)) {
      throw apiError('UNAUTHENTICATED', 'Development auth accepts requests from this machine only.');
    }
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !/^Bearer\s+\S+/.test(header)) return null;
    return { userId: SEED_OWNER_ID };
  }

  async ownsBusiness(owner: Owner, businessId: string): Promise<boolean> {
    return owner.userId === SEED_OWNER_ID && (SEED_BUSINESS_IDS as readonly string[]).includes(businessId);
  }
}

// The default when no real auth is passed and the dev opt-in is off or refused.
export class NotConfiguredAuth implements BuilderAuth {
  readonly verified = false;

  async authenticate(): Promise<Owner | null> {
    throw apiError('UNAUTHENTICATED', 'Builder auth is not configured.');
  }

  async ownsBusiness(): Promise<boolean> {
    return false;
  }
}

export interface BusinessScope {
  owner: Owner;
  businessId: string;
}


export async function requireBusiness(auth: BuilderAuth, request: FastifyRequest): Promise<BusinessScope> {
  const owner = await auth.authenticate(request);
  if (!owner) throw apiError('UNAUTHENTICATED', 'Sign in to continue.');
  const { businessId } = parseOrThrow(BusinessScopeQuerySchema, request.query);
  if (!(await auth.ownsBusiness(owner, businessId))) {
    throw apiError('FORBIDDEN_BUSINESS', 'You do not have access to this business.');
  }
  return { owner, businessId };
}
