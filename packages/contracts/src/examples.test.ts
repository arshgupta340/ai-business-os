// Every JSON example in docs/CONTRACTS.md and docs/API.md, parsed with its schema.
// Changes from the docs are marked DOC-FIX: the docs abbreviate hashes ("sha256:9c1e...") and leave out
// fields that CONTRACTS.md marks required; the examples here fill them in.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ActivityEventSchema,
  AgentRunResponseSchema,
  AgentSchema,
  ApiErrorSchema,
  ApprovalRequestSchema,
  BookingSchema,
  BuilderMessageBodySchema,
  BuilderSessionSchema,
  BuilderTurnResponseSchema,
  BusinessSchema,
  CatalogSyncResponseSchema,
  DecisionResponseSchema,
  ENDPOINTS,
  FactsListResponseSchema,
  FileResponseSchema,
  IntegrationHealthSchema,
  LiveAgentSchema,
  ListBusinessesResponseSchema,
  OrderCheckoutSchema,
  OrderSchema,
  PreviewResponseSchema,
  ProposeFactBodySchema,
  ProposeFactResponseSchema,
  ProposePriceBodySchema,
  PublishResponseSchema,
  RealtimeClientSecretSchema,
  TOOL_DEFINITIONS,
  ACTIVITY_EVENT_PAYLOADS,
  ActivityPageSchema,
} from './index';

const HASH_A = `sha256:${'a1'.repeat(32)}`;
const HASH_B = `sha256:${'b2'.repeat(32)}`;
const HASH_C = `sha256:${'c3'.repeat(32)}`;

function ok(schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } }, value: unknown) {
  const r = schema.safeParse(value);
  if (!r.success) throw new Error(JSON.stringify(r.error, null, 2));
  expect(r.success).toBe(true);
}

