// Every fixture parses with its contract schema, every stored hash is real, and every cross-reference
// resolves. If a hash test fails after a data change, run: npx tsx packages/contracts/fixtures/generate-hashes.ts
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  ACTION_TYPE_CAPABILITY,
  APPROVAL_EXPIRY_MS,
  ActionExecutionSchema,
  ActivityEventSchema,
  AgentSchema,
  AgentSpecSchema,
  AgentVersionSchema,
  ApprovalRequestSchema,
  BookingSchema,
  BuilderSessionSchema,
  BusinessFactSchema,
  BusinessSchema,
  CallSchema,
  CatalogItemSchema,
  ENDPOINTS,
  FactConflictSchema,
  FileRecordSchema,
  HoursValueSchema,
  IntegrationHealthSchema,
  LiveAgentSchema,
  MessageDispatchSchema,
  OrderCheckoutSchema,
  OrderSchema,
  QUOTE_EXPIRY_MS,
  ServiceOfferingSchema,
  SyncJobSchema,
  MATERIAL_FIELDS,
  approvalPayloadHash,
  canonicalJson,
  cartHash,
  hashCanonical,
  idempotencyKey,
  payloadHash,
  pickMaterialFields,
  sha256Hex,
  toCanonicalTimestamp,
  type EndpointName,
} from '../src/index';
import * as F from './index';
import { materializeFixtures, type FixtureWorld } from './index';

function parses(schema: z.ZodType, value: unknown, label: string): void {
  const r = schema.safeParse(value);
  if (!r.success) throw new Error(`${label}: ${JSON.stringify(r.error.issues, null, 2)}`);
}

function parsesAll(schema: z.ZodType, values: readonly unknown[], label: string): void {
  values.forEach((v, i) => parses(schema, v, `${label}[${i}]`));
}

const ms = (iso: string) => Date.parse(iso);
const ids = <T extends { id: string }>(xs: readonly T[]) => new Set(xs.map((x) => x.id));

describe('fixtures parse with the contract schemas', () => {
  it('businesses, facts, conflicts, files', () => {
    parsesAll(BusinessSchema, F.businesses, 'businesses');
    parsesAll(BusinessFactSchema, F.allFacts, 'facts');
    parsesAll(FactConflictSchema, [...F.factConflicts, F.menuPriceConflictResolved], 'conflicts');
    parsesAll(FileRecordSchema, F.files, 'files');
    parsesAll(ServiceOfferingSchema, F.barberServices, 'services');
    for (const f of F.allFacts.filter((x) => x.kind === 'hours')) parses(HoursValueSchema, f.value, f.id);
    for (const f of F.allFacts.filter((x) => x.kind === 'service')) parses(ServiceOfferingSchema, f.value, f.id);
  });

  it('catalog, agents, calls, live agent, builder', () => {
    parsesAll(CatalogItemSchema, F.pizzaCatalog, 'catalog');
    parsesAll(AgentSpecSchema, [F.pizzaSpecV1, F.pizzaSpecV2, F.barberSpecV1], 'specs');
    parsesAll(AgentVersionSchema, F.agentVersions, 'versions');
    parsesAll(AgentSchema, F.agents, 'agents');
    parsesAll(CallSchema, F.calls, 'calls');
    parsesAll(LiveAgentSchema, [F.liveAgent, F.liveAgentBarber, F.liveAgentEmpty], 'liveAgent');
    parsesAll(BuilderSessionSchema, [F.builderSession, F.builderSessionNew], 'builder');
  });

  it('orders, bookings, approvals, executions, dispatches, dashboard data', () => {
    parsesAll(OrderSchema, [...F.orders, F.orderCancelled], 'orders');
    parsesAll(BookingSchema, F.bookings, 'bookings');
    parsesAll(ApprovalRequestSchema, F.approvals, 'approvals');
    parsesAll(ActionExecutionSchema, F.executions, 'executions');
    parsesAll(MessageDispatchSchema, F.messageDispatches, 'dispatches');
    parsesAll(SyncJobSchema, F.syncJobs, 'sync jobs');
    parses(IntegrationHealthSchema, F.integrationHealthDisconnected, 'disconnected health');
    parses(IntegrationHealthSchema, F.integrationHealth, 'health');
    parsesAll(OrderCheckoutSchema, F.orderCheckouts, 'checkouts');
    parsesAll(ActivityEventSchema, F.allActivityEvents, 'activity');
  });

  it('has a valid success fixture for every endpoint in ENDPOINTS', () => {
    const names = Object.keys(ENDPOINTS) as EndpointName[];
    expect(names.length).toBeGreaterThan(40);
    for (const name of names) {
      expect(F.fixtureResponses, name).toHaveProperty(name);
      parses(ENDPOINTS[name].response, F.fixtureResponses[name], `fixtureResponses.${name}`);
    }
    expect(Object.keys(F.fixtureResponses).sort()).toEqual([...names].sort());
  });

  it('the refused test turn parses too', () => {
    parses(ENDPOINTS.testAgent.response, F.testAgentRefusal, 'testAgentRefusal');
  });
});

