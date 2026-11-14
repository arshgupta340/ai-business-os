import {describe, expect, it} from 'vitest';
import {
  ActionTypeSchema,
  ActivityEventTypeSchema,
  AgentTemplateSchema,
  FactKindSchema,
  HoursKeySchema,
  WebhookProviderSchema,
} from '@abos/contracts';
import {agentTemplateLabel, eventTypeLabel} from '@/lib/labels';
import {expectOwnerLabel, FUTURE_VALUES} from '@/lib/owner-label.test-helpers';
import type {ActivityEvent, Booking, Call, IntegrationHealth, Order} from '@/lib/api';
import {summarizeHealth} from '@/components/shell/ConnectionHealth';
import {
  businessFlow,
  callTitle,
  describeEvent,
  groupBookings,
  groupOrders,
  startOfTodayUtc,
  summarizeCalls,
} from './overview-logic';

const order = (status: Order['status'], totalMinor = 1000) => ({status, totalMinor, currency: 'USD'}) as Order;
const booking = (status: Booking['status']) => ({status}) as Booking;
const call = (startedAt: string, extra: Partial<Call> = {}) =>
  ({id: startedAt, startedAt, status: 'COMPLETED', channel: 'phone', ...extra}) as Call;

describe('startOfTodayUtc', () => {
  it('returns local midnight in Los Angeles as UTC (standard time)', () => {
    // 2026-11-13 15:00 in Los Angeles (PST, UTC-8).
    expect(startOfTodayUtc('America/Los_Angeles', Date.parse('2026-11-13T23:00:00Z'))).toBe('2026-11-13T08:00:00.000Z');
  });

  it('uses the local date, not the UTC date', () => {
    // 2026-11-14 02:00 UTC is still 2026-11-13 18:00 in Los Angeles.
    expect(startOfTodayUtc('America/Los_Angeles', Date.parse('2026-11-14T02:00:00Z'))).toBe('2026-11-13T08:00:00.000Z');
  });

  it('handles daylight saving time', () => {
    // 2026-07-01 is PDT, UTC-7.
    expect(startOfTodayUtc('America/Los_Angeles', Date.parse('2026-07-01T20:00:00Z'))).toBe('2026-07-01T07:00:00.000Z');
    // 2026-03-08 is the spring-forward day: midnight is still PST.
    expect(startOfTodayUtc('America/Los_Angeles', Date.parse('2026-03-08T20:00:00Z'))).toBe('2026-03-08T08:00:00.000Z');
  });

  it('handles a zone ahead of UTC', () => {
    expect(startOfTodayUtc('Asia/Kolkata', Date.parse('2026-11-13T20:00:00Z'))).toBe('2026-11-13T18:30:00.000Z');
  });

  it('is stable for every instant of one local day', () => {
    const a = startOfTodayUtc('America/Los_Angeles', Date.parse('2026-11-13T08:00:00Z'));
    const b = startOfTodayUtc('America/Los_Angeles', Date.parse('2026-11-14T07:59:59Z'));
    expect(a).toBe(b);
  });
});

describe('summarizeCalls', () => {
  it('counts only calls since local midnight and splits out lost and simulated calls', () => {
    const since = '2026-11-13T08:00:00.000Z';
    const calls = [
      call('2026-11-13T07:59:00.000Z'),
      call('2026-11-13T09:00:00.000Z'),
      call('2026-11-13T10:00:00.000Z', {status: 'DROPPED'}),
      call('2026-11-13T11:00:00.000Z', {status: 'IN_PROGRESS'}),
      call('2026-11-13T12:00:00.000Z', {channel: 'test_console'}),
    ];
    expect(summarizeCalls(calls, since)).toEqual({total: 4, inProgress: 1, lost: 1, failed: 0, simulated: 1});
  });

  it('labels a test console call as a simulated call', () => {
    expect(callTitle(call('x', {channel: 'test_console', callerLast4: '1234'}))).toBe('Simulated call');
    expect(callTitle(call('x', {callerLast4: '1234'}))).toBe('Caller ending 1234');
  });
});

