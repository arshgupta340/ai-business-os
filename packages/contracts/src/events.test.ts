import { describe, expect, it } from 'vitest';
import { ACTIVITY_EVENT_TYPES, ActivityEventSchema, activityEventFromRow, type ActivityEventType } from './index';

const env = { businessId: 'biz_pizza_01', correlationId: 'call_p01', actorType: 'system', occurredAt: '2026-11-14T19:00:00Z' } as const;

const SAMPLES: Record<ActivityEventType, Record<string, unknown>> = {
  'call.started': { callId: 'call_p01', agentId: 'agt_pizza_01', agentVersionId: 'agv_pizza_01_v1', channel: 'test_console' },
  'call.ended': { callId: 'call_p01', status: 'DROPPED', reason: 'dropped', durationSec: 12 },
  'proposal.created': { subjectId: 'ord_p01', subjectType: 'order', callId: 'call_p01', totalMinor: 4731, currency: 'USD' },
  'approval.requested': { approvalId: 'apv_p01', bundleType: 'fact_edit', subjectId: 'fact_1', actionBundle: ['local.fact.update'], expiresAt: '2026-11-14T19:10:00Z' },
  'approval.decided': { approvalId: 'apv_p01', subjectId: 'ord_p01', decision: 'REJECTED', decidedBy: 'usr_owner_01' },
  'approval.expired': { approvalId: 'apv_p01', subjectId: 'ord_p01' },
  'execution.started': { executionId: 'exe_1', approvalId: 'apv_p01', actionType: 'square.checkout.create', stepIndex: 0, attempt: 1 },
  'execution.succeeded': { executionId: 'exe_1', actionType: 'square.checkout.create', externalRef: 'SQ_LINK_1' },
  'execution.failed': { executionId: 'exe_1', actionType: 'calendar.event.create', errorCode: 'SLOT_CONFLICT', retryable: false, nextStatus: 'FAILED' },
  'checkout.created': { orderId: 'ord_p01', squareOrderId: 'SQ_ORDER_1', squarePaymentLinkId: 'SQ_LINK_1', totalMinor: 4731, currency: 'USD', sandbox: true },
  'message.sent': { dispatchId: 'msg_p01', subjectId: 'ord_p01', channel: 'android_gateway', template: 'checkout_link', recipientLast4: '0123' },
  'message.failed': { dispatchId: 'msg_p01', subjectId: 'ord_p01', channel: 'surge', status: 'UNKNOWN' },
  'payment.verified': { orderId: 'ord_p01', squarePaymentId: 'SQ_PAY_1', amountMinor: 4731, currency: 'USD', sandbox: true },
  'payment.failed': { orderId: 'ord_p01', reason: 'card_declined', sandbox: true },
  'booking.verified': { bookingId: 'bkg_b01', googleEventId: 'abc123', serviceName: 'Haircut', startUtc: '2026-11-15T18:00:00Z', timezone: 'America/Los_Angeles' },
  'booking.slot_conflict': { bookingId: 'bkg_b01', approvalId: 'apv_b01', startUtc: '2026-11-15T18:00:00Z', alternatives: [{ startUtc: '2026-11-15T18:30:00Z', endUtc: '2026-11-15T19:00:00Z' }] },
  'order.status_changed': { callId: 'call_p01', from: 'COLLECTING', to: 'VALIDATING' },
  'booking.status_changed': { bookingId: 'bkg_b01', callId: 'call_b01', from: 'AWAITING_OWNER_APPROVAL', to: 'RECHECKING_SLOT' },
  'sync.queued': { target: 'google_sheets', syncJobId: 'syn_1', recordType: 'order', recordId: 'ord_p01' },
  'sync.succeeded': { target: 'catalog', jobId: 'job_cat_01' },
  'sync.failed': { target: 'google_sheets', syncJobId: 'syn_1', recordType: 'booking', recordId: 'bkg_b01', attempts: 5, final: true },
  'fact.changed': { factId: 'fact_hours_fri_d2', kind: 'hours', key: 'fri', fromVersion: 1, toVersion: 2, sourceType: 'owner_ui' },
  'extraction.completed': { fileId: 'file_menu_01', mime: 'application/pdf', extractionState: 'EXTRACTED', draftFactCount: 4, conflictCount: 1 },
  'agent.published': { agentId: 'agt_pizza_01', agentVersionId: 'agv_pizza_01_v1', version: 1, rolledBackFrom: 'agv_pizza_01_v2' },
  'agent.paused': { agentId: 'agt_pizza_01' },
  'live_agent.changed': { phoneNumberLast4: '0199', agentId: 'agt_barber_01', agentVersionId: 'agv_barber_01_v1', previousAgentId: 'agt_pizza_01' },
  'guardrail.refused': { callId: 'call_p01', rule: 'no_approval_bypass', reasonCode: 'approval_missing' },
  'webhook.rejected': { provider: 'square', reason: 'signature_invalid' },
};

