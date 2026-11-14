import {describe, expect, it} from 'vitest';
import type {ActivityEvent, Booking, Call, Order} from '@/lib/api';
import {deriveJourney, groupByCall, mergeEvents, rejectedWebhooks, syncFromEvents, syncStatusView} from './journey';
import {messageCopy} from './CheckoutPanel';
import {qrPath} from './QrCode';

const T0 = Date.parse('2026-11-14T18:00:00Z');
let n = 0;
function ev(type: ActivityEvent['type'], payload: Record<string, unknown>, correlationId = 'call_1', at?: number): ActivityEvent {
  n += 1;
  return {
    id: `evt_${String(n).padStart(4, '0')}`,
    businessId: 'biz_pizza_01',
    type,
    correlationId,
    actorType: 'system',
    occurredAt: new Date(at ?? T0 + n * 1000).toISOString(),
    payload,
  };
}

const call = (over: Partial<Call> = {}): Call => ({
  id: 'call_1',
  businessId: 'biz_pizza_01',
  agentId: 'agt_pizza_01',
  agentVersionId: 'agv_1',
  channel: 'phone',
  stage: 'CUSTOMER_CONFIRMED',
  status: 'COMPLETED',
  endReason: 'completed',
  callerLast4: '0123',
  startedAt: new Date(T0).toISOString(),
  endedAt: new Date(T0 + 60_000).toISOString(),
  ...over,
});

const order = (status: Order['status'], over: Partial<Order> = {}): Order => ({
  id: 'ord_1',
  businessId: 'biz_pizza_01',
  callId: 'call_1',
  status,
  cart: {lines: []},
  cartHash: 'h',
  quote: {
    quoteId: 'qte_1',
    cartHash: 'h',
    subtotalMinor: 4350,
    taxMinor: 381,
    totalMinor: 4731,
    currency: 'USD',
    lines: [],
    quotedAt: new Date(T0).toISOString(),
    expiresAt: new Date(T0 + 300_000).toISOString(),
  },
  totalMinor: 4731,
  currency: 'USD',
  contact: {name: 'Sam', messageRecipient: '+15555550123', messageConsent: true, consentAt: new Date(T0).toISOString()},
  fulfillment: {type: 'pickup', pickupAt: new Date(T0 + 1_800_000).toISOString()},
  approvalId: 'apv_1',
  createdAt: new Date(T0).toISOString(),
  updatedAt: new Date(T0).toISOString(),
  ...over,
});

const booking = (status: Booking['status'], over: Partial<Booking> = {}): Booking => ({
  id: 'bkg_1',
  businessId: 'biz_barber_01',
  callId: 'call_1',
  status,
  serviceId: 'svc_cut',
  serviceName: 'Haircut',
  startUtc: new Date(T0 + 86_400_000).toISOString(),
  endUtc: new Date(T0 + 86_400_000 + 1_800_000).toISOString(),
  timezone: 'America/Los_Angeles',
  calendarId: 'cal',
  customer: {name: 'Ana', messageRecipient: '+15555550124', messageConsent: true},
  approvalId: 'apv_b',
  createdAt: new Date(T0).toISOString(),
  updatedAt: new Date(T0).toISOString(),
  ...over,
});