describe('API.md examples', () => {
  it('error body', () => {
    ok(ApiErrorSchema, { code: 'PAYLOAD_HASH_MISMATCH', message: 'The approval payload changed since you loaded it.', correlationId: '6f1c2b9e-8f2a-4c1d-9b77-3e5a0d2c4f10', retryable: false, details: { approvalId: 'apv_123' } });
  });

  it('3.1 GET /api/businesses', () => {
    ok(ListBusinessesResponseSchema, { items: [ { id: 'biz_pizza_01', name: 'Demo Pizza Co.', category: 'restaurant', timezone: 'America/Los_Angeles' },
      { id: 'biz_barber_01', name: 'Demo Barbershop', category: 'barbershop', timezone: 'America/Los_Angeles' } ] });
  });

  it('3.1 GET /api/businesses/:id', () => {
    ok(BusinessSchema, { id: 'biz_pizza_01', name: 'Demo Pizza Co.', category: 'restaurant', timezone: 'America/Los_Angeles',
      contact: { phone: '+15555550100', email: 'owner@example.com' }, settings: {}, createdAt: '2026-11-13T08:00:00Z', updatedAt: '2026-11-13T08:00:00Z' });
  });

  it('3.1 GET /api/businesses/:id/facts', () => {
    ok(FactsListResponseSchema, { items: [ { id: 'fact_hours_fri', businessId: 'biz_pizza_01', kind: 'hours', key: 'fri', value: { open: '11:00', close: '22:00' },
      sourceType: 'seed', status: 'verified', confidence: 1, version: 1, verifiedAt: '2026-11-13T08:00:00Z',
      createdAt: '2026-11-13T08:00:00Z', updatedAt: '2026-11-13T08:00:00Z' } ],
    conflicts: [ { id: 'cfl_01', businessId: 'biz_pizza_01', kind: 'policy', key: 'pickup_window', required: true, state: 'open',
      candidates: [ { factId: 'fact_7a1', sourceType: 'upload', value: { minutes: 20 } },
        { factId: 'fact_pw_01', sourceType: 'seed', value: { minutes: 30 } } ],
      createdAt: '2026-11-13T19:00:30Z' } ] });
  });

  it('3.1 POST facts/propose body and response', () => {
    ok(ProposeFactBodySchema, { kind: 'hours', key: 'fri', value: { open: '11:00', close: '23:00' }, reason: 'Open late on Fridays' });
    ok(ProposeFactBodySchema, { resolvesConflictId: 'cfl_01', value: { minutes: 20 } });
    ok(ProposeFactResponseSchema, { approval: { id: 'apv_f01', businessId: 'biz_pizza_01', actorType: 'owner', bundleType: 'fact_edit',
      actionBundle: ['local.fact.update'], subjectId: 'fact_hours_fri_d2',
      payload: { businessId: 'biz_pizza_01', subjectId: 'fact_hours_fri_d2', kind: 'hours', key: 'fri', fromVersion: 1,
        before: { open: '11:00', close: '22:00' }, after: { open: '11:00', close: '23:00' },
        actionBundle: ['local.fact.update'], expiresAt: '2026-11-13T20:10:00Z' },
      payloadHash: HASH_A /* DOC-FIX: "sha256:9c1e..." */, state: 'PENDING', expiresAt: '2026-11-13T20:10:00Z', createdAt: '2026-11-13T20:00:00Z' } });
  });

  it('3.1 catalog sync and price propose', () => {
    ok(CatalogSyncResponseSchema, { jobId: 'job_cat_01' });
    ok(ProposePriceBodySchema, { variationId: 'SQ_VAR_PEP_LG', newPriceMinor: 1900, currency: 'USD' });
  });

  it('3.2 POST files response', () => {
    ok(FileResponseSchema, { file: { id: 'file_menu_01', businessId: 'biz_pizza_01', name: 'menu.pdf', mime: 'application/pdf', sizeBytes: 182044,
      sha256: HASH_B /* DOC-FIX: "4be0..." (DATA-MODEL requires the sha256: prefix) */, extractionState: 'PENDING', draftFactIds: [], createdAt: '2026-11-13T19:00:00Z' } });
  });

  it('3.3 builder session', () => {
    ok(BuilderSessionSchema, { id: 'bld_01', businessId: 'biz_pizza_01', status: 'active',
      messages: [ { id: 'bmsg_01', sessionId: 'bld_01', inputMode: 'text' /* DOC-FIX: sessionId and inputMode added */, role: 'assistant', text: 'What would you like an agent to do for your business?', createdAt: '2026-11-13T19:00:00Z' } ],
      draftSpec: {}, missingFields: [], progress: { answered: 0, required: 0 }, createdAt: '2026-11-13T19:00:00Z', updatedAt: '2026-11-13T19:00:00Z' });
  });

  it('3.3 builder message body and turn response', () => {
    ok(BuilderMessageBodySchema, { text: 'I run a pizza shop and want an AI that takes pickup orders.', inputMode: 'text' });
    ok(BuilderTurnResponseSchema, { reply: { id: 'bmsg_02', sessionId: 'bld_01', inputMode: 'text' /* DOC-FIX */, role: 'assistant', text: 'I can do that. What is the latest pickup time you accept on weekdays?', evidenceRefs: ['fact_hours_fri'], createdAt: '2026-11-13T19:01:00Z' },
      draftSpec: { template: 'restaurant_order_taker', name: 'Pizza Order Assistant', channel: 'phone',
        capabilities: ['catalog.read', 'business.facts.read', 'order.quote', 'order.propose', 'order.status.read', 'order.checkout.prepare', 'message.checkout.send', 'sheets.rows.append'] },
      missingFields: ['policy.pickup_window'], suggestions: ['Upload menu', 'Use Square catalog'], stopConditions: [], progress: { answered: 3, required: 6 },
      unsupportedRequests: [] /* issue #56 */ });
  });

  it('3.4 agent summary, preview, test, publish', () => {
    ok(AgentSchema, { id: 'agt_pizza_01', businessId: 'biz_pizza_01', name: 'Pizza Order Assistant', template: 'restaurant_order_taker', state: 'draft',
      draftSpec: { template: 'restaurant_order_taker', capabilities: ['catalog.read', 'order.propose'] }, isLiveAgent: false,
      createdAt: '2026-11-13T19:05:00Z', updatedAt: '2026-11-13T19:05:00Z' });
    ok(PreviewResponseSchema, { agentId: 'agt_pizza_01', specRevision: 4,
      permissions: { readOnly: ['catalog.read', 'business.facts.read', 'order.quote', 'order.status.read'], proposes: ['order.propose'],
        approvalRequired: ['order.checkout.prepare', 'message.checkout.send', 'sheets.rows.append'] },
      examples: [ { scenario: 'happy_path', transcript: [ { role: 'caller', text: 'One large margherita for pickup at 7.' }, { role: 'agent', text: 'That is 20 dollars and 61 cents with tax.' } ],
        toolTrace: [ { tool: 'quote_order', capabilityId: 'order.quote', effect: 'read', input: { cart: { lines: [] } },
          output: { ok: true, quote: { quoteId: 'qte_m1', totalMinor: 2061, currency: 'USD' } }, mocked: true, durationMs: 4 } ] } ] });
    ok(AgentRunResponseSchema, { testSessionId: 'tst_01', reply: 'Two large pepperoni. Any extra toppings?',
      toolTrace: [ { tool: 'read_catalog', capabilityId: 'catalog.read', effect: 'read', input: { query: 'large pepperoni' },
        output: { ok: true, items: [ { catalogItemId: 'SQ_ITEM_PEP', name: 'Pepperoni', available: true, variations: [ { id: 'SQ_VAR_PEP_LG', name: 'Large', priceMinor: 2200 } ], modifierLists: [] } ] }, mocked: true, durationMs: 6 } ] });
    ok(AgentRunResponseSchema, { testSessionId: 'tst_01', reply: 'I cannot change prices.', toolTrace: [], guardrail: { refused: true, rule: 'no_fact_changes' } });
    ok(PublishResponseSchema, { agent: { id: 'agt_pizza_01', state: 'live', activeVersionId: 'agv_pizza_01_v2', isLiveAgent: true },
      version: { id: 'agv_pizza_01_v2', agentId: 'agt_pizza_01', version: 2,
        spec: { /* DOC-FIX: the doc shows only { template }; a version holds the full immutable spec */
          id: 'agt_pizza_01', businessId: 'biz_pizza_01', version: 2, template: 'restaurant_order_taker', name: 'Pizza Order Assistant', channel: 'phone',
          goal: 'Take pickup orders.', knowledgeScopes: ['catalog', 'hours'], capabilities: ['catalog.read', 'order.propose'],
          writePolicy: 'owner_approval_each_action_bundle', escalation: 'explain_unsupported_or_offer_callback', status: 'live', guardrailVersion: 'v1' },
        knowledgeSnapshotRef: { facts: [ { id: 'fact_hours_fri', version: 1 } ], catalogSyncedAt: '2026-11-13T19:30:00Z' }, createdBy: 'usr_owner_01', publishedAt: '2026-11-13T19:30:00Z' },
      phoneNumber: '+15555550199' });
  });

  it('3.5 realtime client secret', () => {
    ok(RealtimeClientSecretSchema, { clientSecret: 'ek_...', expiresAt: '2026-11-13T19:11:00Z', model: 'gpt-realtime-2.1', builderSessionId: 'bld_01' });
  });

  it('3.6 live agent, including the empty case', () => {
    ok(LiveAgentSchema, { phoneNumber: '+15555550199', businessId: 'biz_pizza_01', agentId: 'agt_pizza_01', agentVersionId: 'agv_pizza_01_v2', updatedAt: '2026-11-13T19:30:00Z' });
    ok(LiveAgentSchema, { phoneNumber: '+15555550199', businessId: 'biz_pizza_01' });
  });

  it('3.7 approval and decision', () => {
    ok(ApprovalRequestSchema, { id: 'apv_123', businessId: 'biz_pizza_01', actorType: 'deployed_agent', bundleType: 'order_bundle',
      actionBundle: ['square.checkout.create', 'message.checkout.send', 'local.order.record', 'sheets.order.append'], subjectId: 'ord_123',
      payload: { businessId: 'biz_pizza_01', subjectId: 'ord_123', agentVersionId: 'agv_pizza_01_v2', cartHash: HASH_A /* DOC-FIX */, totalMinor: 3264,
        currency: 'USD', pickupAt: '2026-11-14T02:00:00Z', messageRecipient: '+15555550123', messageChannel: 'surge',
        actionBundle: ['square.checkout.create', 'message.checkout.send', 'local.order.record', 'sheets.order.append'], expiresAt: '2026-11-13T19:52:00Z' },
      payloadHash: HASH_C /* DOC-FIX */, state: 'PENDING', expiresAt: '2026-11-13T19:52:00Z', createdAt: '2026-11-13T19:42:00Z' });
    ok(DecisionResponseSchema, { approval: { id: 'apv_123', state: 'APPROVED', decidedBy: 'usr_owner_01', decidedAt: '2026-11-13T19:44:10Z' } });
  });

  it('3.8 order and checkout', () => {
    ok(OrderSchema, { id: 'ord_123', businessId: 'biz_pizza_01', callId: 'call_77', status: 'PAYMENT_PENDING', totalMinor: 3264, currency: 'USD',
      cart: { lines: [ { catalogItemId: 'SQ_ITEM_PEP', variationId: 'SQ_VAR_PEP_LG', quantity: 2, modifierIds: ['SQ_MOD_XCHEESE'] } ] },
      cartHash: HASH_A, quote: { quoteId: 'qte_1', cartHash: HASH_A, subtotalMinor: 3000, taxMinor: 264, totalMinor: 3264,
        currency: 'USD', lines: [], quotedAt: '2026-11-13T19:40:00Z', expiresAt: '2026-11-13T19:45:00Z' },
      contact: { name: 'Sam', messageRecipient: '+15555550123', messageConsent: true, consentAt: '2026-11-13T19:41:00Z' },
      fulfillment: { type: 'pickup', pickupAt: '2026-11-14T02:00:00Z' }, approvalId: 'apv_123',
      squareOrderId: 'SQ_ORD_9', squarePaymentLinkId: 'SQ_PL_4', checkoutUrl: 'https://sandbox.square.link/u/abc',
      createdAt: '2026-11-13T19:42:00Z', updatedAt: '2026-11-13T19:45:00Z' });
    ok(OrderCheckoutSchema, { orderId: 'ord_123', ready: true, environment: 'sandbox', checkoutUrl: 'https://sandbox.square.link/u/abc', qrText: 'https://sandbox.square.link/u/abc',
      squarePaymentLinkId: 'SQ_PL_4', message: { id: 'msg_31', channel: 'surge', status: 'SENT', sentAt: '2026-11-13T19:45:02Z' } });
    ok(OrderCheckoutSchema, { orderId: 'ord_123', ready: false, environment: 'sandbox' });
  });

  it('3.9 booking', () => {
    ok(BookingSchema, { id: 'bkg_12', businessId: 'biz_barber_01', callId: 'call_80', status: 'BOOKED_VERIFIED', serviceId: 'svc_cut', serviceName: 'Haircut',
      calendarId: 'demo-barber@group.calendar.google.com', startUtc: '2026-11-14T18:00:00Z', endUtc: '2026-11-14T18:30:00Z', timezone: 'America/Los_Angeles',
      customer: { name: 'Ana', messageRecipient: '+15555550124', messageConsent: true }, approvalId: 'apv_200',
      googleEventId: '3f9a0c...', createdAt: '2026-11-13T20:00:00Z', updatedAt: '2026-11-13T20:02:00Z' });
  });

  it('3.10 activity page', () => {
    ok(ActivityPageSchema, { items: [ { id: 'evt_901', businessId: 'biz_pizza_01', type: 'payment.verified', correlationId: 'call_77', actorType: 'provider',
      occurredAt: '2026-11-13T19:47:30Z', payload: { orderId: 'ord_123', squarePaymentId: 'SQ_PAY_2', amountMinor: 3264, currency: 'USD', sandbox: true } } ],
    nextCursor: 'eyJvIjoiZXZ0XzkwMCJ9' });
  });

  it('3.11 integrations health', () => {
    ok(IntegrationHealthSchema, { square: { state: 'connected', environment: 'sandbox', lastCheckedAt: '2026-11-13T19:00:00Z' },
      twilio: { state: 'connected', lastCheckedAt: '2026-11-13T19:00:00Z' },
      openai: { state: 'connected', lastCheckedAt: '2026-11-13T19:00:00Z' },
      google_calendar: { state: 'degraded', detail: 'free/busy slow', lastCheckedAt: '2026-11-13T19:00:00Z' },
      google_sheets: { state: 'disconnected', detail: 'sheet not shared', lastCheckedAt: '2026-11-13T19:00:00Z' },
      message_channel: { state: 'connected', channel: 'surge', detail: '18 of 25 messages left', lastCheckedAt: '2026-11-13T19:00:00Z' } });
  });

  it('square health without environment fails (AC-19)', () => {
    const r = IntegrationHealthSchema.safeParse({ square: { state: 'connected', lastCheckedAt: '2026-11-13T19:00:00Z' } });
    expect(r.success).toBe(false);
  });

  it('every endpoint request example body parses with the table schema', () => {
    expect(ENDPOINTS.publishAgent.body.safeParse({ confirm: true, makeLive: true }).success).toBe(true);
    expect(ENDPOINTS.publishAgent.body.safeParse({ confirm: false }).success).toBe(false);
    expect(ENDPOINTS.rollbackAgent.body.safeParse({ toVersionId: 'agv_pizza_01_v1', confirm: true }).success).toBe(true);
    expect(ENDPOINTS.putLiveAgent.body.safeParse({ agentId: 'agt_barber_01' }).success).toBe(true);
    expect(ENDPOINTS.createAgent.body.safeParse({ builderSessionId: 'bld_01' }).success).toBe(true);
    expect(ENDPOINTS.createBuilderSession.body.safeParse({ agentId: 'agt_pizza_01' }).success).toBe(true);
    expect(ENDPOINTS.createBuilderSession.body.safeParse({}).success).toBe(true);
    expect(ENDPOINTS.previewAgent.body.safeParse({ scenarios: ['happy_path', 'price_injection'] }).success).toBe(true);
    expect(ENDPOINTS.testAgent.body.safeParse({ message: 'Two large pepperoni please' }).success).toBe(true);
    expect(ENDPOINTS.simCall.body.safeParse({ message: 'bye', callId: 'call_77', end: true }).success).toBe(true);
    expect(ENDPOINTS.createRealtimeClientSecret.body.safeParse({ builderSessionId: 'bld_01' }).success).toBe(true);
    expect(ENDPOINTS.decideApproval.body.safeParse({ decision: 'approve', payloadHash: HASH_C }).success).toBe(true);
    expect(ENDPOINTS.updateBusiness.body.safeParse({ name: 'Demo Pizza Co.' }).success).toBe(true);
    // SPEC 2.8: a fact field on PATCH is refused.
    expect(ENDPOINTS.updateBusiness.body.safeParse({ hours: {} }).success).toBe(false);
  });
});