describe('activity events', () => {
  it('the type list is exactly SPEC 2.5', () => {
    expect([...ACTIVITY_EVENT_TYPES]).toEqual([
      'call.started', 'call.ended', 'proposal.created', 'approval.requested', 'approval.decided', 'approval.expired',
      'execution.started', 'execution.succeeded', 'execution.failed', 'checkout.created', 'message.sent', 'message.failed',
      'payment.verified', 'payment.failed', 'booking.verified', 'booking.slot_conflict', 'order.status_changed',
      'booking.status_changed', 'sync.queued', 'sync.succeeded', 'sync.failed', 'fact.changed', 'extraction.completed',
      'agent.published', 'agent.paused', 'live_agent.changed', 'guardrail.refused', 'webhook.rejected',
    ]);
  });

  it.each(ACTIVITY_EVENT_TYPES)('%s: a valid sample parses', (type) => {
    const r = ActivityEventSchema.safeParse({ id: 'evt_1', type, ...env, payload: SAMPLES[type] });
    expect(r.success, JSON.stringify(r.error)).toBe(true);
  });

  it.each(ACTIVITY_EVENT_TYPES)('%s: the payload of another type fails', (type) => {
    // Pair each type with a payload that lacks its required fields.
    const wrong = type === 'agent.paused' ? SAMPLES['webhook.rejected'] : SAMPLES['agent.paused'];
    expect(ActivityEventSchema.safeParse({ id: 'evt_1', type, ...env, payload: wrong }).success).toBe(false);
  });

  it('refuses sandbox false, a full phone number, a sheets sync without its record fields', () => {
    expect(ActivityEventSchema.safeParse({ id: 'evt_1', type: 'payment.verified', ...env, payload: { ...SAMPLES['payment.verified'], sandbox: false } }).success).toBe(false);
    expect(ActivityEventSchema.safeParse({ id: 'evt_1', type: 'message.sent', ...env, payload: { ...SAMPLES['message.sent'], recipientLast4: '+15555550123' } }).success).toBe(false);
    expect(ActivityEventSchema.safeParse({ id: 'evt_1', type: 'sync.queued', ...env, payload: { target: 'google_sheets', jobId: 'job_1' } }).success).toBe(false);
    expect(ActivityEventSchema.safeParse({ id: 'evt_1', type: 'booking.slot_conflict', ...env, payload: { ...SAMPLES['booking.slot_conflict'], alternatives: Array(4).fill({ startUtc: '2026-11-15T18:30:00Z', endUtc: '2026-11-15T19:00:00Z' }) } }).success).toBe(false);
  });

  it('maps a Supabase Realtime row', () => {
    const ev = activityEventFromRow({
      id: 'evt_9', business_id: 'biz_pizza_01', type: 'agent.paused', agent_id: null, correlation_id: 'apv_1',
      actor_type: 'owner', occurred_at: '2026-11-14 19:00:00+00', payload: { agentId: 'agt_pizza_01' },
    });
    expect(ev).toEqual({ id: 'evt_9', businessId: 'biz_pizza_01', type: 'agent.paused', correlationId: 'apv_1', actorType: 'owner', occurredAt: '2026-11-14T19:00:00.000Z', payload: { agentId: 'agt_pizza_01' } });
  });
});