describe('stored hashes are real', () => {
  it('every cart hash and quote cart hash', async () => {
    for (const o of [...F.orders, F.orderCancelled]) {
      const h = await cartHash(o.cart);
      expect(o.cartHash, o.id).toBe(h);
      expect(o.quote.cartHash, o.id).toBe(h);
    }
  });

  it('every approval payloadHash', async () => {
    for (const a of F.approvals) {
      expect(a.payloadHash, a.id).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(a.payloadHash, a.id).toBe(await payloadHash(a.payload));
    }
  });

  it('the pending order bundle hash equals the hash of its payload', async () => {
    expect(F.approvalOrderPending.state).toBe('PENDING');
    expect(F.approvalOrderPending.payloadHash).toBe(await payloadHash(F.approvalOrderPending.payload));
  });

  it('every idempotency key, and each dispatch shares its step key', async () => {
    const approvalsById = new Map(F.approvals.map((a) => [a.id, a]));
    for (const e of F.executions) {
      const a = approvalsById.get(e.approvalId);
      expect(a, e.id).toBeDefined();
      if (a === undefined) continue;
      expect(e.idempotencyKey, e.id).toBe(await idempotencyKey({ businessId: e.businessId, subjectId: a.subjectId, actionType: e.actionType, approvalId: a.id }));
    }
    for (const d of F.messageDispatches) {
      expect(d.idempotencyKey).toBe(F.executions.find((e) => e.id === d.executionId)?.idempotencyKey);
    }
  });
});

