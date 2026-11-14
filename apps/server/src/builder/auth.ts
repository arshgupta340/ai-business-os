import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
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
// "production". The real fix is a `BuilderAuth` passed to the plugin once B-08
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

export const SEED_OWNER_ID = 'usr_owner_01';
export const SEED_BUSINESS_IDS = ['biz_pizza_01', 'biz_barber_01'] as const;

export class UnverifiedSeedOwnerAuth implements BuilderAuth {
  readonly verified = false;

  async authenticate(request: FastifyRequest): Promise<Owner | null> {
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

const BusinessQuery = z.object({ businessId: z.string().regex(/^biz_[A-Za-z0-9_]{1,64}$/) });

export async function requireBusiness(auth: BuilderAuth, request: FastifyRequest): Promise<BusinessScope> {
  const owner = await auth.authenticate(request);
  if (!owner) throw apiError('UNAUTHENTICATED', 'Sign in to continue.');
  const { businessId } = parseOrThrow(BusinessQuery, request.query);
  if (!(await auth.ownsBusiness(owner, businessId))) {
    throw apiError('FORBIDDEN_BUSINESS', 'You do not have access to this business.');
  }
  return { owner, businessId };
}
