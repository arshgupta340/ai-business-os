import { FactConflictSchema, type FactConflict } from '@abos/contracts';
import type { Db } from '../db/index';
import { AppError } from '../errors';
import { emitActivity } from '../policy/activity';
import { mapRow } from './rows';

/**
 * "Keep the current value" on a fact conflict stored in the database (API.md 3.12, resolution
 * keep_authoritative). Nothing external is written and no fact version is created, so no approval is
 * needed: the owner's request is the confirmation. abos_app may update fact_conflicts directly (0004
 * grants; no guard trigger), so this is one conditional update scoped to the conflict's id, business,
 * kind and key while it is open. When a verified fact holds the kept value, fact.changed is written
 * with resolvedConflictId and fromVersion = toVersion. A menu_item conflict keeps the Square price,
 * which has no business_facts row, so it writes no fact.changed (the event needs a factId).
 */
export async function resolveConflictKeepCurrent(db: Db, input: { conflictId: string; businessId: string; ownerUserId: string; newId(prefix: string): string }): Promise<FactConflict> {
  return db.transaction(async (tx) => {
    const conflict = (await tx.query('select id, kind, key, state from public.fact_conflicts where id = $1 and business_id = $2 for update',
      [input.conflictId, input.businessId])).rows[0] as { id: string; kind: string; key: string; state: string } | undefined;
    if (!conflict) throw new AppError('NOT_FOUND', 'Conflict not found.');
    if (conflict.state !== 'open') throw new AppError('INVALID_STATE', 'Conflict is already resolved.');
    const owner = (await tx.query('select 1 from public.businesses where id = $1 and owner_id = $2', [input.businessId, input.ownerUserId])).rows[0];
    if (!owner) throw new AppError('NOT_FOUND', 'Conflict not found.');
    const fact = conflict.kind === 'menu_item' ? undefined : (await tx.query(
      "select id, kind, key, version, source_type from public.business_facts where business_id = $1 and kind = $2 and key = $3 and status = 'verified'",
      [input.businessId, conflict.kind, conflict.key])).rows[0] as { id: string; kind: string; key: string; version: number | string; source_type: string } | undefined;
    const updated = (await tx.query(`update public.fact_conflicts set state = 'resolved', resolved_by = $5, resolved_at = pg_catalog.clock_timestamp(), resolved_fact_id = $6
      where id = $1 and business_id = $2 and kind = $3 and key = $4 and state = 'open' returning *`,
    [conflict.id, input.businessId, conflict.kind, conflict.key, input.ownerUserId, fact?.id ?? null])).rows[0];
    if (!updated) throw new AppError('INVALID_STATE', 'Conflict is already resolved.');
    if (fact) {
      const version = Number(fact.version);
      await emitActivity(tx, { id: input.newId('evt_'), businessId: input.businessId, correlationId: conflict.id, type: 'fact.changed', actorType: 'owner',
        occurredAt: new Date().toISOString(),
        payload: { resolvedConflictId: conflict.id, factId: fact.id, kind: fact.kind, key: fact.key, fromVersion: version, toVersion: version, sourceType: fact.source_type } });
    }
    return FactConflictSchema.parse(mapRow(updated));
  });
}