describe('business rules the stricter contracts check', () => {
  it('orders copy their quote; quote lines and totals add up exactly; quotes last 5 minutes', () => {
    for (const o of [...F.orders, F.orderCancelled]) {
      expect(o.totalMinor, o.id).toBe(o.quote.totalMinor);
      expect(o.currency, o.id).toBe(o.quote.currency);
      expect(o.cartHash, o.id).toBe(o.quote.cartHash);
      const q = o.quote;
      for (const l of q.lines) {
        const mods = l.modifiers.reduce((s, m) => s + m.priceMinor, 0);
        expect(l.lineTotalMinor, `${o.id} ${l.name}`).toBe((l.unitPriceMinor + mods) * l.quantity);
      }
      expect(q.lines.reduce((s, l) => s + l.lineTotalMinor, 0), o.id).toBe(q.subtotalMinor);
      expect(q.subtotalMinor + q.taxMinor, o.id).toBe(q.totalMinor);
      expect(ms(q.expiresAt) - ms(q.quotedAt), o.id).toBe(QUOTE_EXPIRY_MS);
      expect(q.taxMinor, o.id).toBe(F.demoTaxMinor(q.subtotalMinor));
    }
  });

  it('quote prices match the catalog', () => {
    const variations = new Map<string, number>(F.pizzaCatalog.flatMap((i) => i.variations.map((v) => [v.id, v.priceMinor] as const)));
    const modifiers = new Map<string, number>(F.pizzaCatalog.flatMap((i) => i.modifierLists.flatMap((l) => l.modifiers.map((m) => [m.id, m.priceMinor] as const))));
    for (const o of F.orders) {
      for (const l of o.quote.lines) {
        expect(l.unitPriceMinor).toBe(variations.get(l.variationId));
        for (const m of l.modifiers) expect(m.priceMinor).toBe(modifiers.get(m.modifierId));
      }
    }
  });

  it('the timeline order matches the CONTRACTS 9 worked example', () => {
    expect(F.pizzaTimelineQuote.subtotalMinor).toBe(4350);
    expect(F.pizzaTimelineQuote.taxMinor).toBe(381);
    expect(F.pizzaTimelineQuote.totalMinor).toBe(4731);
  });

  it('approvals: shared fields equal the payload, expiry is created plus 10 minutes, decision fields follow the state', () => {
    for (const a of F.approvals) {
      expect(a.payload.businessId, a.id).toBe(a.businessId);
      expect(a.payload.subjectId, a.id).toBe(a.subjectId);
      expect(a.payload.actionBundle, a.id).toEqual(a.actionBundle);
      expect(a.payload.expiresAt, a.id).toBe(a.expiresAt);
      expect(ms(a.expiresAt) - ms(a.createdAt), a.id).toBe(APPROVAL_EXPIRY_MS);
      if (a.state === 'PENDING') expect(a.decidedAt, a.id).toBeUndefined();
      else expect(a.decidedAt, a.id).toBeDefined();
      if (a.state === 'APPROVED' || a.state === 'REJECTED') expect(a.decidedBy, a.id).toBe(F.OWNER_USER_ID);
      else expect(a.decidedBy, a.id).toBeUndefined();
    }
  });

  it('covers every requested state', () => {
    expect(new Set(F.orders.map((o) => o.status))).toEqual(
      new Set(['AWAITING_OWNER_APPROVAL', 'PAYMENT_PENDING', 'PAID_VERIFIED', 'FULFILLMENT_READY', 'REJECTED', 'APPROVAL_EXPIRED', 'PAYMENT_FAILED']),
    );
    expect(new Set(F.bookings.map((b) => b.status))).toEqual(new Set(['AWAITING_OWNER_APPROVAL', 'BOOKED_VERIFIED', 'SLOT_CONFLICT', 'REJECTED', 'EXPIRED', 'RETRY_REQUIRED']));
    expect(new Set(F.approvals.map((a) => a.bundleType))).toEqual(new Set(['order_bundle', 'booking_bundle', 'fact_edit', 'price_edit']));
    expect(new Set(F.approvals.map((a) => a.state))).toEqual(new Set(['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED']));
    expect(new Set(F.calls.map((c) => c.channel))).toEqual(new Set(['phone', 'test_console']));
    expect(F.calls.some((c) => c.status === 'DROPPED')).toBe(true);
    expect(F.executions.some((e) => e.actionType === 'message.checkout.send' && e.status === 'SKIPPED')).toBe(true);
  });

  it('bookings last exactly the service duration and verified ones carry a Google event', () => {
    const services = new Map(F.barberServices.map((s) => [s.id, s]));
    for (const b of F.bookings) {
      const s = services.get(b.serviceId);
      expect(s, b.id).toBeDefined();
      expect(ms(b.endUtc) - ms(b.startUtc), b.id).toBe((s?.durationMinutes ?? 0) * 60_000);
      expect(b.serviceName).toBe(s?.name);
      if (b.status === 'BOOKED_VERIFIED') expect(b.googleEventId, b.id).toBeDefined();
    }
  });

  it('facts: verifiedAt only on verified; one verified row per business, kind and key; conflicts resolved fields', () => {
    const seen = new Set<string>();
    for (const f of F.allFacts) {
      if (f.status === 'verified') {
        expect(f.verifiedAt, f.id).toBeDefined();
        const k = `${f.businessId}:${f.kind}:${f.key}`;
        expect(seen.has(k), k).toBe(false);
        seen.add(k);
      } else expect(f.verifiedAt, f.id).toBeUndefined();
      if (f.sourceType === 'upload') expect(f.fileId, f.id).toBeDefined();
      if (f.kind === 'menu_item') expect(f.status).toBe('draft');
    }
    for (const day of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
      expect(seen.has(`biz_pizza_01:hours:${day}`)).toBe(true);
      expect(seen.has(`biz_barber_01:hours:${day}`)).toBe(true);
    }
    for (const c of [...F.factConflicts, F.menuPriceConflictResolved]) {
      const resolved = c.state === 'resolved';
      expect(c.resolvedAt !== undefined, c.id).toBe(resolved);
      expect(c.resolvedBy !== undefined, c.id).toBe(resolved);
    }
  });

  it('calls: CallSid only on phone, endedAt only once ended, endReason matches status', () => {
    const reasonFor = { COMPLETED: 'completed', DROPPED: 'dropped', FAILED: 'failed' } as const;
    for (const c of F.calls) {
      expect(c.providerCallId !== undefined, c.id).toBe(c.channel === 'phone');
      if (c.providerCallId !== undefined) expect(c.providerCallId).toMatch(/^CA[0-9a-f]{32}$/);
      if (c.channel !== 'phone') expect(c.callerLast4, c.id).toBeUndefined();
      if (c.status === 'IN_PROGRESS') {
        expect(c.endedAt, c.id).toBeUndefined();
        expect(c.endReason, c.id).toBeUndefined();
      } else {
        expect(c.endedAt, c.id).toBeDefined();
        expect(c.endReason, c.id).toBe(reasonFor[c.status]);
      }
    }
    expect(new Set(F.calls.map((c) => c.providerCallId).filter(Boolean)).size).toBe(F.calls.filter((c) => c.channel === 'phone').length);
  });

  it('orders carry Square references once a link exists, and a payment ID once paid', () => {
    const linkStates = new Set(['PAYMENT_LINK_READY', 'MESSAGE_SENT', 'PAYMENT_PENDING', 'PAID_VERIFIED', 'FULFILLMENT_READY', 'PAYMENT_FAILED']);
    for (const o of [...F.orders, F.orderCancelled]) {
      if (linkStates.has(o.status)) {
        expect(o.squareOrderId, o.id).toBeDefined();
        expect(o.squarePaymentLinkId, o.id).toBeDefined();
        expect(o.checkoutUrl, o.id).toMatch(/^https:\/\/sandbox\.square\.link\//);
      }
      if (o.status === 'PAID_VERIFIED' || o.status === 'FULFILLMENT_READY') expect(o.squarePaymentId, o.id).toBeDefined();
      if (o.status === 'AWAITING_OWNER_APPROVAL' || o.status === 'REJECTED' || o.status === 'APPROVAL_EXPIRED') expect(o.squareOrderId, o.id).toBeUndefined();
    }
  });

  it('executions follow the SPEC 2.3 capability mapping; sent dispatches have a provider ID', () => {
    for (const e of F.executions) {
      const cap = ACTION_TYPE_CAPABILITY[e.actionType];
      if (cap === null) expect(e.capabilityId, e.id).toBeUndefined();
      else expect(e.capabilityId, e.id).toBe(cap);
    }
    for (const d of F.messageDispatches) {
      if (d.status === 'SENT' || d.status === 'DELIVERED') {
        expect(d.providerMessageId, d.id).toBeDefined();
        expect(d.sentAt, d.id).toBeDefined();
      }
    }
  });

  it('demo data is fake: 555 phone numbers, sandbox payments', () => {
    const text = JSON.stringify(F);
    for (const phone of text.match(/\+1\d{10}/g) ?? []) expect(phone.slice(2, 5), phone).toBe('555');
    expect(F.integrationHealth.square.environment).toBe('sandbox');
    for (const c of F.orderCheckouts) expect(c.environment).toBe('sandbox');
    for (const e of F.allActivityEvents) {
      if (e.type === 'checkout.created' || e.type === 'payment.verified' || e.type === 'payment.failed') expect(e.payload.sandbox).toBe(true);
    }
  });

  it('activity payloads are redacted: no full phone numbers, no checkout URLs, no customer names', () => {
    const names = [...F.orders.map((o) => o.contact.name), ...F.bookings.map((b) => b.customer.name)];
    for (const e of F.allActivityEvents) {
      const p = JSON.stringify(e.payload);
      expect(p, e.id).not.toMatch(/\+\d{7,}/);
      expect(p, e.id).not.toMatch(/https?:\/\//);
      for (const n of names) expect(p, e.id).not.toContain(`"${n}"`);
    }
  });
});

describe('referential integrity', () => {
  const callIds = ids(F.calls);
  const orderIds = ids([...F.orders]);
  const bookingIds = ids(F.bookings);
  const approvalIds = ids(F.approvals);
  const executionIds = ids(F.executions);
  const dispatchIds = ids(F.messageDispatches);
  const factIds = ids(F.allFacts);
  const agentIds = ids(F.agents);
  const versionIds = ids(F.agentVersions);
  const businessIds = ids(F.businesses);
  const rowIds = ids(F.pizzaCatalogRows);
  const serviceIds = new Set(F.barberServices.map((s) => s.id));

  it('calls point at real agents and their versions', () => {
    for (const c of F.calls) {
      expect(businessIds.has(c.businessId)).toBe(true);
      const v = F.agentVersions.find((x) => x.id === c.agentVersionId);
      expect(v?.agentId, c.id).toBe(c.agentId);
      expect(F.agents.find((a) => a.id === c.agentId)?.businessId, c.id).toBe(c.businessId);
    }
  });

  it('orders and bookings point at calls, approvals and catalog or services', () => {
    for (const o of F.orders) {
      expect(callIds.has(o.callId), o.id).toBe(true);
      const a = F.approvals.find((x) => x.id === o.approvalId);
      expect(a?.subjectId, o.id).toBe(o.id);
      for (const l of o.cart.lines) {
        const item = F.pizzaCatalog.find((i) => i.squareItemId === l.catalogItemId);
        expect(item?.variations.some((v) => v.id === l.variationId), o.id).toBe(true);
        const modIds = new Set<string>(item?.modifierLists.flatMap((ml) => ml.modifiers.map((m) => m.id)));
        for (const m of l.modifierIds) expect(modIds.has(m), `${o.id} ${m}`).toBe(true);
      }
    }
    for (const b of F.bookings) {
      expect(b.callId !== undefined && callIds.has(b.callId), b.id).toBe(true);
      expect(serviceIds.has(b.serviceId), b.id).toBe(true);
      expect(F.approvals.find((x) => x.id === b.approvalId)?.subjectId, b.id).toBe(b.id);
    }
  });

  it('approval subjects resolve and payloads match their subject', () => {
    for (const a of F.approvals) {
      if (a.bundleType === 'order_bundle') {
        const o = F.orders.find((x) => x.id === a.subjectId);
        expect(o, a.id).toBeDefined();
        if (o === undefined) continue;
        const call = F.calls.find((c) => c.id === o.callId);
        expect(a.payload.agentVersionId).toBe(call?.agentVersionId);
        expect(a.payload.cartHash).toBe(o.cartHash);
        expect(a.payload.totalMinor).toBe(o.totalMinor);
        expect(a.payload.pickupAt).toBe(toCanonicalTimestamp(o.fulfillment.pickupAt));
        expect(a.payload.messageRecipient).toBe(o.contact.messageRecipient);
        expect(a.createdAt).toBe(o.createdAt);
      } else if (a.bundleType === 'booking_bundle') {
        const b = F.bookings.find((x) => x.id === a.subjectId);
        expect(b, a.id).toBeDefined();
        if (b === undefined) continue;
        expect(a.payload.agentVersionId).toBe(F.calls.find((c) => c.id === b.callId)?.agentVersionId);
        expect([a.payload.startUtc, a.payload.endUtc, a.payload.serviceId, a.payload.calendarId]).toEqual([toCanonicalTimestamp(b.startUtc), toCanonicalTimestamp(b.endUtc), b.serviceId, b.calendarId]);
        expect(a.payload.messageRecipient).toBe(b.customer.messageRecipient);
      } else if (a.bundleType === 'fact_edit') {
        expect(factIds.has(a.subjectId), a.id).toBe(true);
        const current = F.allFacts.find((f) => f.businessId === a.businessId && f.kind === a.payload.kind && f.key === a.payload.key && f.status === 'verified');
        expect(a.payload.before).toEqual(current?.value);
        expect(a.payload.fromVersion).toBe(current?.version);
      } else {
        expect(rowIds.has(a.subjectId), a.id).toBe(true);
        const row = F.pizzaCatalogRows.find((r) => r.id === a.subjectId);
        expect(a.payload.variationId).toBe(row?.squareVariationId);
        expect(a.payload.fromPriceMinor).toBe(row?.priceMinor);
      }
    }
  });

  it('executions, dispatches and checkouts resolve', () => {
    for (const e of F.executions) expect(approvalIds.has(e.approvalId), e.id).toBe(true);
    for (const d of F.messageDispatches) {
      expect(executionIds.has(d.executionId), d.id).toBe(true);
      expect(orderIds.has(d.subjectId) || bookingIds.has(d.subjectId), d.id).toBe(true);
    }
    for (const c of F.orderCheckouts) {
      expect(orderIds.has(c.orderId)).toBe(true);
      if (c.message !== undefined) expect(dispatchIds.has(c.message.id)).toBe(true);
    }
    // qr_only: the paid order has a SKIPPED message step and no dispatch.
    expect(F.messageDispatches.some((d) => d.subjectId === F.orderPaid.id)).toBe(false);
    expect(F.approvalOrderPaid.payload.messageChannel).toBe('qr_only');
  });

  it('facts, conflicts, files, agents, builder and live agent resolve', () => {
    for (const f of F.allFacts) if (f.fileId !== undefined) expect(F.files.some((x) => x.id === f.fileId), f.id).toBe(true);
    for (const f of F.allFacts) if (f.supersedesId !== undefined) expect(factIds.has(f.supersedesId), f.id).toBe(true);
    for (const c of F.factConflicts) {
      for (const cand of c.candidates) {
        if (cand.factId !== undefined) expect(factIds.has(cand.factId)).toBe(true);
        if (cand.sourceType === 'square') expect(rowIds.has(cand.sourceRef ?? '')).toBe(true);
      }
    }
    for (const file of F.files) {
      for (const id of file.draftFactIds ?? []) expect(factIds.has(id)).toBe(true);
      for (const id of file.conflictIds ?? []) expect(F.factConflicts.some((c) => c.id === id)).toBe(true);
    }
    for (const v of F.agentVersions) {
      expect(agentIds.has(v.agentId)).toBe(true);
      expect(v.spec.version).toBe(v.version);
      for (const ref of v.knowledgeSnapshotRef.facts) expect(factIds.has(ref.id), `${v.id} ${ref.id}`).toBe(true);
    }
    for (const a of F.agents) if (a.activeVersionId !== undefined) expect(versionIds.has(a.activeVersionId)).toBe(true);
    expect(F.agents.filter((a) => a.isLiveAgent).map((a) => a.id)).toEqual([F.liveAgent.agentId]);
    expect(versionIds.has(F.liveAgent.agentVersionId)).toBe(true);
    expect("agentId" in F.liveAgentEmpty).toBe(false);
    expect(agentIds.has(F.builderSession.agentId ?? '')).toBe(true);
    for (const m of F.builderSession.messages) expect(m.sessionId).toBe(F.builderSession.id);
    expect(approvalIds.has(F.builderTurn.proposedChange?.approvalId ?? '')).toBe(true);
  });
});

describe('scripted timelines', () => {
  const known = new Set<string>([
    ...F.calls.map((c) => c.id),
    ...F.orders.map((o) => o.id),
    ...F.bookings.map((b) => b.id),
    ...F.approvals.map((a) => a.id),
    ...F.executions.map((e) => e.id),
    ...F.messageDispatches.map((d) => d.id),
  ]);
  const refKeys = ['callId', 'orderId', 'bookingId', 'approvalId', 'executionId', 'dispatchId', 'subjectId'] as const;

  it('every entry is a valid event, offsets never go back, one correlationId, references resolve', () => {
    for (const t of F.timelines) {
      let last = -1;
      for (const { offsetMs, event } of t.entries) {
        parses(ActivityEventSchema, event, `${t.name} ${event.id}`);
        expect(offsetMs).toBeGreaterThanOrEqual(last);
        last = offsetMs;
        expect(event.correlationId).toBe(t.correlationId);
        expect(event.businessId).toBe(t.businessId);
        expect(ms(event.occurredAt) - ms(t.baseStartAt)).toBe(offsetMs);
        const p = event.payload as Record<string, unknown>;
        for (const k of refKeys) if (typeof p[k] === 'string') expect(known.has(p[k]), `${event.id}.${k}`).toBe(true);
      }
      expect(new Set(t.entries.map((e) => e.event.id)).size).toBe(t.entries.length);
    }
  });

  it('pizza: call.started through the Sheets sync, with every order state in order', () => {
    const types = F.pizzaOrderTimeline.entries.map((e) => e.event.type);
    expect(types[0]).toBe('call.started');
    expect(types.at(-1)).toBe('sync.succeeded');
    for (const t of ['proposal.created', 'approval.requested', 'approval.decided', 'execution.started', 'execution.succeeded', 'checkout.created', 'message.sent', 'payment.verified', 'sync.queued', 'call.ended']) {
      expect(types, t).toContain(t);
    }
    const tos = F.pizzaOrderTimeline.entries.flatMap((e) => (e.event.type === 'order.status_changed' ? [e.event.payload.to] : []));
    expect(tos).toEqual([
      'CALL_STARTED', 'COLLECTING', 'VALIDATING', 'CUSTOMER_CONFIRMED', 'AWAITING_OWNER_APPROVAL', 'APPROVED',
      'CREATING_CHECKOUT', 'PAYMENT_LINK_READY', 'MESSAGE_SENT', 'PAYMENT_PENDING', 'PAID_VERIFIED', 'FULFILLMENT_READY',
    ]);
    const changes = F.pizzaOrderTimeline.entries.flatMap((e) => (e.event.type === 'order.status_changed' ? [e.event.payload] : []));
    for (let i = 1; i < changes.length; i++) expect(changes[i]?.from).toBe(changes[i - 1]?.to);
    // Status timestamps match the order and its executions.
    const paid = F.pizzaOrderTimeline.entries.find((e) => e.event.type === 'order.status_changed' && e.event.payload.to === 'FULFILLMENT_READY');
    expect(paid?.event.occurredAt).toBe(F.orderFulfilled.updatedAt);
    const decided = F.pizzaOrderTimeline.entries.find((e) => e.event.type === 'approval.decided');
    expect(decided?.event.occurredAt).toBe(F.approvalOrderFulfilled.decidedAt);
  });

  it('booking: call to booking.verified; slot conflict variant ends in SLOT_CONFLICT', () => {
    const types = F.barberBookingTimeline.entries.map((e) => e.event.type);
    expect(types[0]).toBe('call.started');
    expect(types).toContain('booking.verified');
    const tos = F.barberBookingTimeline.entries.flatMap((e) => (e.event.type === 'booking.status_changed' ? [e.event.payload.to] : []));
    expect(tos).toEqual(['INQUIRY', 'SLOT_SEARCH', 'PROPOSAL', 'CUSTOMER_CONFIRMED', 'AWAITING_OWNER_APPROVAL', 'RECHECKING_SLOT', 'BOOKED_VERIFIED']);
    const verified = F.barberBookingTimeline.entries.find((e) => e.event.type === 'booking.verified');
    expect(verified?.event.type === 'booking.verified' && verified.event.payload.googleEventId).toBe(F.bookingVerified.googleEventId);

    const x = F.barberSlotConflictTimeline.entries.map((e) => e.event.type);
    expect(x).toContain('booking.slot_conflict');
    expect(x.at(-1)).toBe('execution.failed');
  });

  it('materializeTimeline moves occurredAt and payload times together', () => {
    const start = new Date('2026-12-01T10:00:00Z');
    const events = F.materializeTimeline(F.pizzaOrderTimeline, start);
    parsesAll(ActivityEventSchema, events, 'materialized');
    expect(events[0]?.occurredAt).toBe('2026-12-01T10:00:00Z');
    expect(events.at(-1)?.occurredAt).toBe('2026-12-01T10:06:34Z');
    const req = events.find((e) => e.type === 'approval.requested');
    if (req?.type !== 'approval.requested') throw new Error('missing approval.requested');
    expect(ms(req.payload.expiresAt) - ms(req.occurredAt)).toBe(APPROVAL_EXPIRY_MS);
    const kept = F.materializeTimeline(F.pizzaOrderTimeline, start, { shiftPayloadTimes: false });
    const keptReq = kept.find((e) => e.type === 'approval.requested');
    expect(keptReq?.type === 'approval.requested' && keptReq.payload.expiresAt).toBe(F.approvalOrderFulfilled.expiresAt);
    // The stored timeline is not changed.
    expect(F.pizzaOrderTimeline.entries[0]?.event.occurredAt).toBe('2026-11-14T19:00:00Z');
  });
});

describe('approval payloads hold exactly the material fields (CONTRACTS 4)', () => {
  const samples = [F.approvalOrderPending, F.approvalBookingPending, F.approvalFactEditPending, F.approvalPriceEditPending];

  it.each(samples.map((a) => [a.bundleType, a] as const))('%s: pickMaterialFields(payload) deep-equals payload, and the stored hash is the hash of the whole payload', async (bundleType, a) => {
    expect(pickMaterialFields(bundleType, a.payload)).toStrictEqual(a.payload);
    expect(Object.keys(a.payload).every((k) => (MATERIAL_FIELDS[bundleType] as readonly string[]).includes(k))).toBe(true);
    const whole = `sha256:${await sha256Hex(canonicalJson(a.payload))}`;
    expect(a.payloadHash).toBe(whole);
    expect(await approvalPayloadHash(bundleType, a.payload)).toBe(whole);
  });

  it('every fixture approval, all four bundle types: payload is its own projection and payloadHash covers all of it', async () => {
    expect(new Set(F.approvals.map((a) => a.bundleType)).size).toBe(4);
    for (const a of F.approvals) {
      expect(pickMaterialFields(a.bundleType, a.payload), a.id).toStrictEqual(a.payload);
      expect(a.payloadHash, a.id).toBe(await hashCanonical(a.payload));
      expect(a.payload, a.id).not.toHaveProperty('messageConsent');
    }
  });

  it.each(samples.map((a) => [a.bundleType, a] as const))('%s: the strict payload schema refuses an extra field', (_bundleType, a) => {
    const bad = { ...a, payload: { ...a.payload, callId: 'call_demo_04' } };
    expect(ApprovalRequestSchema.safeParse(bad).success).toBe(false);
    expect(ApprovalRequestSchema.safeParse(a).success).toBe(true);
  });

  it('payload timestamps are stored in toISOString() form', () => {
    for (const a of F.approvals) {
      const p = a.payload as Record<string, unknown>;
      for (const k of ['expiresAt', 'pickupAt', 'startUtc', 'endUtc']) {
        const v = p[k];
        if (typeof v === 'string') expect(v, `${a.id}.${k}`).toBe(toCanonicalTimestamp(v));
      }
    }
  });
});

describe('fixture timestamps and uniqueness', () => {
  it('every timestamp in every fixture uses the Z form', () => {
    const isoLike = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
    const bad: string[] = [];
    const walk = (v: unknown, path: string): void => {
      if (typeof v === 'string') {
        if (isoLike.test(v) && !F.ISO_UTC_PATTERN.test(v)) bad.push(`${path}=${v}`);
      } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    };
    for (const [name, value] of Object.entries(F)) if (typeof value !== 'function') walk(value, name);
    expect(bad).toEqual([]);
  });

  it('no two orders share (businessId, cartHash, callId), the orders unique index', () => {
    const keys = F.orders.map((o) => `${o.businessId}|${o.cartHash}|${o.callId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('the QR-only order has its own call, cart hash and quote', () => {
    const others = F.orders.filter((o) => o.id !== F.orderQrOnly.id);
    expect(others.some((o) => o.callId === F.orderQrOnly.callId)).toBe(false);
    expect(others.some((o) => o.cartHash === F.orderQrOnly.cartHash)).toBe(false);
    expect(others.some((o) => o.quote.quoteId === F.orderQrOnly.quote.quoteId)).toBe(false);
    expect(F.calls.some((c) => c.id === F.orderQrOnly.callId)).toBe(true);
  });

  it('only whatsapp_sandbox dispatches are DELIVERED', () => {
    for (const d of F.messageDispatches) if (d.channel !== 'whatsapp_sandbox') expect(d.status, d.id).not.toBe('DELIVERED');
    expect(F.messageDispatches.find((d) => d.id === 'msg_demo_01')?.status).toBe('SENT');
    expect(F.messageDispatches.find((d) => d.id === 'msg_demo_07')?.status).toBe('SENT');
  });
});

/** Parses every collection of a world and checks every stored hash and key against a recomputed one. */
async function checkWorld(W: FixtureWorld): Promise<void> {
  parsesAll(BusinessSchema, W.businesses, 'businesses');
  parsesAll(BusinessFactSchema, W.allFacts, 'facts');
  parsesAll(FactConflictSchema, [...W.factConflicts, W.menuPriceConflictResolved], 'conflicts');
  parsesAll(FileRecordSchema, W.files, 'files');
  parsesAll(ServiceOfferingSchema, W.barberServices, 'services');
  parsesAll(CatalogItemSchema, W.pizzaCatalog, 'catalog');
  parsesAll(AgentSpecSchema, [W.pizzaSpecV1, W.pizzaSpecV2, W.barberSpecV1], 'specs');
  parsesAll(AgentVersionSchema, W.agentVersions, 'versions');
  parsesAll(AgentSchema, W.agents, 'agents');
  parsesAll(CallSchema, W.calls, 'calls');
  parsesAll(LiveAgentSchema, [W.liveAgent, W.liveAgentBarber, W.liveAgentEmpty], 'liveAgent');
  parsesAll(BuilderSessionSchema, [W.builderSession, W.builderSessionNew], 'builder');
  parsesAll(OrderSchema, [...W.orders, W.orderCancelled], 'orders');
  parsesAll(BookingSchema, W.bookings, 'bookings');
  parsesAll(ApprovalRequestSchema, [...W.approvals, ...W.pendingApprovals], 'approvals');
  parsesAll(ActionExecutionSchema, W.executions, 'executions');
  parsesAll(MessageDispatchSchema, W.messageDispatches, 'dispatches');
  parsesAll(SyncJobSchema, W.syncJobs, 'sync jobs');
  parses(IntegrationHealthSchema, W.integrationHealthDisconnected, 'disconnected health');
  parses(IntegrationHealthSchema, W.integrationHealth, 'health');
  parsesAll(OrderCheckoutSchema, W.orderCheckouts, 'checkouts');
  parsesAll(ActivityEventSchema, W.allActivityEvents, 'activity');
  for (const t of W.timelines) {
    for (const { offsetMs, event } of t.entries) {
      parses(ActivityEventSchema, event, `${t.name} ${event.id}`);
      expect(ms(event.occurredAt) - ms(t.baseStartAt)).toBe(offsetMs);
    }
  }
  for (const name of Object.keys(ENDPOINTS) as EndpointName[]) parses(ENDPOINTS[name].response, W.fixtureResponses[name], `fixtureResponses.${name}`);

  for (const o of [...W.orders, W.orderCancelled]) {
    const h = await cartHash(o.cart);
    expect(o.cartHash, o.id).toBe(h);
    expect(o.quote.cartHash, o.id).toBe(h);
  }
  const allApprovals = [
    ...W.approvals,
    ...W.pendingApprovals,
    ...W.fixtureResponses.listApprovals.items,
    W.fixtureResponses.getApproval,
    W.fixtureResponses.proposeFact.approval,
    W.fixtureResponses.proposePrice.approval,
  ];
  for (const a of allApprovals) {
    expect(a.payloadHash, a.id).toBe(await hashCanonical(a.payload));
    expect(a.payloadHash, a.id).toBe(await approvalPayloadHash(a.bundleType, a.payload));
  }
  const byId = new Map(W.approvals.map((a) => [a.id, a]));
  for (const e of W.executions) {
    const a = byId.get(e.approvalId);
    expect(a, e.id).toBeDefined();
    expect(e.idempotencyKey, e.id).toBe(await idempotencyKey({ businessId: e.businessId, subjectId: a?.subjectId ?? '', actionType: e.actionType, approvalId: e.approvalId }));
  }
  for (const d of W.messageDispatches) expect(d.idempotencyKey).toBe(W.executions.find((e) => e.id === d.executionId)?.idempotencyKey);
  expect(W.bookingVerified.googleEventId).toBe(W.executions.find((e) => e.id === 'exe_demo_b02_0')?.idempotencyKey);
}

describe('materializeFixtures', () => {
  it('the unshifted fixtures pass the same checks', async () => {
    await checkWorld(F as unknown as FixtureWorld);
  });

  const times = [
    ['the real current time', new Date()],
    ['a time across the March 2027 daylight saving change', new Date('2027-03-14T18:00:00Z')],
    ['a time far in the future', new Date('2099-06-30T23:59:59.250Z')],
    ['late at night', new Date('2026-11-15T07:59:00Z')],
    ['Sunday', new Date('2026-11-15T20:00:00Z')],
    ['before spring daylight saving', new Date('2027-03-14T09:59:00Z')],
    ['after fall daylight saving', new Date('2026-11-01T09:01:00Z')],
  ] as const;

  it.each(times)('at %s: every object parses, every hash is real, PENDING approvals are live, the original is untouched', async (_label, now) => {
    const before = JSON.stringify(F);
    const W = await materializeFixtures(now);
    expect(JSON.stringify(F)).toBe(before);

    expect(ms(W.FIXTURE_NOW)).toBe(now.getTime());
    await checkWorld(W);

    const delta = now.getTime() - ms(F.FIXTURE_NOW);
    expect(ms(W.orderAwaitingApproval.createdAt) - ms(F.orderAwaitingApproval.createdAt)).toBe(delta);
    expect(ms(W.pizzaOrderTimeline.baseStartAt) - ms(F.pizzaOrderTimeline.baseStartAt)).toBe(delta);

    expect(W.pendingApprovals.length).toBe(F.pendingApprovals.length);
    expect(W.pendingApprovals.length).toBeGreaterThan(0);
    for (const a of W.pendingApprovals) {
      expect(a.state).toBe('PENDING');
      expect(ms(a.expiresAt), a.id).toBeGreaterThan(now.getTime());
      expect(ms(a.createdAt), a.id).toBeLessThanOrEqual(now.getTime());
      expect(a.payload.expiresAt, a.id).toBe(toCanonicalTimestamp(a.payload.expiresAt));
    }
    // A payload timestamp moved, so the hash moved with it.
    expect(W.approvalOrderPending.payloadHash).not.toBe(F.approvalOrderPending.payloadHash);
    expect(W.approvalOrderPending).not.toBe(F.approvalOrderPending);
  });

  it('the demo appointment date follows the shifted booking', async () => {
    const W = await materializeFixtures(new Date('2027-03-14T18:00:00Z'));
    expect(W.BOOKING_DEMO_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(W.BOOKING_DEMO_DATE).not.toBe(F.BOOKING_DEMO_DATE);
  });

  it('shiftTimeline gives the same timeline as the world shift', async () => {
    const W = await materializeFixtures(new Date('2027-01-05T09:00:00Z'));
    expect(F.shiftTimeline(F.pizzaOrderTimeline, new Date(W.pizzaOrderTimeline.baseStartAt))).toEqual(W.pizzaOrderTimeline);
  });
});
