// Dashboard data: integration health, order checkout data (QR backup), telemetry and the activity list.
import {
  BARBER_BUSINESS_ID,
  PIZZA_BUSINESS_ID,
  type ActivityEvent,
  type IntegrationHealth,
  type OrderCheckout,
  type Page,
  type TelemetryResponse,
  type SyncJob,
} from '../src/index';
import { messageDispatches } from './executions';
import { menuFile, menuItemDraftFact } from './facts';
import { orderAwaitingApproval, orderFulfilled, orderPaid, orderPaymentPending } from './orders';
import { barberBookingTimeline, barberSlotConflictTimeline, pizzaOrderTimeline } from './timelines';

const CHECKED_AT = '2026-11-14T20:29:00Z';

/** Mostly connected; Google Calendar is slow. Square is always sandbox (AC-19). */
export const integrationHealth = {
  square: { state: 'connected', environment: 'sandbox', lastCheckedAt: CHECKED_AT, detail: 'Square sandbox' },
  twilio: { state: 'connected', lastCheckedAt: CHECKED_AT },
  openai: { state: 'connected', lastCheckedAt: CHECKED_AT },
  google_calendar: { state: 'degraded', detail: 'free/busy responses are slow', lastCheckedAt: CHECKED_AT },
  google_sheets: { state: 'connected', lastCheckedAt: CHECKED_AT },
  message_channel: { state: 'connected', channel: 'surge', detail: '18 of 25 demo messages left', lastCheckedAt: CHECKED_AT },
} satisfies IntegrationHealth;

export const integrationHealthDisconnected: IntegrationHealth = {
  ...integrationHealth, google_sheets: { state: 'disconnected', lastCheckedAt: CHECKED_AT, detail: 'Reconnect Google Sheets to resume sync' },
};
/**
 * The Sheets row of the paid order, still retrying. It was queued when the payment was verified
 * (`orderPaid.updatedAt`, FLOWS B28). In the default world Sheets is connected, so the last error is a
 * slow answer, not a disconnect (issue #103).
 */
export const syncJobRetrying: SyncJob = {
  id: 'syn_demo_88', businessId: PIZZA_BUSINESS_ID, target: 'google_sheets', recordType: 'order', recordId: orderPaid.id,
  state: 'RETRYING', attempts: 2, nextRetryAt: '2026-11-14T20:32:00Z', lastError: 'Google Sheets did not answer in time',
  createdAt: orderPaid.updatedAt, updatedAt: CHECKED_AT,
};
export const syncJobs: SyncJob[] = [syncJobRetrying];

/**
 * The event of a resolve response (the conflict of `menuPriceConflictResolved`). Keeping Square supersedes
 * the draft without creating a new fact version. It is an example only and is not in `allActivityEvents`:
 * in the stored world `cfl_pizza_01` is still open, and the event is dated after `FIXTURE_NOW` (issue #103).
 */
export const factConflictResolvedEvent: ActivityEvent = {
  id: 'evt_conflict_resolved_88', businessId: PIZZA_BUSINESS_ID, type: 'fact.changed', correlationId: 'cfl_pizza_01', actorType: 'owner', occurredAt: '2026-11-14T20:31:00Z',
  payload: { factId: 'fact_pizza_menu_marg_lg_d1', kind: 'menu_item', key: menuItemDraftFact.key, fromVersion: 1, toVersion: 1, sourceType: 'upload', resolvedConflictId: 'cfl_pizza_01' },
};

function checkoutFor(order: typeof orderPaymentPending): OrderCheckout {
  if (order.checkoutUrl === undefined) return { orderId: order.id, ready: false, environment: 'sandbox' };
  const out: OrderCheckout = { orderId: order.id, ready: true, environment: 'sandbox', checkoutUrl: order.checkoutUrl, qrText: order.checkoutUrl };
  if (order.squarePaymentLinkId !== undefined) out.squarePaymentLinkId = order.squarePaymentLinkId;
  const d = messageDispatches.find((m) => m.subjectId === order.id);
  if (d !== undefined) {
    const message: NonNullable<OrderCheckout['message']> = { id: d.id, channel: d.channel, status: d.status };
    if (d.sentAt !== undefined) message.sentAt = d.sentAt;
    if (d.deliveredAt !== undefined) message.deliveredAt = d.deliveredAt;
    out.message = message;
  }
  return out;
}

/** Link sent by Surge, not paid yet. */
export const checkoutPaymentPending: OrderCheckout = checkoutFor(orderPaymentPending);
/** `qr_only`: no dispatch, so no `message`. */
export const checkoutQrOnly: OrderCheckout = checkoutFor(orderPaid);
/** Still waiting for approval: no link yet. */
export const checkoutNotReady: OrderCheckout = checkoutFor(orderAwaitingApproval);
export const checkoutFulfilled: OrderCheckout = checkoutFor(orderFulfilled);
export const orderCheckouts: OrderCheckout[] = [checkoutPaymentPending, checkoutQrOnly, checkoutNotReady, checkoutFulfilled];

