import { BUSINESSES, PIZZA_CATALOG, SEED_FACTS, type BusinessProfile } from '../fixtures';
import type { BusinessFact } from '../pending-contracts';

// What the builder reads about a business before it computes missing fields
// (FLOWS.md step A6): the profile, verified facts, the catalog cache and open
// conflicts. Read only. The in-memory version reads the temporary fixtures;
// the database version reads businesses, business_facts, catalog_items and
// fact_conflicts.

export interface BusinessContext {
  profile: BusinessProfile;
  verifiedFacts: BusinessFact[];
  catalogItemCount: number;
  openRequiredConflictIds: string[];
}

export interface BusinessKnowledge {
  getContext(businessId: string): Promise<BusinessContext | undefined>;
}

export class FixtureBusinessKnowledge implements BusinessKnowledge {
  async getContext(businessId: string): Promise<BusinessContext | undefined> {
    const profile = BUSINESSES.find((b) => b.id === businessId);
    if (!profile) return undefined;
    return {
      profile: { ...profile },
      verifiedFacts: SEED_FACTS.filter((f) => f.businessId === businessId && f.status === 'verified').map((f) => structuredClone(f)),
      catalogItemCount: PIZZA_CATALOG.filter((c) => c.businessId === businessId).length,
      openRequiredConflictIds: [],
    };
  }
}
