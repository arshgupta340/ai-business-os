// Cross-field rules (review of PR #61): each test changes one field on its own and expects a failure.
import { describe, expect, it } from 'vitest';
import {
  ActionExecutionSchema,
  ApprovalRequestSchema,
  AvailabilitySlotSchema,
  BookingApprovalRequestSchema,
  BookingSchema,
  BusinessFactSchema,
  CallSchema,
  FactConflictSchema,
  FactEditApprovalRequestSchema,
  MessageDispatchSchema,
  OrderApprovalRequestSchema,
  OrderBaseSchema,
  OrderSchema,
  PriceEditApprovalRequestSchema,
  QuoteSchema,
  isServerOnlyTransition,
} from './index';

const H1 = `sha256:${'a1'.repeat(32)}`;
const H2 = `sha256:${'b2'.repeat(32)}`;
const fails = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) => expect(schema.safeParse(v).success).toBe(false);
const passes = (schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } }, v: unknown) => {
  const r = schema.safeParse(v);
  expect(r.success, JSON.stringify(r.error)).toBe(true);
};

const quote = { quoteId: 'qte_1', cartHash: H1, subtotalMinor: 3000, taxMinor: 264, totalMinor: 3264, currency: 'USD', lines: [], quotedAt: '2026-11-13T19:40:00Z', expiresAt: '2026-11-13T19:45:00Z' };
const order = {
  id: 'ord_123', businessId: 'biz_pizza_01', callId: 'call_77', status: 'AWAITING_OWNER_APPROVAL', totalMinor: 3264, currency: 'USD',
  cart: { lines: [ { catalogItemId: 'SQ_ITEM_PEP', variationId: 'SQ_VAR_PEP_LG', quantity: 2, modifierIds: [] } ] }, cartHash: H1, quote,
  contact: { name: 'Sam', messageRecipient: '+15555550123', messageConsent: true, consentAt: '2026-11-13T19:41:00Z' },
  fulfillment: { type: 'pickup', pickupAt: '2026-11-14T02:00:00Z' }, createdAt: '2026-11-13T19:42:00Z', updatedAt: '2026-11-13T19:42:00Z',
};

describe('Order (SPEC 2.9 order totals)', () => {
  it('accepts a consistent order', () => passes(OrderSchema, order));
  it('rejects totalMinor different from the quote', () => fails(OrderSchema, { ...order, totalMinor: 1 }));
  it('rejects currency different from the quote', () => fails(OrderSchema, { ...order, quote: { ...quote, currency: 'EUR' } }));
  it('rejects cartHash different from the quote', () => fails(OrderSchema, { ...order, cartHash: H2 }));
  it('rejects a link status without Square references, and a paid status without the payment id', () => {
    fails(OrderSchema, { ...order, status: 'PAYMENT_PENDING' });
    const linked = { ...order, squareOrderId: 'SQ_ORD_9', squarePaymentLinkId: 'SQ_PL_4', checkoutUrl: 'https://sandbox.square.link/u/abc' };
    passes(OrderSchema, { ...linked, status: 'PAYMENT_PENDING' });
    fails(OrderSchema, { ...linked, status: 'PAID_VERIFIED' });
    passes(OrderSchema, { ...linked, status: 'PAID_VERIFIED', squarePaymentId: 'SQ_PAY_1' });
  });
  it('keeps a base object schema that can be picked and extended', () => {
    expect(OrderBaseSchema.pick({ id: true, status: true }).safeParse({ id: 'ord_1', status: 'APPROVED' }).success).toBe(true);
    expect(OrderBaseSchema.safeParse({ ...order, totalMinor: 1 }).success).toBe(true);
  });
});

describe('Quote', () => {
  it('rejects subtotal + tax != total, and an expiry other than 5 minutes', () => {
    passes(QuoteSchema, quote);
    fails(QuoteSchema, { ...quote, taxMinor: 265 });
    fails(QuoteSchema, { ...quote, expiresAt: '2026-11-13T19:50:00Z' });
  });
});