describe('groupOrders', () => {
  it('groups by status and counts only PAID_VERIFIED and FULFILLMENT_READY as paid', () => {
    const groups = groupOrders([
      order('AWAITING_OWNER_APPROVAL'),
      order('AWAITING_OWNER_APPROVAL'),
      order('PAYMENT_PENDING', 500),
      order('MESSAGE_SENT', 500),
      order('PAID_VERIFIED', 2000),
      order('FULFILLMENT_READY', 3000),
      order('PAYMENT_FAILED'),
      order('REJECTED'),
      order('APPROVAL_EXPIRED'),
    ]);
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));
    expect(byKey.waiting!.count).toBe(2);
    expect(byKey.linkSent!.count).toBe(2);
    expect(byKey.paid!.count).toBe(2);
    expect(byKey.paid!.totalMinor).toBe(5000);
    expect(byKey.needsReview!.count).toBe(1);
    expect(byKey.closed!.count).toBe(2);
    expect(byKey.creatingCheckout!.count).toBe(0);
  });

  it('never counts a pending payment as paid', () => {
    const paid = groupOrders([order('PAYMENT_PENDING'), order('PAYMENT_LINK_READY')]).find((g) => g.key === 'paid')!;
    expect(paid.count).toBe(0);
    expect(paid.totalMinor).toBe(0);
  });

  it('marks every group that holds payment data, so it gets a sandbox label', () => {
    const payment = groupOrders([]).filter((g) => g.payment).map((g) => g.key);
    expect(payment).toEqual(['creatingCheckout', 'linkSent', 'paid', 'needsReview']);
  });

  it('places every order status in exactly one group', () => {
    const all: Order['status'][] = [
      'AWAITING_OWNER_APPROVAL', 'APPROVED', 'CREATING_CHECKOUT', 'PAYMENT_LINK_READY', 'MESSAGE_SENT',
      'PAYMENT_PENDING', 'PAID_VERIFIED', 'FULFILLMENT_READY', 'REJECTED', 'APPROVAL_EXPIRED',
      'UNAVAILABLE', 'PAYMENT_FAILED', 'CANCELLED', 'RECOVERY_REQUIRED',
    ];
    const total = groupOrders(all.map((s) => order(s))).reduce((n, g) => n + g.count, 0);
    expect(total).toBe(all.length);
  });
});

describe('groupBookings', () => {
  it('groups bookings by status', () => {
    const groups = groupBookings([
      booking('AWAITING_OWNER_APPROVAL'),
      booking('BOOKED_VERIFIED'),
      booking('SLOT_CONFLICT'),
      booking('RETRY_REQUIRED'),
      booking('REJECTED'),
      booking('EXPIRED'),
      booking('RECHECKING_SLOT'),
    ]);
    expect(Object.fromEntries(groups.map((g) => [g.key, g.count]))).toEqual({
      waiting: 1,
      checking: 1,
      booked: 1,
      needsReview: 2,
      closed: 2,
    });
  });
});

describe('businessFlow', () => {
  it('shows orders for the pizza shop and bookings for the barbershop', () => {
    expect(businessFlow('restaurant')).toBe('orders');
    expect(businessFlow('barbershop')).toBe('bookings');
    expect(businessFlow('florist')).toBe('both');
  });
});

describe('describeEvent', () => {
  const event = (type: ActivityEvent['type'], payload: Record<string, unknown>): ActivityEvent => ({
    id: 'evt_1',
    businessId: 'biz_pizza_01',
    type,
    correlationId: 'call_1',
    actorType: 'system',
    occurredAt: '2026-11-13T20:00:00.000Z',
    payload,
  }) as ActivityEvent;
  const opts = {timeZone: 'America/Los_Angeles'};

  it('labels payment events as sandbox payment data', () => {
    const line = describeEvent(event('payment.verified', {orderId: 'o', amountMinor: 2150, currency: 'USD', sandbox: true}), opts);
    expect(line).toEqual({title: 'Payment verified, $21.50', payment: true});
    expect(describeEvent(event('checkout.created', {orderId: 'o', totalMinor: 100, currency: 'USD'}), opts).payment).toBe(true);
  });

  it('labels a simulated call and a lost call', () => {
    expect(describeEvent(event('call.started', {channel: 'test_console'}), opts).title).toBe('Simulated call started');
    expect(describeEvent(event('call.ended', {reason: 'dropped'}), opts).title).toBe('Call lost');
  });

  it('reads an order state label from statusView and a stage change without orderId as a call stage', () => {
    expect(describeEvent(event('order.status_changed', {orderId: 'o', callId: 'c', to: 'PAYMENT_PENDING'}), opts).title).toBe(
      'Order: Not paid yet (sandbox)',
    );
    expect(describeEvent(event('order.status_changed', {callId: 'c', to: 'COLLECTING'}), opts).title).toBe('Call: Taking the order');
  });

  it('uses the agent name when it is known', () => {
    const line = describeEvent(event('agent.paused', {agentId: 'agt_1'}), {...opts, agentName: () => 'Pizza line'});
    expect(line.title).toBe('Pizza line paused');
  });
});

/** expectOwnerLabel, plus no dotted identifier such as "square.checkout.create". */
function expectPlain(text: string, raw: string): void {
  expectOwnerLabel(text, raw);
  expect(text, `${JSON.stringify(text)} has a dotted identifier`).not.toMatch(/[a-z]\.[a-z]/);
}

