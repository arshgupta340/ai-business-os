import type { BusinessFact, BusinessSummary } from '@abos/contracts';
import { allFacts, businesses, pizzaCatalog } from '@abos/contracts/fixtures';

// What the builder reads about a business before it computes missing fields
// (FLOWS.md step A6): the profile, verified facts, the catalog cache and open
// conflicts. Read only. The fixture version reads the shared fixtures in
// `@abos/contracts/fixtures`; the database version (task B-06) will read
// businesses, business_facts, catalog_items and fact_conflicts.

// The business list item (BusinessSummary). The timezone is optional here so
// a business without one raises the `missing_timezone` stop condition.
export type BusinessProfile = Omit<BusinessSummary, 'timezone'> & Partial<Pick<BusinessSummary, 'timezone'>>;

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
    const business = businesses.find((b) => b.id === businessId);
    if (!business) return undefined;
    const { id, name, category, timezone } = business;
    return {
      profile: { id, name, category, timezone },
      verifiedFacts: allFacts.filter((f) => f.businessId === businessId && f.status === 'verified').map((f) => structuredClone(f)),
      catalogItemCount: pizzaCatalog.filter((c) => c.businessId === businessId).length,
      // The fixture conflict (cfl_pizza_01) belongs to the fixture upload, which
      // this server has not received. Open conflicts come from the extraction
      // store through `withConflicts` (extraction/conflicts.ts).
      openRequiredConflictIds: [],
    };
  }
}
