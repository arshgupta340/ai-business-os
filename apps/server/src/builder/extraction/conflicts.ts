import type { BusinessFact } from '../pending-contracts';
import type { BusinessKnowledge } from '../session/knowledge';
import { apiError, canonicalJson } from '../util';
import { normalizeName } from './sanitize';
import type { CatalogVariationRow, ConflictStore } from './stores';
import type { FactConflictCandidate } from './types';

// Conflict detection (DATA-MODEL.md section 5). A draft menu_item is compared
// with the catalog cache on normalized item and variation names; a price
// difference is a required conflict (AC-02). Any other draft is compared with
// the current verified fact of the same kind and key.

export interface DetectedConflict {
  required: boolean;
  authority: FactConflictCandidate;
}

// The catalog row a draft menu item names, or undefined when the names do
// not pick exactly one variation. Without a variation name, an item with a
// single variation still matches.
export function matchCatalogRow(draftValue: Record<string, unknown>, rows: CatalogVariationRow[]): CatalogVariationRow | undefined {
  const item = typeof draftValue.itemName === 'string' ? normalizeName(draftValue.itemName) : '';
  if (!item) return undefined;
  const sameItem = rows.filter((r) => normalizeName(r.itemName) === item);
  if (sameItem.length === 0) return undefined;
  const variation = typeof draftValue.variationName === 'string' ? normalizeName(draftValue.variationName) : '';
  if (!variation) return sameItem.length === 1 ? sameItem[0] : undefined;
  return sameItem.find((r) => normalizeName(r.variationName) === variation);
}

// True when a field the draft states differs from the same field of the
// verified value. Fields the verified value does not have cannot be compared.
// Hours compare whole values, since { closed: true } and { open, close } share
// no field.
function disagreesWith(kind: BusinessFact['kind'], draft: Record<string, unknown>, verified: unknown): string[] {
  if (kind === 'hours') return canonicalJson(draft) === canonicalJson(verified) ? [] : ['value'];
  if (!verified || typeof verified !== 'object') return [];
  const v = verified as Record<string, unknown>;
  const differing: string[] = [];
  for (const [field, value] of Object.entries(draft)) {
    if (!(field in v)) continue;
    const a = typeof value === 'string' ? normalizeName(value) : canonicalJson(value);
    const b = typeof v[field] === 'string' ? normalizeName(v[field] as string) : canonicalJson(v[field]);
    if (a !== b) differing.push(field);
  }
  return differing;
}

export function detectConflict(
  draft: Pick<BusinessFact, 'kind' | 'key' | 'value'>,
  context: { catalog: CatalogVariationRow[]; verifiedFacts: BusinessFact[] },
): DetectedConflict | undefined {
  const value = draft.value as Record<string, unknown>;
  if (draft.kind === 'menu_item') {
    const row = matchCatalogRow(value, context.catalog);
    if (!row || row.priceMinor === value.priceMinor) return undefined;
    return {
      required: true,
      authority: {
        sourceType: 'square',
        sourceRef: row.id,
        value: { itemName: row.itemName, variationName: row.variationName, priceMinor: row.priceMinor, currency: row.currency },
      },
    };
  }
  const verified = context.verifiedFacts.find((f) => f.status === 'verified' && f.kind === draft.kind && f.key === draft.key);
  if (!verified) return undefined;
  const differing = disagreesWith(draft.kind, value, verified.value);
  if (differing.length === 0) return undefined;
  return {
    // A price difference is required (CONTRACTS.md FactConflict.required).
    required: differing.includes('priceMinor'),
    authority: { factId: verified.id, sourceType: verified.sourceType, ...(verified.sourceRef ? { sourceRef: verified.sourceRef } : {}), value: verified.value },
  };
}

// Service facts from a document have no svc_ ID. When the draft's name equals
// a verified service's name, the draft takes that service's key so the two
// can be compared.
export function serviceKeyFor(draftValue: Record<string, unknown>, verifiedFacts: BusinessFact[]): string | undefined {
  const name = typeof draftValue.name === 'string' ? normalizeName(draftValue.name) : '';
  if (!name) return undefined;
  const hit = verifiedFacts.find(
    (f) => f.kind === 'service' && f.status === 'verified' && typeof (f.value as { name?: unknown })?.name === 'string' && normalizeName((f.value as { name: string }).name) === name,
  );
  return hit?.key;
}

// ---------------------------------------------------------------------------
// For publish (task B-17): does this business have an open required conflict?

export async function openRequiredConflictIds(conflicts: ConflictStore, businessId: string): Promise<string[]> {
  return (await conflicts.listOpen(businessId)).filter((c) => c.required).map((c) => c.id);
}

export async function hasOpenRequiredConflict(conflicts: ConflictStore, businessId: string): Promise<boolean> {
  return (await openRequiredConflictIds(conflicts, businessId)).length > 0;
}

// Throws CONFLICT_UNRESOLVED with details.conflictIds (API.md section 2).
export async function assertNoOpenRequiredConflict(conflicts: ConflictStore, businessId: string): Promise<void> {
  const conflictIds = await openRequiredConflictIds(conflicts, businessId);
  if (conflictIds.length > 0) {
    throw apiError('CONFLICT_UNRESOLVED', 'Resolve the open conflicts before publishing.', { conflictIds });
  }
}

// Wraps a BusinessKnowledge so that openRequiredConflictIds comes from the
// conflict store. The fixture knowledge always reports none. Not wired in
// index.ts by this task; see the report.
export function withConflicts(knowledge: BusinessKnowledge, conflicts: ConflictStore): BusinessKnowledge {
  return {
    async getContext(businessId) {
      const context = await knowledge.getContext(businessId);
      if (!context) return undefined;
      const fromStore = await openRequiredConflictIds(conflicts, businessId);
      return { ...context, openRequiredConflictIds: [...new Set([...context.openRequiredConflictIds, ...fromStore])] };
    },
  };
}
