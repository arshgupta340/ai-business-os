// Owner decisions reach a live call (FLOWS 3.1, voice NOTES 5). The bus is per process: the decision
// endpoint and the expiry sweep publish after the routine committed, and the phone relay of that call
// subscribes by call ID. The relay ignores a decision whose proposal or approval ID does not match its
// own proposal. "Approved" never means paid or booked, and messageSent is always false: the deployed
// toolset proposes qr_only until consent evidence exists, so no message is claimed.
import type { QueryDb } from '../db/index';
import type { CallDecision, CallDecisionsPort } from '../voice/types';

export type CallDecisionsBus = CallDecisionsPort & {
  /** Publishes the decision on an order or booking approval to its call, read from the subject row. */
  publish(db: QueryDb, input: { businessId: string; approvalId: string; state: string }): Promise<void>;
};

export function createCallDecisions(): CallDecisionsBus {
  const listeners = new Map<string, Set<(d: CallDecision) => void>>();
  return {
    subscribe(callId, listener) {
      let set = listeners.get(callId);
      if (!set) { set = new Set(); listeners.set(callId, set); }
      set.add(listener);
      return () => { set.delete(listener); if (set.size === 0) listeners.delete(callId); };
    },
    async publish(db, { businessId, approvalId, state }) {
      const kind = state === 'APPROVED' ? 'approved' : state === 'REJECTED' ? 'rejected' : state === 'EXPIRED' ? 'expired' : undefined;
      if (!kind) return;
      const row = (await db.query(`select a.subject_id, coalesce(o.call_id, b.call_id) as call_id from public.approval_requests a
        left join public.orders o on o.id = a.subject_id and o.business_id = a.business_id and a.bundle_type = 'order_bundle'
        left join public.bookings b on b.id = a.subject_id and b.business_id = a.business_id and a.bundle_type = 'booking_bundle'
        where a.id = $1 and a.business_id = $2`, [approvalId, businessId])).rows[0] as { subject_id: string; call_id: string | null } | undefined;
      if (!row?.call_id) return;
      const decision: CallDecision = kind === 'approved'
        ? { kind, messageSent: false, proposalId: row.subject_id, approvalId }
        : { kind, proposalId: row.subject_id, approvalId };
      for (const listener of [...(listeners.get(row.call_id) ?? [])]) {
        try { listener(decision); } catch { /* one listener cannot stop the others */ }
      }
    },
  };
}