const proposal = () => [
  ev('call.started', {callId: 'call_1', agentId: 'agt_pizza_01', agentVersionId: 'agv_1', channel: 'phone', callerLast4: '0123'}),
  ev('proposal.created', {subjectId: 'ord_1', subjectType: 'order', callId: 'call_1', totalMinor: 4731, currency: 'USD'}),
  ev('approval.requested', {
    approvalId: 'apv_1',
    bundleType: 'order_bundle',
    subjectId: 'ord_1',
    actionBundle: ['square.checkout.create', 'message.checkout.send', 'local.order.record', 'sheets.order.append'],
    expiresAt: new Date(T0 + 600_000).toISOString(),
    totalMinor: 4731,
    recipientLast4: '0123',
  }),
];
const approved = () => [
  ...proposal(),
  ev('approval.decided', {approvalId: 'apv_1', subjectId: 'ord_1', decision: 'APPROVED', decidedBy: 'usr'}),
  ev('execution.started', {executionId: 'exe_1', approvalId: 'apv_1', actionType: 'square.checkout.create', stepIndex: 0, attempt: 1}),
  ev('checkout.created', {orderId: 'ord_1', squareOrderId: 'SQ', squarePaymentLinkId: 'PL', totalMinor: 4731, currency: 'USD', sandbox: true}),
  ev('execution.succeeded', {executionId: 'exe_1', actionType: 'square.checkout.create', externalRef: 'PL'}),
  ev('execution.started', {executionId: 'exe_2', approvalId: 'apv_1', actionType: 'message.checkout.send', stepIndex: 1, attempt: 1}),
  ev('message.sent', {dispatchId: 'msg_1', subjectId: 'ord_1', channel: 'surge', template: 'checkout_link', recipientLast4: '0123'}),
  ev('execution.succeeded', {executionId: 'exe_2', actionType: 'message.checkout.send'}),
];
const verified = () => ev('payment.verified', {orderId: 'ord_1', squarePaymentId: 'SQ_PAY', amountMinor: 4731, currency: 'USD', sandbox: true});

describe('grouping', () => {
  it('merges lists, drops duplicates and keeps the written order for equal times', () => {
    const a = ev('call.started', {}, 'call_1', T0);
    const b = ev('call.ended', {}, 'call_1', T0);
    const c = ev('proposal.created', {}, 'call_1', T0 + 5);
    // Lists come newest first, as the API and the feed return them.
    const merged = mergeEvents([b, a], [c, b]);
    expect(merged.map((e) => e.id)).toEqual([a.id, b.id, c.id]);
  });

  it('groups by call and leaves out fact edits and webhooks', () => {
    const events = [
      ev('call.started', {}, 'call_1'),
      ev('call.started', {}, 'call_2'),
      ev('approval.requested', {}, 'apv_fact'),
      ev('webhook.rejected', {provider: 'square', reason: 'signature_invalid'}, 'whk_1'),
      ev('call.ended', {}, 'call_1'),
    ].reverse();
    const groups = groupByCall(events);
    expect([...groups.keys()].sort()).toEqual(['call_1', 'call_2']);
    expect(groups.get('call_1')!.map((e) => e.type)).toEqual(['call.started', 'call.ended']);
    expect(rejectedWebhooks(events)).toHaveLength(1);
  });
});

describe('order journey', () => {
  it('waits for approval at step 3 in warning, with nothing green', () => {
    const j = deriveJourney({callId: 'call_1', events: proposal(), call: call(), order: order('AWAITING_OWNER_APPROVAL')});
    expect(j.activeStep).toBe(2);
    expect(j.headline).toEqual({label: 'Waiting for your approval', tone: 'warning'});
    expect(j.approval).toMatchObject({id: 'apv_1', state: 'PENDING', recipientLast4: '0123'});
    expect(j.steps.some((s) => s.view?.tone === 'success')).toBe(false);
    expect(j.finished).toBe(false);
  });

  it('shows a sent link as not paid, in info, and never green', () => {
    const j = deriveJourney({
      callId: 'call_1',
      events: approved(),
      call: call(),
      order: order('PAYMENT_PENDING', {checkoutUrl: 'https://sandbox.square.link/u/x'}),
      checkout: {orderId: 'ord_1', ready: true, environment: 'sandbox', message: {id: 'msg_1', channel: 'surge', status: 'SENT'}},
    });
    expect(j.activeStep).toBe(4);
    expect(j.steps[3].view?.tone).toBe('info');
    expect(j.steps[4].view).toEqual({label: 'Not paid yet (sandbox)', tone: 'info'});
    expect(j.paidVerified).toBe(false);
    expect(j.message).toEqual({status: 'SENT', channel: 'surge'});
    expect(j.steps.some((s) => s.view?.tone === 'success')).toBe(false);
  });

  it('is not paid when the order says PAID_VERIFIED but no payment.verified event is in the timeline', () => {
    const j = deriveJourney({callId: 'call_1', events: approved(), call: call(), order: order('PAID_VERIFIED')});
    expect(j.paidVerified).toBe(false);
    expect(j.steps[4].view?.tone).not.toBe('success');
    expect(j.headline.tone).not.toBe('success');
  });

  it('is not paid when payment.verified arrived but the order has not been refetched yet', () => {
    const j = deriveJourney({callId: 'call_1', events: [...approved(), verified()], call: call(), order: order('PAYMENT_PENDING')});
    expect(j.paidVerified).toBe(false);
    expect(j.steps[4].view?.tone).toBe('info');
  });

  it('is paid, green, only with both the order state and the payment.verified event', () => {
    const events = [...approved(), verified()];
    const j = deriveJourney({callId: 'call_1', events, call: call(), order: order('FULFILLMENT_READY')});
    expect(j.paidVerified).toBe(true);
    expect(j.activeStep).toBe(5);
    expect(j.steps[4].view).toEqual({label: 'Paid (sandbox), ready to make', tone: 'success'});
    expect(j.payment).toEqual({state: 'verified', squarePaymentId: 'SQ_PAY', amountMinor: 4731});
    expect(j.steps[3].view).toEqual({label: 'Link created (sandbox)', tone: 'info'});
    // Only the paid step is green.
    expect(j.steps.filter((s) => s.view?.tone === 'success').map((s) => s.key)).toEqual(['paid']);
  });

  it('marks the message SKIPPED under qr_only and does not claim a send', () => {
    const events = proposal().concat(ev('approval.decided', {approvalId: 'apv_1', subjectId: 'ord_1', decision: 'APPROVED', decidedBy: 'usr'}));
    const j = deriveJourney({callId: 'call_1', events, call: call(), order: order('PAYMENT_PENDING'), qrOnly: true});
    expect(j.message?.status).toBe('SKIPPED');
    const copy = messageCopy(j.message, true);
    expect(copy.title).toBe('No message was sent');
    expect(copy.description).toContain('QR code');
  });
});

