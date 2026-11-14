// Human fallback (B-28) wired to the database and Twilio.
//
// Lead's ruling: a call may be handed to a person only when (1) the fallback number is a verified
// business fact (contact/fallback_phone_number), (2) the published agent version pinned to the call
// enables human fallback, and (3) the call is bound to an active phone call record of that business.
// Anything else fails closed.
//
// INTEGRATION GAPS (B-28 NOTES):
// - No checked routine exists for `fallback.reserve`, `fallback.begin_dispatch` or `outcomes.record`
//   (migrations are frozen after 0005). The checks here are reads in one transaction; the reservation
//   and the dispatch marker are per process, keyed by the provider call SID.
// - AgentSpec has no field that enables human fallback, so condition (2) is a port,
//   `versionEnablesFallback`, which is false unless the composition is given one. Until a contract
//   change adds that field, fallback is refused for every published version.
import { BusinessFactSchema, E164Schema, canonicalJson, sha256Hex } from '@abos/contracts';
import { mapRow } from '../api/rows';
import type { Db, QueryDb } from '../db/index';
import { emitActivity } from '../policy/activity';
import { createFallbackRouter, FALLBACK_NUMBER_FACT_KEY, type FallbackPorts, type FallbackReservation } from '../voice/fallback/index';
import type { RelayFallback } from '../voice/relay';
import type { Providers } from './providers';

type Row = Record<string, unknown>;
const one = async (q: QueryDb, text: string, params: unknown[]) => (await q.query(text, params)).rows[0] as Row | undefined;

export type FallbackDeps = {
  db: Db;
  providers: Providers;
  /** The Twilio number this account owns, used as caller ID on the forwarded leg. */
  ownedNumber?: string | undefined;
  /** Condition (2). Default: no published version enables fallback (no contract field yet). */
  versionEnablesFallback?: (input: { businessId: string; agentVersionId: string }) => Promise<boolean>;
  newId(prefix: string): string;
};

export function createDbFallback(deps: FallbackDeps) {
  const { db } = deps;
  const enables = deps.versionEnablesFallback ?? (async () => false);
  const reservations = new Map<string, FallbackReservation>();
  const dispatched = new Set<string>();

  const ports: FallbackPorts = {
    callerId: {
      async readOwnedNumber(_businessId, signal) {
        if (signal.aborted || !deps.ownedNumber || !E164Schema.safeParse(deps.ownedNumber).success) return null;
        return { number: deps.ownedNumber, accountOwned: true };
      },
    },
    fallback: {
      async reserve(input, signal) {
        if (signal.aborted) return null;
        const prior = reservations.get(input.providerCallId);
        if (prior) return prior.callId === input.callId && prior.businessId === input.businessId ? prior : null;
        return db.transaction(async (tx) => {
          // (3) the active phone call record of this business, bound to this provider call.
          const call = await one(tx, `select c.id, c.business_id, c.agent_version_id, c.status, c.channel, c.provider_call_id, b.name as business_name
            from public.calls c join public.businesses b on b.id = c.business_id where c.id = $1 and c.business_id = $2 for update of c`, [input.callId, input.businessId]);
          if (!call || call.status !== 'IN_PROGRESS' || call.channel !== 'phone' || call.provider_call_id !== input.providerCallId) return null;
          // (2) the published version pinned to the call enables fallback.
          const version = await one(tx, "select v.id from public.agent_versions v where v.id = $1 and v.business_id = $2", [call.agent_version_id, input.businessId]);
          if (!version || !(await enables({ businessId: input.businessId, agentVersionId: String(call.agent_version_id) }))) return null;
          // (1) one verified fallback number fact.
          const fact = await one(tx, `select * from public.business_facts where business_id = $1 and kind = 'contact' and key = $2 and status = 'verified' and verified_at is not null`,
            [input.businessId, FALLBACK_NUMBER_FACT_KEY]);
          const parsed = fact ? BusinessFactSchema.safeParse(mapRow(fact)) : undefined;
          if (!parsed?.success || !E164Schema.safeParse(parsed.data.value).success) return null;
          if (signal.aborted) return null;
          const idempotencyKey = await sha256Hex(canonicalJson({ businessId: input.businessId, providerCallId: input.providerCallId, operation: 'voice.fallback' }));
          const reservation: FallbackReservation = {
            businessId: input.businessId, callId: input.callId, providerCallId: input.providerCallId, businessName: String(call.business_name),
            callStatus: 'IN_PROGRESS', channel: 'phone', humanFallbackEnabled: true, fallbackFact: parsed.data, idempotencyKey,
          };
          reservations.set(input.providerCallId, reservation);
          return reservation;
        });
      },
      async beginDispatch(instruction, signal) {
        if (signal.aborted || dispatched.has(instruction.idempotencyKey)) return false;
        const reservation = reservations.get(instruction.providerCallId);
        if (!reservation || reservation.idempotencyKey !== instruction.idempotencyKey) return false;
        const call = await one(db, 'select status from public.calls where id = $1 and business_id = $2', [reservation.callId, reservation.businessId]);
        if (call?.status !== 'IN_PROGRESS') return false;
        dispatched.add(instruction.idempotencyKey);
        return true;
      },
    },
    calls: {
      async update(instruction, signal) {
        if (!deps.providers.twilioCalls) throw new Error('Twilio calls are not configured');
        await deps.providers.twilioCalls.update({ callSid: instruction.providerCallId, twiml: instruction.twiml, signal });
      },
    },
    outcomes: {
      async record(outcome) {
        // The same conditional terminal write every end path uses: only the first end wins.
        await db.transaction(async (tx) => {
          const ended = await one(tx, `update public.calls set status = $2, end_reason = $3, ended_at = greatest($4::timestamptz, started_at)
            where id = $1 and business_id = $5 and status = 'IN_PROGRESS' returning id`, [outcome.callId, outcome.status, outcome.reason, outcome.occurredAt, outcome.businessId]);
          if (ended) await emitActivity(tx, { ...outcome.event, id: deps.newId('evt_') });
        });
      },
    },
  };

  const router = createFallbackRouter(ports);
  /** The relay's hook: a stream redirect, or a redirect whose result is unknown, counts as handed off. */
  const relay: RelayFallback = async ({ businessId, callId, providerCallId, signals }) => {
    const r = await router.route({ businessId, callId, providerCallId, businessName: '', mode: 'stream', signals });
    return r.kind === 'redirect' || r.kind === 'redirect_unknown';
  };
  return { router, ports, relay };
}
