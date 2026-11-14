import { describe, expect, it } from 'vitest';
import { BookingCustomerSchema, ContactSchema, OrderSchema, BookingSchema, TOOL_INPUT_SCHEMAS, OrderApprovalPayloadSchema, BookingApprovalPayloadSchema, approvalPayloadHash, payloadHash, canonicalJson, hashCanonical, pickMaterialFields, ActivityEventSchema } from './index';
import { orderAwaitingApproval, bookingAwaitingApproval, approvalOrderPending, approvalBookingPending, approvalOrderQrOnly, orderQrOnly } from '../fixtures';

describe('message consent', () => {
  const contact = { name: 'Sam', messageConsent: false };
  for (const [name, parse] of [
    ['contact', (v: unknown) => ContactSchema.safeParse(v)],
    ['customer', (v: unknown) => BookingCustomerSchema.safeParse(v)],
    ['order', (v: unknown) => OrderSchema.safeParse({ ...orderAwaitingApproval, contact: v })],
    ['booking', (v: unknown) => BookingSchema.safeParse({ ...bookingAwaitingApproval, customer: v })],
    ['propose_order', (v: unknown) => TOOL_INPUT_SCHEMAS.propose_order.safeParse({ cart: orderAwaitingApproval.cart, contact: v, fulfillment: orderAwaitingApproval.fulfillment, quoteId: orderAwaitingApproval.quote.quoteId })],
    ['propose_booking', (v: unknown) => TOOL_INPUT_SCHEMAS.propose_booking.safeParse({ serviceId: bookingAwaitingApproval.serviceId, startUtc: bookingAwaitingApproval.startUtc, customer: v })],
  ] as const) {
    describe(name, () => {
      it('accepts declined messages without a recipient', () => expect(parse(contact).success).toBe(true));
      it('requires a recipient for consent', () => expect(parse({ ...contact, messageConsent: true, consentAt: orderAwaitingApproval.createdAt }).success).toBe(false));
      it('refuses a recipient without consent', () => expect(parse({ ...contact, messageRecipient: '+15555550123' }).success).toBe(false));
      it('requires E.164 when consented', () => expect(parse({ ...contact, messageConsent: true, messageRecipient: '123', consentAt: orderAwaitingApproval.createdAt }).success).toBe(false));
    });
  }
  it('requires consentAt on a consenting order contact', () => {
    expect(ContactSchema.safeParse({ name: 'Sam', messageConsent: true, messageRecipient: '+15555550123' }).success).toBe(false);
  });
  for (const [schema, approval] of [[OrderApprovalPayloadSchema, approvalOrderPending], [BookingApprovalPayloadSchema, approvalBookingPending]] as const) {
    const { messageRecipient: _recipient, ...payload } = approval.payload;
    it(`${approval.bundleType}: accepts qr_only without a recipient`, () => {
      expect(schema.safeParse({ ...payload, messageChannel: 'qr_only' }).success).toBe(true);
    });
    it(`${approval.bundleType}: accepts qr_only with a recipient`, () => {
      expect(schema.safeParse({ ...approval.payload, messageChannel: 'qr_only' }).success).toBe(true);
    });
    it(`${approval.bundleType}: requires a recipient for any channel other than qr_only`, () => {
      for (const messageChannel of ['surge', 'android_gateway', 'whatsapp_sandbox']) {
        expect(schema.safeParse({ ...payload, messageChannel }).success, messageChannel).toBe(false);
      }
    });
    it(`${approval.bundleType}: refuses messageConsent, which is not a material field`, () => {
      expect(schema.safeParse({ ...payload, messageChannel: 'qr_only', messageConsent: false }).success).toBe(false);
      expect(schema.safeParse({ ...approval.payload, messageConsent: true }).success).toBe(false);
    });
  }
  it('hashes a qr_only order identically with an absent or undefined recipient', async () => {
    const { messageRecipient: _recipient, ...payload } = approvalOrderPending.payload;
    const source = { ...payload, messageChannel: 'qr_only' };
    const picked = pickMaterialFields('order_bundle', source);
    expect(picked).not.toHaveProperty('messageRecipient');
    expect(canonicalJson(picked)).not.toContain('messageRecipient');
    const hash = await approvalPayloadHash('order_bundle', source);
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await approvalPayloadHash('order_bundle', { messageRecipient: undefined, ...source })).toBe(hash);
    expect(await approvalPayloadHash('order_bundle', JSON.parse(JSON.stringify(source)))).toBe(hash);
    expect(await approvalPayloadHash('order_bundle', { ...source, totalMinor: source.totalMinor + 1 })).not.toBe(hash);
    expect(await payloadHash(OrderApprovalPayloadSchema.parse(source))).toBe(hash);
    expect(() => pickMaterialFields('order_bundle', { ...source, messageChannel: 'surge' })).toThrow();
  });
  it('the declined-consent fixture: qr_only, no recipient, consent kept on the order contact only', async () => {
    expect(orderQrOnly.contact).toEqual({ name: orderQrOnly.contact.name, messageConsent: false });
    expect(approvalOrderQrOnly.payload.messageChannel).toBe('qr_only');
    expect(approvalOrderQrOnly.payload).not.toHaveProperty('messageRecipient');
    expect(approvalOrderQrOnly.payload).not.toHaveProperty('messageConsent');
    expect(approvalOrderQrOnly.payloadHash).toBe(await hashCanonical(approvalOrderQrOnly.payload));
  });
});

describe('guardrail refusal context', () => {
  const event = { id: 'evt_refusal', businessId: 'biz_pizza_01', correlationId: 'apv_1', actorType: 'system', occurredAt: '2026-11-14T19:00:00Z', type: 'guardrail.refused' };
  it.each([{ callId: 'call_1' }, {}, { executionId: 'exe_1', approvalId: 'apv_1' }])('accepts refusal context %j', (context) => {
    const payload = { ...context, rule: 'no_approval_bypass', reasonCode: 'approval_missing' };
    expect(ActivityEventSchema.parse({ ...event, payload }).payload).toEqual(payload);
  });
  it.each([undefined, '', 'not a machine code', 'x'.repeat(65)])('rejects invalid reasonCode %j', (reasonCode) => {
    expect(ActivityEventSchema.safeParse({ ...event, payload: { rule: 'no_approval_bypass', reasonCode } }).success).toBe(false);
  });
});