describe('Booking and slots', () => {
  const booking = {
    id: 'bkg_12', businessId: 'biz_barber_01', callId: 'call_80', status: 'AWAITING_OWNER_APPROVAL', serviceId: 'svc_cut', serviceName: 'Haircut',
    calendarId: 'demo-barber@group.calendar.google.com', startUtc: '2026-11-14T18:00:00Z', endUtc: '2026-11-14T18:30:00Z', timezone: 'America/Los_Angeles',
    customer: { name: 'Ana', messageRecipient: '+15555550124', messageConsent: true }, createdAt: '2026-11-13T20:00:00Z', updatedAt: '2026-11-13T20:00:00Z',
  };
  it('rejects endUtc not after startUtc', () => {
    passes(BookingSchema, booking);
    fails(BookingSchema, { ...booking, endUtc: booking.startUtc });
    fails(AvailabilitySlotSchema, { serviceId: 'svc_cut', startUtc: '2026-11-14T18:30:00Z', endUtc: '2026-11-14T18:00:00Z', timezone: 'America/Los_Angeles' });
  });
  it('rejects BOOKED_VERIFIED without googleEventId', () => {
    fails(BookingSchema, { ...booking, status: 'BOOKED_VERIFIED' });
    passes(BookingSchema, { ...booking, status: 'BOOKED_VERIFIED', googleEventId: 'ev1' });
  });
});

// One valid request per bundle type, created at 20:00, expiring at 20:10.
const createdAt = '2026-11-13T20:00:00Z';
const expiresAt = '2026-11-13T20:10:00Z';
const requests = {
  order_bundle: {
    schema: OrderApprovalRequestSchema,
    value: { id: 'apv_1', businessId: 'biz_pizza_01', actorType: 'deployed_agent', bundleType: 'order_bundle', subjectId: 'ord_A',
      actionBundle: ['square.checkout.create', 'message.checkout.send', 'local.order.record', 'sheets.order.append'],
      payload: { businessId: 'biz_pizza_01', subjectId: 'ord_A', agentVersionId: 'agv_pizza_01_v2', cartHash: H1, totalMinor: 3264, currency: 'USD',
        pickupAt: '2026-11-14T02:00:00Z', messageRecipient: '+15555550123', messageChannel: 'qr_only',
        actionBundle: ['square.checkout.create', 'message.checkout.send', 'local.order.record', 'sheets.order.append'], expiresAt },
      payloadHash: H2, state: 'PENDING', expiresAt, createdAt },
    otherSubject: 'ord_B',
  },
  booking_bundle: {
    schema: BookingApprovalRequestSchema,
    value: { id: 'apv_2', businessId: 'biz_barber_01', actorType: 'deployed_agent', bundleType: 'booking_bundle', subjectId: 'bkg_A',
      actionBundle: ['calendar.event.create', 'message.booking.confirm', 'local.booking.record', 'sheets.booking.append'],
      payload: { businessId: 'biz_barber_01', subjectId: 'bkg_A', agentVersionId: 'agv_barber_01_v1', serviceId: 'svc_cut', calendarId: 'cal1',
        startUtc: '2026-11-14T18:00:00Z', endUtc: '2026-11-14T18:30:00Z', timezone: 'America/Los_Angeles', messageRecipient: '+15555550124', messageChannel: 'surge',
        actionBundle: ['calendar.event.create', 'message.booking.confirm', 'local.booking.record', 'sheets.booking.append'], expiresAt },
      payloadHash: H2, state: 'PENDING', expiresAt, createdAt },
    otherSubject: 'bkg_B',
  },
  fact_edit: {
    schema: FactEditApprovalRequestSchema,
    value: { id: 'apv_3', businessId: 'biz_pizza_01', actorType: 'owner', bundleType: 'fact_edit', subjectId: 'fact_A', actionBundle: ['local.fact.update'],
      payload: { businessId: 'biz_pizza_01', subjectId: 'fact_A', kind: 'hours', key: 'fri', fromVersion: 1, before: { open: '11:00', close: '22:00' },
        after: { open: '11:00', close: '23:00' }, actionBundle: ['local.fact.update'], expiresAt },
      payloadHash: H2, state: 'PENDING', expiresAt, createdAt },
    otherSubject: 'fact_B',
  },
  price_edit: {
    schema: PriceEditApprovalRequestSchema,
    value: { id: 'apv_4', businessId: 'biz_pizza_01', actorType: 'owner', bundleType: 'price_edit', subjectId: 'cat_A',
      actionBundle: ['square.catalog.price.update', 'local.catalog.sync'],
      payload: { businessId: 'biz_pizza_01', subjectId: 'cat_A', squareItemId: 'SQ_ITEM_PEP', variationId: 'SQ_VAR_PEP_LG', fromPriceMinor: 2200, newPriceMinor: 1900,
        currency: 'USD', squareVersion: 7, actionBundle: ['square.catalog.price.update', 'local.catalog.sync'], expiresAt },
      payloadHash: H2, state: 'PENDING', expiresAt, createdAt },
    otherSubject: 'cat_B',
  },
} as const;

