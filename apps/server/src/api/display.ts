// Display fields added by issue #108: `decidedByName` on an approval, and `itemName` and
// `variationName` on a price edit. They are read when an approval is served. Nothing here is stored
// on the approval, nothing is added to `payload`, and no hash covers them.
import type { QueryDb } from '../db/index';

type Row = Record<string, unknown>;

/** A name worth showing: trimmed, or absent when the column is null or blank. */
function shown(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Display names for user IDs, limited to the owner of `businessId`. The decision routine sets
 * `decided_by` to the business owner, so this names every decider and can never return the name of
 * a user who has no part in this business.
 */
export async function ownerDisplayNames(db: QueryDb, businessId: string, userIds: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return names;
  const rows = (await db.query(`select u.id, u.display_name from public.users u
    join public.businesses b on b.owner_id = u.id
    where b.id = $1 and u.id = any($2::text[])`, [businessId, ids])).rows as Row[];
  for (const r of rows) {
    const name = shown(r.display_name);
    if (name) names.set(String(r.id), name);
  }
  return names;
}

/**
 * Adds the display fields to approvals of one business (already mapped to contract keys).
 * `decidedByName` is added when the approval has a decider with a display name. A `price_edit` gets
 * the names of the catalog cache row in its `subjectId`, as they are now: the row stays in the cache
 * when the item leaves Square, but a renamed item shows its new name.
 */
export async function withApprovalDisplayFields<T extends Row>(db: QueryDb, businessId: string, approvals: readonly T[]): Promise<T[]> {
  const deciders = approvals.flatMap((a) => (typeof a.decidedBy === 'string' ? [a.decidedBy] : []));
  const catalogRowIds = [...new Set(approvals.flatMap((a) => (a.bundleType === 'price_edit' && typeof a.subjectId === 'string' ? [a.subjectId] : [])))];
  const names = await ownerDisplayNames(db, businessId, deciders);
  const catalog = new Map<string, { itemName?: string; variationName?: string }>();
  if (catalogRowIds.length > 0) {
    const rows = (await db.query('select id, item_name, variation_name from public.catalog_items where business_id = $1 and id = any($2::text[])',
      [businessId, catalogRowIds])).rows as Row[];
    for (const r of rows) {
      const itemName = shown(r.item_name);
      const variationName = shown(r.variation_name);
      catalog.set(String(r.id), { ...(itemName ? { itemName } : {}), ...(variationName ? { variationName } : {}) });
    }
  }
  return approvals.map((a) => {
    const decidedByName = typeof a.decidedBy === 'string' ? names.get(a.decidedBy) : undefined;
    const item = a.bundleType === 'price_edit' && typeof a.subjectId === 'string' ? catalog.get(a.subjectId) : undefined;
    return { ...a, ...(decidedByName ? { decidedByName } : {}), ...(item ?? {}) };
  });
}