describe('CONTRACTS.md examples', () => {
  const pizza = [
    '{"id":"evt_p01","businessId":"biz_pizza_01","type":"call.started","correlationId":"call_p01","actorType":"provider","occurredAt":"2026-11-14T19:00:00Z","payload":{"callId":"call_p01","agentId":"agt_pizza_01","agentVersionId":"agv_pizza_01_v1","channel":"phone","callerLast4":"0123"}}',
    '{"id":"evt_p02","businessId":"biz_pizza_01","type":"proposal.created","correlationId":"call_p01","actorType":"deployed_agent","occurredAt":"2026-11-14T19:03:10Z","payload":{"subjectId":"ord_p01","subjectType":"order","callId":"call_p01","totalMinor":4731,"currency":"USD"}}',
    '{"id":"evt_p03","businessId":"biz_pizza_01","type":"approval.requested","correlationId":"call_p01","actorType":"system","occurredAt":"2026-11-14T19:03:10Z","payload":{"approvalId":"apv_p01","bundleType":"order_bundle","subjectId":"ord_p01","actionBundle":["square.checkout.create","message.checkout.send","local.order.record","sheets.order.append"],"expiresAt":"2026-11-14T19:13:10Z","totalMinor":4731,"recipientLast4":"0123"}}',
    '{"id":"evt_p04","businessId":"biz_pizza_01","type":"call.ended","correlationId":"call_p01","actorType":"provider","occurredAt":"2026-11-14T19:03:40Z","payload":{"callId":"call_p01","status":"COMPLETED","reason":"completed","durationSec":220}}',
    '{"id":"evt_p05","businessId":"biz_pizza_01","type":"approval.decided","correlationId":"call_p01","actorType":"owner","occurredAt":"2026-11-14T19:04:05Z","payload":{"approvalId":"apv_p01","subjectId":"ord_p01","decision":"APPROVED","decidedBy":"usr_owner_01"}}',
    '{"id":"evt_p06","businessId":"biz_pizza_01","type":"checkout.created","correlationId":"call_p01","actorType":"system","occurredAt":"2026-11-14T19:04:07Z","payload":{"orderId":"ord_p01","squareOrderId":"SQ_ORDER_1","squarePaymentLinkId":"SQ_LINK_1","totalMinor":4731,"currency":"USD","sandbox":true}}',
    '{"id":"evt_p07","businessId":"biz_pizza_01","type":"message.sent","correlationId":"call_p01","actorType":"system","occurredAt":"2026-11-14T19:04:09Z","payload":{"dispatchId":"msg_p01","subjectId":"ord_p01","channel":"surge","template":"checkout_link","recipientLast4":"0123"}}',
    '{"id":"evt_p08","businessId":"biz_pizza_01","type":"payment.verified","correlationId":"call_p01","actorType":"provider","occurredAt":"2026-11-14T19:06:30Z","payload":{"orderId":"ord_p01","squarePaymentId":"SQ_PAY_1","amountMinor":4731,"currency":"USD","sandbox":true}}',
    '{"id":"evt_p09","businessId":"biz_pizza_01","type":"order.status_changed","correlationId":"call_p01","actorType":"system","occurredAt":"2026-11-14T19:06:30Z","payload":{"orderId":"ord_p01","callId":"call_p01","from":"PAYMENT_PENDING","to":"PAID_VERIFIED"}}',
  ];
  const booking = [
    '{"id":"evt_b01","businessId":"biz_barber_01","type":"proposal.created","correlationId":"call_b01","actorType":"deployed_agent","occurredAt":"2026-11-14T20:00:00Z","payload":{"subjectId":"bkg_b01","subjectType":"booking","callId":"call_b01","serviceName":"Haircut","startUtc":"2026-11-15T18:00:00Z"}}',
    '{"id":"evt_b02","businessId":"biz_barber_01","type":"approval.requested","correlationId":"call_b01","actorType":"system","occurredAt":"2026-11-14T20:00:00Z","payload":{"approvalId":"apv_b01","bundleType":"booking_bundle","subjectId":"bkg_b01","actionBundle":["calendar.event.create","message.booking.confirm","local.booking.record","sheets.booking.append"],"expiresAt":"2026-11-14T20:10:00Z","recipientLast4":"0456"}}',
    '{"id":"evt_b03","businessId":"biz_barber_01","type":"approval.decided","correlationId":"call_b01","actorType":"owner","occurredAt":"2026-11-14T20:01:00Z","payload":{"approvalId":"apv_b01","subjectId":"bkg_b01","decision":"APPROVED","decidedBy":"usr_owner_01"}}',
    '{"id":"evt_b04","businessId":"biz_barber_01","type":"execution.started","correlationId":"call_b01","actorType":"system","occurredAt":"2026-11-14T20:01:01Z","payload":{"executionId":"exe_b01","approvalId":"apv_b01","actionType":"calendar.event.create","stepIndex":0,"attempt":1}}',
    '{"id":"evt_b05","businessId":"biz_barber_01","type":"booking.verified","correlationId":"call_b01","actorType":"provider","occurredAt":"2026-11-14T20:01:03Z","payload":{"bookingId":"bkg_b01","googleEventId":"3f9a0c...","serviceName":"Haircut","startUtc":"2026-11-15T18:00:00Z","timezone":"America/Los_Angeles"}}',
  ];

  it.each([...pizza, ...booking])('event %#', (line) => {
    ok(ActivityEventSchema, JSON.parse(line));
  });

  it('section 8 tool definitions match the doc: names, descriptions, required fields, no extra properties', () => {
    const doc: Record<string, { description: string; required: string[] }> = {
      read_catalog: { description: "Search this shop's menu. Use exact item, size and topping IDs from the result.", required: [] },
      read_business_facts: { description: 'Read verified opening hours, policies and services. Answer only from this result.', required: [] },
      quote_order: { description: 'Get the exact total and tax for a cart. Read the total back to the caller from this result only.', required: ['cart'] },
      propose_order: { description: 'Send the confirmed order to the owner for approval. Call only after the caller confirmed the read-back of this quote. Record whether the caller consents to messages; without consent, omit the recipient and use the dashboard QR code.', required: ['cart', 'contact', 'fulfillment', 'quoteId'] },
      get_order_status: { description: 'Read the verified status of an order placed on this call.', required: ['orderId'] },
      read_calendar_availability: { description: 'List free appointment slots for one service on one date.', required: ['serviceId', 'date'] },
      propose_booking: { description: 'Send the confirmed appointment to the owner for approval. Call only after the caller confirmed service, time and contact.', required: ['serviceId', 'startUtc', 'customer'] },
    };
    expect(TOOL_DEFINITIONS.map((d) => d.name).sort()).toEqual(Object.keys(doc).sort());
    for (const def of TOOL_DEFINITIONS) {
      const want = doc[def.name];
      expect(want).toBeDefined();
      expect(def.type).toBe('function');
      expect(def.description).toBe(want?.description);
      expect(def.parameters.type).toBe('object');
      expect(def.parameters.additionalProperties).toBe(false);
      expect([...((def.parameters.required as string[] | undefined) ?? [])].sort()).toEqual([...(want?.required ?? [])].sort());
      expect(JSON.stringify(def.parameters)).not.toContain('$ref');
      expect(JSON.stringify(def.parameters)).not.toMatch(/businessId|callId|agentVersionId/);
    }
    const kinds = TOOL_DEFINITIONS.find((d) => d.name === 'read_business_facts')?.parameters as { properties: { kinds: { items: { enum: string[] } } } };
    expect(kinds.properties.kinds.items.enum).toEqual(['hours', 'policy', 'service', 'contact', 'faq']);
  });

  const contractsDoc = readFileSync(fileURLToPath(new URL('../../../docs/CONTRACTS.md', import.meta.url)), 'utf8');
  const section = (n: number) => {
    const start = contractsDoc.indexOf(`\n## ${n}. `);
    const end = contractsDoc.indexOf(`\n## ${n + 1}. `, start);
    return contractsDoc.slice(start, end);
  };

  it('the section 8 JSON block equals TOOL_DEFINITIONS exactly', () => {
    const block = /```json\n([\s\S]*?)\n```/.exec(section(8))?.[1];
    expect(block).toBeDefined();
    expect(JSON.parse(block ?? '[]')).toEqual(JSON.parse(JSON.stringify(TOOL_DEFINITIONS)));
  });

  it('the section 7 guardrail.refused row lists exactly the payload fields of the code', () => {
    const row = section(7).split('\n').find((l) => l.startsWith('| `guardrail.refused` |')) ?? '';
    const fields = /`\{ ([^}]*) \}`/.exec(row)?.[1]?.split(', ').map((f) => f.split(':')[0]?.trim() ?? '') ?? [];
    const shape = ACTIVITY_EVENT_PAYLOADS['guardrail.refused'].shape;
    const want = Object.keys(shape).map((k) => (shape[k as keyof typeof shape].safeParse(undefined).success ? `${k}?` : k));
    expect([...fields].sort()).toEqual([...want].sort());
  });
});
