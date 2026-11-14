import { LiveAgentSchema, type LiveAgent } from '@abos/contracts';
import type { Db } from '../db/index';
import { AppError } from '../errors';
import { mapRow } from './rows';

export interface SetLiveAgentInput {
  agentId: string;
  ownerUserId: string;
  phoneNumber: string;
  correlationId: string;
}

/** Builder publish can call this after publishing, or within its existing transaction adapter. */
export async function setLiveAgent(db: Db, input: SetLiveAgentInput): Promise<LiveAgent> {
  return db.transaction(async (tx) => {
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [input.phoneNumber]);
    const raw = (await tx.query(`select a.* from public.agents a join public.businesses b on b.id = a.business_id
      where a.id = $1 and b.owner_id = $2 for update of a`, [input.agentId, input.ownerUserId])).rows[0];
    if (!raw) throw new AppError('NOT_FOUND', 'Agent was not found.');
    const agent = mapRow(raw);
    if (agent.state !== 'live' || typeof agent.activeVersionId !== 'string') {
      throw new AppError('INVALID_STATE', 'Agent must have a live published version.');
    }
    const oldRaw = (await tx.query(`select l.*, b.owner_id from public.live_agent l
      join public.businesses b on b.id = l.business_id where l.phone_number = $1`, [input.phoneNumber])).rows[0];
    const old = oldRaw ? mapRow(oldRaw) : undefined;
    if (old && old.ownerId !== input.ownerUserId) throw new AppError('FORBIDDEN_BUSINESS', 'This phone number belongs to another owner.');
    const result = await tx.query(`insert into public.live_agent (phone_number, business_id, agent_id, agent_version_id)
      values ($1, $2, $3, $4) on conflict (phone_number) do update
      set business_id = excluded.business_id, agent_id = excluded.agent_id, agent_version_id = excluded.agent_version_id, updated_at = now()
      returning *`, [input.phoneNumber, agent.businessId, input.agentId, agent.activeVersionId]);
    const live = LiveAgentSchema.parse(mapRow(result.rows[0]));
    await tx.query(`insert into public.activity_events (business_id, type, agent_id, correlation_id, actor_type, payload)
      values ($1, 'live_agent.changed', $2, $3, 'owner', $4::jsonb)`, [agent.businessId, input.agentId, input.correlationId,
      JSON.stringify({ phoneNumberLast4: input.phoneNumber.slice(-4), agentId: input.agentId,
        agentVersionId: agent.activeVersionId, ...(old ? { previousAgentId: old.agentId } : {}) })]);
    return live;
  });
}
