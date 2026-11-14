// Metrics derived from activity events the system already writes (task B-30). Pure functions.
//
// What the events support (read from packages/contracts/src/events.ts):
// - approval_time: yes. `approval.requested` and `approval.decided` both carry `approvalId` in
//   the payload, and each event has `occurredAt`. The duration is decided minus requested.
//   Matching is by `approvalId`, not by `correlationId`: the correlation id is the call id, and
//   one call can carry more than one approval, so it is not a unique key.
// - webhook_delay: no. A webhook delay is the time from the provider creating its event to this
//   server receiving it. No activity event carries the provider's event time or the server's
//   receipt time. `checkout.created` to `payment.verified` is the customer's time to pay, not a
//   webhook delay, so it is deliberately not reported under this name. The webhook handler must
//   record webhook_delay explicitly (see NOTES.md).
// - call_answer_latency, first_audio, tool_latency: no. `call.started` is written when the call
//   row is created; no event marks the answer, the first audio frame or a tool call's end.
import type { ActivityEvent, ActivityEventOf, TelemetryMetricName } from '@abos/contracts';

export interface DerivedSample {
  metric: TelemetryMetricName;
  businessId: string;
  /** Duration in milliseconds. */
  ms: number;
  /** ISO time the measured thing completed. `since` filtering uses this. */
  at: string;
  correlationId: string;
  approvalId: string;
}

export interface ApprovalTimeResult {
  samples: DerivedSample[];
  /** Requests that expired without a decision. They have no approval time and are not counted as one. */
  expired: number;
  /** Requests with no decision or expiry yet in the given events. */
  pending: number;
  /** Decisions with no matching request in the given events, or with a decision before the request. */
  unmatched: number;
}

/** Event types the approval deriver reads. An event source can use this to narrow its query. */
export const APPROVAL_TIME_EVENT_TYPES = ['approval.requested', 'approval.decided', 'approval.expired'] as const;

/** Metrics this module can derive from existing events. */
export const DERIVABLE_METRICS: readonly TelemetryMetricName[] = ['approval_time'];

/** Metrics that need an explicit `record` call, and why they cannot be derived. */
export const DERIVATION_GAPS: Readonly<Record<Exclude<TelemetryMetricName, 'approval_time'>, string>> = {
  webhook_delay: 'No event carries the provider event time or the server receipt time.',
  call_answer_latency: 'No event marks the moment the call is answered.',
  first_audio: 'No event marks the first agent audio sent to the caller.',
  tool_latency: 'No event marks the start and end of a deployed agent tool call.',
};

/**
 * Approval time per approval for one business: from `approval.requested` to the matching
 * `approval.decided`, in milliseconds. Events from other businesses are ignored. If a request
 * appears more than once (a replay), the first one counts; if a decision appears more than once,
 * the first one counts.
 */
export function deriveApprovalTimes(events: readonly ActivityEvent[], businessId: string): ApprovalTimeResult {
  const ordered = events
    .filter((e) => e.businessId === businessId)
    .map((e, index) => ({ e, index, t: Date.parse(e.occurredAt) }))
    .filter((x) => !Number.isNaN(x.t))
    .sort((a, b) => a.t - b.t || a.index - b.index);

  const requested = new Map<string, ActivityEventOf<'approval.requested'>>();
  const closed = new Set<string>();
  const samples: DerivedSample[] = [];
  let expired = 0;
  let unmatched = 0;

  for (const { e } of ordered) {
    if (e.type === 'approval.requested') {
      if (!requested.has(e.payload.approvalId)) requested.set(e.payload.approvalId, e);
    } else if (e.type === 'approval.decided') {
      const id = e.payload.approvalId;
      if (closed.has(id)) continue;
      const request = requested.get(id);
      const ms = request === undefined ? NaN : Date.parse(e.occurredAt) - Date.parse(request.occurredAt);
      if (request === undefined || !(ms >= 0)) {
        unmatched += 1;
        continue;
      }
      closed.add(id);
      samples.push({ metric: 'approval_time', businessId, ms, at: e.occurredAt, correlationId: request.correlationId, approvalId: id });
    } else if (e.type === 'approval.expired') {
      const id = e.payload.approvalId;
      if (closed.has(id) || !requested.has(id)) continue;
      closed.add(id);
      expired += 1;
    }
  }

  let pending = 0;
  for (const id of requested.keys()) if (!closed.has(id)) pending += 1;
  return { samples, expired, pending, unmatched };
}