describe('ApprovalRequest: outer copies equal the payload, expiry is 10 minutes', () => {
  for (const [bundleType, { schema, value, otherSubject }] of Object.entries(requests)) {
    describe(bundleType, () => {
      it('accepts the consistent request, also through the union', () => {
        passes(schema, value);
        passes(ApprovalRequestSchema, value);
      });
      it('rejects a different outer businessId', () => fails(ApprovalRequestSchema, { ...value, businessId: 'biz_other_01' }));
      it('rejects a different outer subjectId', () => fails(ApprovalRequestSchema, { ...value, subjectId: otherSubject }));
      it('rejects a different outer expiresAt', () => fails(ApprovalRequestSchema, { ...value, expiresAt: '2026-11-13T20:11:00Z' }));
      it('rejects a different outer actionBundle', () => {
        const bundle = [...value.actionBundle];
        if (bundle.length > 1) {
          [bundle[0], bundle[1]] = [bundle[1]!, bundle[0]!];
          fails(ApprovalRequestSchema, { ...value, actionBundle: bundle });
        } else {
          fails(ApprovalRequestSchema, { ...value, actionBundle: [...bundle, ...bundle] });
        }
      });
      it('rejects an expiry that is not createdAt plus 10 minutes, even when both copies agree', () => {
        const later = '2026-11-14T20:00:00Z';
        fails(ApprovalRequestSchema, { ...value, expiresAt: later, payload: { ...value.payload, expiresAt: later } });
      });
    });
  }

  it('rejects a payloadHash without the sha256: form', () => {
    fails(ApprovalRequestSchema, { ...requests.fact_edit.value, payloadHash: 'a1'.repeat(32) });
    fails(ApprovalRequestSchema, { ...requests.fact_edit.value, payloadHash: 'sha256:9c1e...' });
  });

  it('decision fields follow the state', () => {
    const v = requests.order_bundle.value;
    fails(ApprovalRequestSchema, { ...v, state: 'APPROVED' });
    passes(ApprovalRequestSchema, { ...v, state: 'APPROVED', decidedBy: 'usr_owner_01', decidedAt: '2026-11-13T20:01:00Z' });
    passes(ApprovalRequestSchema, { ...v, state: 'EXPIRED', decidedAt: '2026-11-13T20:10:30Z' });
    fails(ApprovalRequestSchema, { ...v, decidedAt: '2026-11-13T20:01:00Z' });
  });

  it('rejects a booking payload whose end is not after its start', () => {
    const v = requests.booking_bundle.value;
    fails(ApprovalRequestSchema, { ...v, payload: { ...v.payload, endUtc: v.payload.startUtc } });
  });
});