export const telemetry = {
  metrics: [
    { name: 'call_answer_latency', p50Ms: 820, p95Ms: 1450, count: 12 },
    { name: 'first_audio', p50Ms: 1900, p95Ms: 2600, count: 12 },
    { name: 'tool_latency', p50Ms: 640, p95Ms: 1380, count: 58 },
    { name: 'approval_time', p50Ms: 65000, p95Ms: 210000, count: 9 },
    { name: 'webhook_delay', p50Ms: 1200, p95Ms: 4100, count: 6 },
  ],
} satisfies TelemetryResponse;

/** Events outside the scripted timelines, for the activity list. */
export const otherActivityEvents = [
  { id: 'evt_o01', businessId: PIZZA_BUSINESS_ID, type: 'agent.published', correlationId: 'bld_demo_00', actorType: 'owner', occurredAt: '2026-11-14T16:00:00Z',
    payload: { agentId: 'agt_pizza_01', agentVersionId: 'agv_pizza_01_v2', version: 2, phoneNumberLast4: '0199' } },
  { id: 'evt_o02', businessId: BARBER_BUSINESS_ID, type: 'live_agent.changed', correlationId: 'bld_demo_b0', actorType: 'owner', occurredAt: '2026-11-14T17:00:00Z',
    payload: { phoneNumberLast4: '0199', agentId: 'agt_barber_01', agentVersionId: 'agv_barber_01_v1', previousAgentId: 'agt_pizza_01' } },
  { id: 'evt_o03', businessId: PIZZA_BUSINESS_ID, type: 'extraction.completed', correlationId: 'file_menu_01', actorType: 'system', occurredAt: '2026-11-14T18:05:30Z',
    payload: { fileId: menuFile.id, mime: menuFile.mime, extractionState: 'EXTRACTED', draftFactCount: menuFile.draftFactIds.length, conflictCount: menuFile.conflictIds.length } },
  { id: 'evt_o04', businessId: PIZZA_BUSINESS_ID, type: 'live_agent.changed', correlationId: 'bld_demo_00', actorType: 'owner', occurredAt: '2026-11-14T18:55:00Z',
    payload: { phoneNumberLast4: '0199', agentId: 'agt_pizza_01', agentVersionId: 'agv_pizza_01_v2', previousAgentId: 'agt_barber_01' } },
  { id: 'evt_o05', businessId: PIZZA_BUSINESS_ID, type: 'webhook.rejected', correlationId: 'whk_rejected_01', actorType: 'provider', occurredAt: '2026-11-14T19:30:00Z',
    payload: { provider: 'square', reason: 'signature_invalid' } },
  { id: 'evt_o06', businessId: PIZZA_BUSINESS_ID, type: 'guardrail.refused', correlationId: 'call_demo_05', actorType: 'deployed_agent', occurredAt: '2026-11-14T19:51:20Z',
    payload: { callId: 'call_demo_05', rule: 'no_fact_changes', reasonCode: 'fact_change_forbidden' } },
  { id: 'evt_o07', businessId: PIZZA_BUSINESS_ID, type: 'guardrail.refused', correlationId: 'apv_demo_f01', actorType: 'system', occurredAt: '2026-11-14T20:29:00Z',
    payload: { approvalId: 'apv_demo_f01', rule: 'no_approval_bypass', reasonCode: 'approval_pending' } },
] satisfies ActivityEvent[];

/**
 * An AgentPhone webhook that failed its signature check (D-12). It is an example only and is not in
 * `otherActivityEvents` or `allActivityEvents`, so the activity list and its counts do not change.
 */
export const webhookRejectedAgentphoneEvent: ActivityEvent = {
  id: 'evt_o08', businessId: PIZZA_BUSINESS_ID, type: 'webhook.rejected', correlationId: 'whk_rejected_02', actorType: 'provider', occurredAt: '2026-11-14T19:35:00Z',
  payload: { provider: 'agentphone', reason: 'signature_invalid' },
};

/** Every stored event, oldest first. Nothing here is later than `FIXTURE_NOW`. */
export const allActivityEvents: ActivityEvent[] = [
  ...pizzaOrderTimeline.entries.map((e) => e.event),
  ...barberBookingTimeline.entries.map((e) => e.event),
  ...barberSlotConflictTimeline.entries.map((e) => e.event),
  ...otherActivityEvents,
].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));

/** First page of `GET /api/activity?businessId=biz_pizza_01`, newest first. */
export const pizzaActivityPage: Page<ActivityEvent> = {
  items: allActivityEvents.filter((e) => e.businessId === PIZZA_BUSINESS_ID).reverse().slice(0, 25),
  nextCursor: 'eyJvIjoiZXZ0X3AwNCJ9',
};