describe('failure states', () => {
  it('payment failed', () => {
    const events = [...approved(), ev('payment.failed', {orderId: 'ord_1', reason: 'card_declined', sandbox: true})];
    const j = deriveJourney({callId: 'call_1', events, call: call(), order: order('PAYMENT_FAILED')});
    expect(j.steps[4].view).toEqual({label: 'Payment failed (sandbox)', tone: 'danger'});
    expect(j.notices.find((x) => x.key === 'payment_failed')?.description).toContain('card_declined');
    expect(j.paidVerified).toBe(false);
    expect(j.finished).toBe(true);
  });

  it('sync retrying shows the attempt number and keeps the call in progress', () => {
    const sync = {target: 'google_sheets', syncJobId: 'syn_1', recordType: 'order', recordId: 'ord_1'};
    const events = [...approved(), verified(), ev('sync.queued', sync), ev('sync.failed', {...sync, attempts: 2, final: false})];
    const j = deriveJourney({callId: 'call_1', events, call: call(), order: order('FULFILLMENT_READY')});
    expect(j.sync).toEqual({status: 'RETRYING', attempts: 2});
    expect(syncStatusView(j.sync!)).toEqual({label: 'Report pending, retrying, attempt 2', tone: 'warning'});
    expect(j.notices.find((x) => x.key === 'sync')?.title).toContain('attempt 2');
    expect(j.finished).toBe(false);
    const done = syncFromEvents([...events, ev('sync.succeeded', sync)], 'ord_1');
    expect(done?.status).toBe('DONE');
  });

  it('call lost before a proposal: no order, warning, finished', () => {
    const events = [
      ev('call.started', {callId: 'call_1', agentId: 'a', agentVersionId: 'v', channel: 'phone', callerLast4: '0177'}),
      ev('call.ended', {callId: 'call_1', status: 'DROPPED', reason: 'dropped', durationSec: 4}),
    ];
    const j = deriveJourney({callId: 'call_1', events, call: call({status: 'DROPPED', endReason: 'dropped', callerLast4: '0177', stage: 'COLLECTING'})});
    expect(j.kind).toBe('call_only');
    expect(j.headline).toEqual({label: 'Call lost', tone: 'warning'});
    expect(j.notices[0].description).toContain('0177');
    expect(j.finished).toBe(true);
  });

  it('approval rejected', () => {
    const events = [...proposal(), ev('approval.decided', {approvalId: 'apv_1', subjectId: 'ord_1', decision: 'REJECTED', decidedBy: 'usr'})];
    const j = deriveJourney({callId: 'call_1', events, call: call(), order: order('REJECTED')});
    expect(j.approval?.state).toBe('REJECTED');
    expect(j.headline.tone).toBe('neutral');
    expect(j.notices.map((x) => x.key)).toEqual(['rejected']);
    expect(j.message).toBeUndefined();
  });

  it('approval expired', () => {
    const events = [...proposal(), ev('approval.expired', {approvalId: 'apv_1', subjectId: 'ord_1'})];
    const j = deriveJourney({callId: 'call_1', events, call: call(), order: order('APPROVAL_EXPIRED')});
    expect(j.approval?.state).toBe('EXPIRED');
    expect(j.headline).toEqual({label: 'Approval expired, nothing charged', tone: 'neutral'});
    expect(j.notices.map((x) => x.key)).toEqual(['expired']);
  });

  it('item unavailable during the call and after approval', () => {
    const live = deriveJourney({
      callId: 'call_1',
      events: [ev('call.started', {callId: 'call_1', agentId: 'a', agentVersionId: 'v', channel: 'phone'})],
      call: call({status: 'IN_PROGRESS', stage: 'UNAVAILABLE', endedAt: undefined, endReason: undefined}),
    });
    expect(live.headline.tone).toBe('warning');
    expect(live.notices.map((x) => x.key)).toContain('item_unavailable');
    const after = deriveJourney({callId: 'call_1', events: proposal(), call: call(), order: order('UNAVAILABLE')});
    expect(after.notices.map((x) => x.key)).toContain('unavailable');
    expect(after.steps[3].view?.tone).toBe('neutral');
  });

  it('a step that needs review, and an order in RECOVERY_REQUIRED', () => {
    const events = [
      ...proposal(),
      ev('approval.decided', {approvalId: 'apv_1', subjectId: 'ord_1', decision: 'APPROVED', decidedBy: 'usr'}),
      ev('execution.started', {executionId: 'exe_1', approvalId: 'apv_1', actionType: 'square.checkout.create', stepIndex: 0, attempt: 1}),
      ev('execution.failed', {executionId: 'exe_1', actionType: 'square.checkout.create', errorCode: 'INTERNAL', retryable: false, nextStatus: 'NEEDS_REVIEW'}),
    ];
    const j = deriveJourney({callId: 'call_1', events, call: call(), order: order('RECOVERY_REQUIRED')});
    expect(j.executions[0]).toMatchObject({status: 'NEEDS_REVIEW', errorCode: 'INTERNAL'});
    expect(j.notices.map((x) => x.key)).toEqual(expect.arrayContaining(['recovery', 'review_exe_1']));
    expect(j.steps[3].view?.tone).toBe('danger');
    expect(j.finished).toBe(false);
  });

  it('message failed and unknown point to the QR code', () => {
    for (const status of ['FAILED', 'UNKNOWN'] as const) {
      const j = deriveJourney({
        callId: 'call_1',
        events: approved(),
        call: call(),
        order: order('PAYMENT_PENDING'),
        checkout: {orderId: 'ord_1', ready: true, environment: 'sandbox', message: {id: 'm', channel: 'surge', status}},
      });
      expect(j.notices.find((x) => x.key === 'message')?.description).toContain('QR code');
      expect(messageCopy(j.message, false).description).toContain('QR code');
    }
  });

  it('rejected webhook is listed apart from calls', () => {
    const w = ev('webhook.rejected', {provider: 'square', reason: 'signature_invalid'}, 'whk_9');
    expect(groupByCall([w]).size).toBe(0);
    expect(rejectedWebhooks([w])[0].id).toBe(w.id);
  });
});