describe('other database checks', () => {
  it('BusinessFact: verifiedAt absent exactly for drafts', () => {
    const fact = { id: 'fact_1', businessId: 'biz_pizza_01', kind: 'hours', key: 'fri', value: { closed: true }, sourceType: 'upload', fileId: 'file_1',
      status: 'draft', confidence: 0.8, version: 1, createdAt: createdAt, updatedAt: createdAt };
    passes(BusinessFactSchema, fact);
    fails(BusinessFactSchema, { ...fact, verifiedAt: createdAt });
    fails(BusinessFactSchema, { ...fact, status: 'verified' });
  });
  it('FactConflict: resolvedAt and resolvedBy present exactly when resolved', () => {
    const c = { id: 'cfl_1', businessId: 'biz_pizza_01', kind: 'policy', key: 'pickup_window', required: true, state: 'open',
      candidates: [ { sourceType: 'upload', value: 1 }, { sourceType: 'seed', value: 2 } ], createdAt };
    passes(FactConflictSchema, c);
    fails(FactConflictSchema, { ...c, state: 'resolved' });
    fails(FactConflictSchema, { ...c, resolvedBy: 'usr_owner_01', resolvedAt: createdAt });
  });
  it('Call: CallSid only on phone, endedAt only once ended, endReason matches status', () => {
    const c = { id: 'call_1', businessId: 'biz_pizza_01', agentId: 'agt_pizza_01', agentVersionId: 'agv_pizza_01_v1', channel: 'test_console', stage: 'CALL_STARTED',
      status: 'IN_PROGRESS', startedAt: createdAt };
    passes(CallSchema, c);
    fails(CallSchema, { ...c, providerCallId: 'CA1' });
    fails(CallSchema, { ...c, channel: 'phone' });
    fails(CallSchema, { ...c, status: 'COMPLETED' });
    passes(CallSchema, { ...c, status: 'COMPLETED', endReason: 'completed', endedAt: expiresAt });
    fails(CallSchema, { ...c, status: 'COMPLETED', endReason: 'dropped', endedAt: expiresAt });
    fails(CallSchema, { ...c, status: 'COMPLETED', endedAt: '2026-11-13T19:00:00Z' });
  });
  it('ActionExecution: capabilityId follows the action type', () => {
    const e = { id: 'exe_1', businessId: 'biz_pizza_01', approvalId: 'apv_1', actionType: 'square.checkout.create', stepIndex: 0, capabilityId: 'order.checkout.prepare',
      idempotencyKey: 'ab'.repeat(32), status: 'QUEUED', attempts: 0, createdAt, updatedAt: createdAt };
    passes(ActionExecutionSchema, e);
    fails(ActionExecutionSchema, { ...e, capabilityId: 'message.checkout.send' });
    fails(ActionExecutionSchema, { ...e, capabilityId: undefined });
    passes(ActionExecutionSchema, { ...e, actionType: 'local.order.record', stepIndex: 2, capabilityId: undefined });
    fails(ActionExecutionSchema, { ...e, actionType: 'local.order.record', stepIndex: 2 });
  });
  it('MessageDispatch: SENT and DELIVERED need providerMessageId', () => {
    const m = { id: 'msg_1', businessId: 'biz_pizza_01', executionId: 'exe_2', subjectId: 'ord_1', channel: 'surge', recipient: '+15555550123',
      template: 'checkout_link', status: 'QUEUED', idempotencyKey: 'cd'.repeat(32), createdAt, updatedAt: createdAt };
    passes(MessageDispatchSchema, m);
    fails(MessageDispatchSchema, { ...m, status: 'SENT' });
    passes(MessageDispatchSchema, { ...m, status: 'SENT', providerMessageId: 'p1', sentAt: createdAt });
  });
});

describe('server-only transitions from the review', () => {
  it('marks the three provider-derived failures', () => {
    expect(isServerOnlyTransition('booking', 'RECHECKING_SLOT', 'SLOT_CONFLICT')).toBe(true);
    expect(isServerOnlyTransition('messageDispatch', 'QUEUED', 'FAILED')).toBe(true);
    expect(isServerOnlyTransition('messageDispatch', 'SENT', 'FAILED')).toBe(true);
  });
});