describe('no raw contract value in the recent activity list (#124)', () => {
  const event = (type: string, payload: Record<string, unknown>): ActivityEvent =>
    ({id: 'evt_1', businessId: 'biz_pizza_01', type, correlationId: 'call_1', actorType: 'system', occurredAt: '2026-11-13T20:00:00.000Z', payload}) as ActivityEvent;
  const opts = {timeZone: 'America/Los_Angeles'};

  it('names the fact kind and key of every fact change', () => {
    for (const kind of FactKindSchema.options) {
      for (const key of ['margherita_large', 'pickup_window', ...HoursKeySchema.options]) {
        const {title} = describeEvent(event('fact.changed', {factId: 'f', kind, key, fromVersion: 1, toVersion: 2, sourceType: 'owner_ui'}), opts);
        expectPlain(title, kind);
        expectPlain(title, key);
      }
    }
    expect(describeEvent(event('fact.changed', {factId: 'f', kind: 'menu_item', key: 'margherita_large', fromVersion: 1, toVersion: 2, sourceType: 'upload'}), opts).title).toBe(
      'Business fact updated: Menu item, Margherita large',
    );
    expect(describeEvent(event('fact.changed', {factId: 'f', kind: 'hours', key: 'fri', fromVersion: 1, toVersion: 2, sourceType: 'owner_ui'}), opts).title).toBe(
      'Business fact updated: Opening hours, Friday',
    );
  });

  it('names every action type in a step event', () => {
    for (const actionType of [...ActionTypeSchema.options, ...FUTURE_VALUES]) {
      for (const type of ['execution.started', 'execution.succeeded', 'execution.failed']) {
        const {title} = describeEvent(event(type, {approvalId: 'a', actionType, idempotencyKey: 'k'}), opts);
        expectPlain(title, actionType);
      }
    }
    expect(describeEvent(event('execution.started', {actionType: 'square.checkout.create'}), opts).title).toBe('Step started: Create the Square checkout link');
  });

  it('names the provider of every rejected webhook', () => {
    for (const provider of [...WebhookProviderSchema.options, ...FUTURE_VALUES]) {
      const {title} = describeEvent(event('webhook.rejected', {provider, reason: 'signature'}), opts);
      expectPlain(title, provider);
      expect(title).not.toMatch(/^A webhook/);
    }
    expect(describeEvent(event('webhook.rejected', {provider: 'agentphone', reason: 'signature'}), opts).title).toBe('AgentPhone webhook rejected, nothing changed');
  });

  it('gives every event type a title, and a type it does not know a generic one', () => {
    for (const type of ActivityEventTypeSchema.options) expectPlain(eventTypeLabel(type), type);
    for (const type of FUTURE_VALUES) expect(describeEvent(event(type, {}), opts).title).toBe('Other activity');
  });

  it('uses one template name on every screen', () => {
    for (const template of [...AgentTemplateSchema.options, ...FUTURE_VALUES]) expectPlain(agentTemplateLabel(template), template);
    expect(agentTemplateLabel('restaurant_order_taker')).toBe('Restaurant order taker');
  });
});

describe('summarizeHealth', () => {
  const entry = (state: 'connected' | 'degraded' | 'disconnected') => ({state, lastCheckedAt: '2026-11-13T20:00:00.000Z'});
  const health = (overrides: Partial<Record<Exclude<keyof IntegrationHealth, 'square'>, ReturnType<typeof entry>>> = {}): IntegrationHealth => ({
    square: {...entry('connected'), environment: 'sandbox' as const},
    twilio: entry('connected'),
    openai: entry('connected'),
    google_calendar: entry('connected'),
    google_sheets: entry('connected'),
    message_channel: entry('connected'),
    ...overrides,
  });

  it('is success only when every provider is connected', () => {
    const s = summarizeHealth(health());
    expect(s.worst).toBe('connected');
    expect(s.status).toEqual({label: 'Integrations OK', tone: 'success'});
  });

  it('is warning when a provider is degraded and names it', () => {
    const s = summarizeHealth(health({google_calendar: entry('degraded')}));
    expect(s.status.tone).toBe('warning');
    expect(s.degraded).toEqual(['Google Calendar']);
    expect(s.detail).toBe('Degraded: Google Calendar.');
  });

  it('is danger when any provider is disconnected, even with others degraded', () => {
    const s = summarizeHealth(health({google_calendar: entry('degraded'), google_sheets: entry('disconnected')}));
    expect(s.worst).toBe('disconnected');
    expect(s.status).toEqual({label: '2 integration issues', tone: 'danger'});
    expect(s.detail).toBe('Disconnected: Google Sheets. Degraded: Google Calendar.');
  });
});