describe('booking journey', () => {
  const bookingEvents = () => [
    ev('call.started', {callId: 'call_1', agentId: 'a', agentVersionId: 'v', channel: 'phone'}),
    ev('proposal.created', {subjectId: 'bkg_1', subjectType: 'booking', callId: 'call_1', serviceName: 'Haircut'}),
    ev('approval.requested', {
      approvalId: 'apv_b',
      bundleType: 'booking_bundle',
      subjectId: 'bkg_1',
      actionBundle: ['calendar.event.create', 'message.booking.confirm', 'local.booking.record', 'sheets.booking.append'],
      expiresAt: new Date(T0 + 600_000).toISOString(),
    }),
    ev('approval.decided', {approvalId: 'apv_b', subjectId: 'bkg_1', decision: 'APPROVED', decidedBy: 'usr'}),
    ev('execution.started', {executionId: 'exe_c', approvalId: 'apv_b', actionType: 'calendar.event.create', stepIndex: 0, attempt: 1}),
  ];

  it('checks the calendar after approval, in info', () => {
    const j = deriveJourney({callId: 'call_1', events: bookingEvents(), call: call(), booking: booking('RECHECKING_SLOT')});
    expect(j.kind).toBe('booking');
    expect(j.activeStep).toBe(3);
    expect(j.headline).toEqual({label: 'Checking the calendar', tone: 'info'});
  });

  it('is booked, green, only after booking.verified', () => {
    const events = [
      ...bookingEvents(),
      ev('execution.succeeded', {executionId: 'exe_c', actionType: 'calendar.event.create', externalRef: 'gev'}),
      ev('message.sent', {dispatchId: 'msg_b', subjectId: 'bkg_1', channel: 'surge', template: 'booking_confirmed', recipientLast4: '0124'}),
    ];
    const before = deriveJourney({callId: 'call_1', events, call: call(), booking: booking('BOOKED_VERIFIED')});
    expect(before.bookedVerified).toBe(false);
    expect(before.headline.tone).not.toBe('success');
    const withEvent = [
      ...events,
      ev('booking.verified', {bookingId: 'bkg_1', googleEventId: 'gev', serviceName: 'Haircut', startUtc: 'x', timezone: 'America/Los_Angeles'}),
    ];
    const after = deriveJourney({callId: 'call_1', events: withEvent, call: call(), booking: booking('BOOKED_VERIFIED')});
    expect(after.bookedVerified).toBe(true);
    expect(after.steps[4].view).toEqual({label: 'Booked, verified', tone: 'success'});
    expect(after.message).toEqual({status: 'SENT', channel: 'surge'});
  });

  it('slot conflict lists the alternatives and stops at the calendar step', () => {
    const alternatives = [{startUtc: '2026-11-15T22:45:00Z', endUtc: '2026-11-15T23:15:00Z'}];
    const events = [
      ...bookingEvents(),
      ev('booking.slot_conflict', {bookingId: 'bkg_1', approvalId: 'apv_b', startUtc: 'x', alternatives}),
      ev('execution.failed', {executionId: 'exe_c', actionType: 'calendar.event.create', errorCode: 'SLOT_CONFLICT', retryable: false, nextStatus: 'FAILED'}),
    ];
    const j = deriveJourney({callId: 'call_1', events, call: call(), booking: booking('SLOT_CONFLICT')});
    expect(j.activeStep).toBe(3);
    expect(j.steps[3].view?.tone).toBe('danger');
    expect(j.slotConflict?.alternatives).toEqual(alternatives);
    expect(j.notices.map((x) => x.key)).toContain('slot_conflict');
    expect(j.bookedVerified).toBe(false);
  });
});

describe('messageCopy', () => {
  it('never says sent unless the dispatch says SENT or DELIVERED', () => {
    const statuses = ['NOT_STARTED', 'SKIPPED', 'QUEUED', 'FAILED', 'UNKNOWN'] as const;
    for (const status of statuses) {
      const copy = messageCopy({status}, false);
      expect(copy.title).not.toMatch(/^Message (sent|delivered)/);
      expect(copy.description).not.toMatch(/accepted|confirmed delivery/);
      expect(copy.tone).not.toBe('success');
    }
    expect(messageCopy({status: 'SENT', channel: 'surge'}, false).title).toBe('Message sent (surge)');
    expect(messageCopy({status: 'SENT'}, false).description).toContain('not paid');
  });
});

describe('QR code', () => {
  it('encodes the checkout URL with a quiet zone', () => {
    const {size, path} = qrPath('https://sandbox.square.link/u/mock-abc');
    expect(size).toBeGreaterThanOrEqual(21 + 8);
    expect(path.length).toBeGreaterThan(100);
  });
});
