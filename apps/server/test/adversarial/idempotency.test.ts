// B-23 group 4 (AGENTS rule 3) and the FLOWS section 4 failure branches: crashes, timeouts and
// ambiguous provider replies. After each one: no second provider write, no new idempotency key, and
// the stored state FLOWS names. Idempotency keys are read from the database rows, never rebuilt here.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENDPOINTS, idempotencyKey } from '@abos/contracts';
import { createSquareAdapterForTest } from '../../src/adapters/square/testing';
import { createDbExecutor } from '../../src/compose/executor';
import { notWiredExecutor, type SeamDeps } from '../../src/compose/seams';
import { currentRole } from '../support/db';
import { LOCATION_ID, OWNER, createWorld, fakeSquareClient, nextLocalDate, zonedIso, type World } from '../e2e/world';
import {
  BARBER, NONE, PIZZA, TZ, approve, bookingProposal, count, counts, decide, delta, filterCalendarListByProperty, getApproval, order, paymentEvent, pizzaOrder, pizzaToPaymentPending, postSquare, sim, statusOf, steps, type Step,
} from './helpers';

const silentLog: SeamDeps['log'] = { info() {}, warn() {}, error() {} };
const timeoutError = () => Object.assign(new Error('Request timed out'), { name: 'TimeoutError' });
const keysOf = (s: Step[]) => s.map((x) => x.idempotency_key);

async function kickAndSettle(w: World, times = 3) {
  for (let i = 0; i < times; i++) {
    await w.settle();
    w.app.composed.executor.kick(PIZZA);
    w.app.composed.executor.kick(BARBER);
    await w.settle();
  }
}

async function expectDatabaseKeys(businessId: string, subjectId: string, approvalId: string, s: Step[]) {
  for (const x of s) expect(x.idempotency_key).toBe(await idempotencyKey({ businessId, subjectId, actionType: x.action_type as never, approvalId }));
}

describe('a worker that dies between claim and finish', () => {
  let w: World;
  // The app's own executor stays off here, so each test decides which worker claims a step.
  beforeAll(async () => { w = await createWorld({ executor: notWiredExecutor }); }, 120_000);
  afterAll(async () => { await w?.close(); });

  function seamDeps(): SeamDeps {
    const c = w.app.composed;
    return { env: c.env, db: c.db, engine: c.engine, providers: c.providers, now: c.now, newId: c.newId, log: silentLog };
  }
  /**
   * Test-only time travel on the database clock: the running lease was taken 16 minutes ago. Since the
   * reworked 0005 a claim carries lease_deadline, which recovery reads first, so it moves back too
   * (adapted after the merge; the suite was written when only locked_at counted).
   */
  const staleLease = (approvalId: string) => w.t.admin((q) => q.query("update public.action_executions set locked_at = locked_at - interval '16 minutes', lease_deadline = lease_deadline - interval '16 minutes' where approval_id = $1 and status = 'RUNNING'", [approvalId]));

  it('runs as abos_app', async () => { expect(await currentRole(w.t.db)).toBe('abos_app'); });

  it('during CreatePaymentLink: recovered to NEEDS_REVIEW, no second create, the same three keys, no message', async () => {
    const before = counts(w);
    const { callId, orderId, approvalId } = await pizzaOrder(w);
    await approve(w, PIZZA, approvalId);
    const queued = await steps(w, approvalId);
    expect(queued.map((x) => x.status)).toEqual(['QUEUED', 'QUEUED', 'QUEUED']);
    await expectDatabaseKeys(PIZZA, orderId, approvalId, queued);

    // Worker A claims the step, sends CreatePaymentLink, and never returns: the process died.
    const hanging = fakeSquareClient();
    let reached!: () => void;
    const sent = new Promise<void>((resolve) => { reached = resolve; });
    hanging.client.checkout.paymentLinks.create = async ({ idempotencyKey: key }) => { hanging.writes.push('checkout.paymentLinks.create'); hanging.createKeys.push(key); reached(); return new Promise(() => {}); };
    const deps = seamDeps();
    const crashed = createDbExecutor({ ...deps, providers: { ...deps.providers, square: createSquareAdapterForTest(hanging.client, { locationId: LOCATION_ID, environment: 'sandbox', now: () => new Date() }) } },
      { workerId: 'worker-crashed-checkout' });
    void crashed.tick();
    await sent;
    expect(hanging.createKeys).toEqual([queued[0]!.idempotency_key]);
    expect((await steps(w, approvalId)).map((x) => x.status)).toEqual(['RUNNING', 'QUEUED', 'QUEUED']);

    // Worker B: leaves a live lease alone, and sends a stale one to review, never back to QUEUED.
    const healthy = createDbExecutor(deps, { workerId: 'worker-b-checkout' });
    await healthy.drain();
    expect((await steps(w, approvalId))[0]!.status).toBe('RUNNING');
    await staleLease(approvalId);
    for (let i = 0; i < 4; i++) await healthy.drain();
    const after = await steps(w, approvalId);
    expect(after.map((x) => [x.status, x.attempts])).toEqual([['NEEDS_REVIEW', 1], ['QUEUED', 0], ['QUEUED', 0]]);
    expect(keysOf(after)).toEqual(keysOf(queued));
    expect(after.map((x) => x.id)).toEqual(queued.map((x) => x.id));
    expect(await count(w, 'action_executions where approval_id = $1', [approvalId])).toBe(3);
    expect(await order(w, orderId)).toMatchObject({ status: 'RECOVERY_REQUIRED', checkout_url: null, square_payment_id: null });
    expect(await count(w, 'message_dispatches where approval_id = $1', [approvalId])).toBe(0);
    // One provider write in total, by the worker that died. The healthy worker made none.
    expect(hanging.writes).toEqual(['checkout.paymentLinks.create']);
    expect(delta(w, before)).toEqual(NONE);
    // The reworked 0005 recovery routine writes this event on the call's journey ID (private.journey), not
    // the approval ID; adapted after the merge.
    expect(await count(w, "activity_events where correlation_id = $1 and type = 'execution.failed' and payload->>'nextStatus' = 'NEEDS_REVIEW'", [callId])).toBe(1);
  });

  describe('during the message send', () => {
    let ids: { orderId: string; approvalId: string };
    it('recovered to NEEDS_REVIEW: the message is not sent again, the key is unchanged, the order keeps its link', async () => {
      const before = counts(w);
      ids = await pizzaOrder(w);
      await approve(w, PIZZA, ids.approvalId);
      const queued = await steps(w, ids.approvalId);
      const deps = seamDeps();
      const received: { to: string; idempotencyKey: string }[] = [];
      let reached!: () => void;
      const sent = new Promise<void>((resolve) => { reached = resolve; });
      const crashed = createDbExecutor({ ...deps, providers: { ...deps.providers, message: { channel: 'surge', send: async (input) => { received.push(input); reached(); return new Promise(() => {}); } } } },
        { workerId: 'worker-crashed-message' });
      // Worker A creates the checkout, then dies inside the send: the provider has the message, we have no answer.
      expect(await crashed.tick()).toBe(true);
      void crashed.tick();
      await sent;
      expect(received.map((m) => m.idempotencyKey)).toEqual([queued[1]!.idempotency_key]);
      expect((await steps(w, ids.approvalId)).map((x) => x.status)).toEqual(['SUCCEEDED', 'RUNNING', 'QUEUED']);

      const healthy = createDbExecutor(deps, { workerId: 'worker-b-message' });
      await healthy.drain();
      expect((await steps(w, ids.approvalId))[1]!.status).toBe('RUNNING');
      await staleLease(ids.approvalId);
      for (let i = 0; i < 4; i++) await healthy.drain();
      const after = await steps(w, ids.approvalId);
      // FLOWS 4: an unknown message result never stops the bundle and is never resent.
      expect(after.map((x) => [x.status, x.attempts])).toEqual([['SUCCEEDED', 1], ['NEEDS_REVIEW', 1], ['SUCCEEDED', 1]]);
      expect(keysOf(after)).toEqual(keysOf(queued));
      expect(await count(w, 'message_dispatches where approval_id = $1', [ids.approvalId])).toBe(1);
      expect(await count(w, "message_dispatches where approval_id = $1 and status in ('SENT','DELIVERED')", [ids.approvalId])).toBe(0);
      expect(received).toHaveLength(1);
      expect(await order(w, ids.orderId)).toMatchObject({ status: 'PAYMENT_PENDING', square_payment_id: null });
      expect((await order(w, ids.orderId)).checkout_url).toMatch(/^https:\/\/sandbox\.square\.link\//);
      // One Square link by worker A (the world's Square), and no send through the world's message channel.
      expect(delta(w, before)).toEqual({ square: 1, messages: 0, calendar: 0, sheets: 0 });
    });
    // DEFECT (see the pull request): FLOWS section 4 says an unknown send leaves the dispatch UNKNOWN.
    // After crash recovery the step is NEEDS_REVIEW but its dispatch row stays QUEUED for good.
    it.fails('the dispatch of the recovered step is recorded as UNKNOWN, not left QUEUED', async () => {
      expect((await w.t.db.query('select status from message_dispatches where approval_id = $1', [ids.approvalId])).rows).toEqual([{ status: 'UNKNOWN' }]);
    });
  });
});

describe('provider timeouts and ambiguous replies', () => {
  let w: World;
  beforeAll(async () => { w = await createWorld(); filterCalendarListByProperty(w); }, 120_000);
  afterAll(async () => { await w?.close(); });

  it('checkout creation times out: NEEDS_REVIEW, order RECOVERY_REQUIRED, no link stored or sent, one create with the database key', async () => {
    const before = counts(w);
    const keysBefore = w.square.createKeys.length;
    w.square.mode.create = 'timeout';
    let ids: { orderId: string; approvalId: string };
    try {
      ids = await pizzaOrder(w);
      await approve(w, PIZZA, ids.approvalId);
      await kickAndSettle(w);
    } finally { w.square.mode.create = 'ok'; }
    // Square is healthy again. Nothing may try a second create on its own.
    await kickAndSettle(w);
    const s = await steps(w, ids.approvalId);
    expect(s.map((x) => [x.status, x.attempts])).toEqual([['NEEDS_REVIEW', 1], ['QUEUED', 0], ['QUEUED', 0]]);
    await expectDatabaseKeys(PIZZA, ids.orderId, ids.approvalId, s);
    expect(w.square.createKeys.slice(keysBefore)).toEqual([s[0]!.idempotency_key]);
    expect(await order(w, ids.orderId)).toMatchObject({ status: 'RECOVERY_REQUIRED', checkout_url: null, square_payment_id: null });
    expect(await count(w, 'message_dispatches where approval_id = $1', [ids.approvalId])).toBe(0);
    // The owner's checkout view offers no link and no QR text.
    const checkout = ENDPOINTS.getOrderCheckout.response.parse((await w.app.inject({ url: `/api/orders/${ids.orderId}/checkout?businessId=${PIZZA}`, headers: OWNER })).json());
    expect(checkout).toMatchObject({ ready: false, environment: 'sandbox' });
    expect(checkout).not.toHaveProperty('checkoutUrl');
    expect(checkout).not.toHaveProperty('qrText');
    expect(delta(w, before)).toEqual({ square: 1, messages: 0, calendar: 0, sheets: 0 });
  });

  it('Square answers 503 to the create: treated as unknown, not retried with a new key, no link sent', async () => {
    const before = counts(w);
    const original = w.square.client.checkout.paymentLinks.create;
    const keys: string[] = [];
    w.square.client.checkout.paymentLinks.create = async ({ idempotencyKey: key }) => { keys.push(key); w.square.writes.push('checkout.paymentLinks.create'); throw Object.assign(new Error('Service Unavailable'), { statusCode: 503 }); };
    let ids: { orderId: string; approvalId: string };
    try {
      ids = await pizzaOrder(w);
      await approve(w, PIZZA, ids.approvalId);
      await kickAndSettle(w);
    } finally { w.square.client.checkout.paymentLinks.create = original; }
    await kickAndSettle(w);
    const s = await steps(w, ids.approvalId);
    expect(new Set(keys)).toEqual(new Set([s[0]!.idempotency_key]));
    expect(keys).toHaveLength(1);
    expect(s.map((x) => x.status)).toEqual(['NEEDS_REVIEW', 'QUEUED', 'QUEUED']);
    expect(await order(w, ids.orderId)).toMatchObject({ status: 'RECOVERY_REQUIRED', checkout_url: null });
    expect(delta(w, before)).toEqual({ square: 1, messages: 0, calendar: 0, sheets: 0 });
  });

  it('the Square order total differs from the approved total: link withheld, no message, RECOVERY_REQUIRED', async () => {
    const before = counts(w);
    const original = w.square.client.checkout.paymentLinks.create;
    // Square creates the link, but its order comes out one dollar higher than the approved total.
    w.square.client.checkout.paymentLinks.create = async (input) => {
      const created = await original(input);
      const stored = w.square.orders.get(created.paymentLink!.orderId!)!;
      w.square.orders.set(stored.id, { ...stored, totalMoney: { amount: stored.totalMoney!.amount! + 100n, currency: 'USD' } });
      return created;
    };
    let ids: { orderId: string; approvalId: string };
    try {
      ids = await pizzaOrder(w);
      await approve(w, PIZZA, ids.approvalId);
      await kickAndSettle(w);
    } finally { w.square.client.checkout.paymentLinks.create = original; }
    const s = await steps(w, ids.approvalId);
    expect(s.map((x) => x.status)).toEqual(['FAILED', 'QUEUED', 'QUEUED']);
    expect(await order(w, ids.orderId)).toMatchObject({ status: 'RECOVERY_REQUIRED', checkout_url: null });
    expect(await count(w, 'message_dispatches where approval_id = $1', [ids.approvalId])).toBe(0);
    const checkout = (await w.app.inject({ url: `/api/orders/${ids.orderId}/checkout?businessId=${PIZZA}`, headers: OWNER })).json() as Record<string, unknown>;
    expect(checkout).toMatchObject({ ready: false });
    expect(JSON.stringify(checkout)).not.toContain('square.link');
    expect(delta(w, before)).toEqual({ square: 1, messages: 0, calendar: 0, sheets: 0 });
  });

  it.each([
    ['throws a timeout after receiving the message', async () => { throw timeoutError(); }],
    ['answers UNKNOWN', async () => ({ status: 'UNKNOWN' as const })],
    ['answers SENT with no provider message ID', async () => ({ status: 'SENT' as const })],
  ] as const)('the message channel %s: recorded UNKNOWN, never sent twice, the order keeps its link', async (_name, reply) => {
    const before = counts(w);
    const original = w.messages.adapter.send;
    const received: string[] = [];
    w.messages.adapter.send = async (input) => { w.messages.sent.push(input); received.push(input.idempotencyKey); return reply(); };
    let ids: { orderId: string; approvalId: string };
    try {
      ids = await pizzaOrder(w);
      await approve(w, PIZZA, ids.approvalId);
      await kickAndSettle(w);
    } finally { w.messages.adapter.send = original; }
    // The channel works again. The message must still not go out a second time.
    await kickAndSettle(w);
    const s = await steps(w, ids.approvalId);
    expect(s.map((x) => [x.status, x.attempts])).toEqual([['SUCCEEDED', 1], ['NEEDS_REVIEW', 1], ['SUCCEEDED', 1]]);
    expect(received).toEqual([s[1]!.idempotency_key]);
    expect((await w.t.db.query('select status, provider_message_id, idempotency_key from message_dispatches where approval_id = $1', [ids.approvalId])).rows)
      .toEqual([{ status: 'UNKNOWN', provider_message_id: null, idempotency_key: s[1]!.idempotency_key }]);
    expect(await count(w, "activity_events where type = 'message.sent' and correlation_id = $1", [ids.approvalId])).toBe(0);
    expect(await count(w, "activity_events where type = 'message.failed' and correlation_id = $1 and payload->>'status' = 'UNKNOWN'", [ids.approvalId])).toBe(1);
    const row = await order(w, ids.orderId);
    expect(row.status).toBe('PAYMENT_PENDING');
    expect(row.checkout_url).toMatch(/^https:\/\/sandbox\.square\.link\//);
    expect(delta(w, before)).toEqual({ square: 1, messages: 1, calendar: 0, sheets: 0 });
  });

  it('the message channel refuses the send: FAILED, not retried, the bundle goes on', async () => {
    const before = counts(w);
    w.messages.mode.send = 'fail';
    let ids: { orderId: string; approvalId: string };
    try {
      ids = await pizzaOrder(w);
      await approve(w, PIZZA, ids.approvalId);
      await kickAndSettle(w);
    } finally { w.messages.mode.send = 'ok'; }
    await kickAndSettle(w);
    expect((await steps(w, ids.approvalId)).map((x) => [x.status, x.attempts])).toEqual([['SUCCEEDED', 1], ['FAILED', 1], ['SUCCEEDED', 1]]);
    expect((await w.t.db.query('select status from message_dispatches where approval_id = $1', [ids.approvalId])).rows).toEqual([{ status: 'FAILED' }]);
    expect((await order(w, ids.orderId)).status).toBe('PAYMENT_PENDING');
    expect(delta(w, before)).toEqual({ square: 1, messages: 1, calendar: 0, sheets: 0 });
  });

  it('Sheets appends the row but reports a failure: retried with the same record ID, one row, job DONE', async () => {
    const { orderId, squareOrderId, totalMinor } = await pizzaToPaymentPending(w);
    const before = counts(w);
    const original = w.sheets.adapter.appendOnce;
    const recordIds: string[] = [];
    w.sheets.adapter.appendOnce = async (input) => {
      recordIds.push(input.recordId);
      const result = await original(input);
      // The first append reached the sheet, and then the reply was lost.
      return recordIds.length === 1 ? { ok: false, reason: 'INTEGRATION_UNAVAILABLE', retryable: true } : result;
    };
    // The retry time is set from the server clock; set it back so the retry is due at once.
    w.clock.advance(-60_000);
    try {
      w.square.addPayment({ id: 'PAY_ADV_SHEETS', orderId: squareOrderId, amountMinor: totalMinor, status: 'COMPLETED' });
      expect((await postSquare(w, paymentEvent('evt_adv_sheets_1', 'PAY_ADV_SHEETS', squareOrderId))).statusCode).toBe(200);
      await kickAndSettle(w);
    } finally { w.clock.advance(60_000); w.sheets.adapter.appendOnce = original; }
    expect(recordIds).toEqual([orderId, orderId]);
    expect((await w.t.db.query('select state, attempts, external_ref from sync_jobs where record_id = $1', [orderId])).rows).toEqual([{ state: 'DONE', attempts: 2, external_ref: orderId }]);
    expect(w.sheets.appended.filter((a) => a.recordId === orderId)).toHaveLength(1);
    expect((await order(w, orderId)).status).toBe('FULFILLMENT_READY');
    expect(delta(w, before)).toEqual({ square: 0, messages: 0, calendar: 0, sheets: 1 });
  });

  it('Calendar inserts the event but the reply times out: found by its key, one event, one confirmation', async () => {
    const before = counts(w);
    const original = w.calendar.client.events.insert;
    w.calendar.client.events.insert = async (input) => { await original(input); throw timeoutError(); };
    let b: { bookingId: string; approvalId: string };
    try {
      b = await bookingProposal(w, { minDays: 2 });
      await approve(w, BARBER, b.approvalId);
      await kickAndSettle(w);
    } finally { w.calendar.client.events.insert = original; }
    await kickAndSettle(w);
    const s = await steps(w, b.approvalId);
    expect(s.map((x) => [x.status, x.attempts])).toEqual([['SUCCEEDED', 1], ['SUCCEEDED', 1], ['SUCCEEDED', 1]]);
    await expectDatabaseKeys(BARBER, b.bookingId, b.approvalId, s);
    expect((await w.t.db.query('select status, google_event_id from bookings where id = $1', [b.bookingId])).rows).toEqual([{ status: 'BOOKED_VERIFIED', google_event_id: s[0]!.idempotency_key }]);
    expect([...w.calendar.events.keys()].filter((id) => id === s[0]!.idempotency_key)).toHaveLength(1);
    expect(delta(w, before)).toEqual({ square: 0, messages: 1, calendar: 1, sheets: 1 });
  });

  it('Calendar times out and the event never appears: the one attempt uses the step key as event ID, then review; no confirmation', async () => {
    const before = counts(w);
    const original = w.calendar.client.events.insert;
    const inserted: string[] = [];
    // The request is lost on the way: Google stores nothing and we get a timeout.
    w.calendar.client.events.insert = async (input) => { inserted.push(input.requestBody.id); throw timeoutError(); };
    // Retry times are set from the server clock; set it back so each retry is due at once.
    w.clock.advance(-120_000);
    let b: { bookingId: string; approvalId: string };
    try {
      b = await bookingProposal(w);
      await approve(w, BARBER, b.approvalId);
      await kickAndSettle(w, 5);
    } finally { w.clock.advance(120_000); w.calendar.client.events.insert = original; }
    // Google works again. Nothing may insert on its own after the attempts are used up.
    await kickAndSettle(w);
    const s = await steps(w, b.approvalId);
    // The insert is on the event ID that is the step's key. Since review finding 6 (commit 5cc989e) an
    // insert whose follow-up lookup cannot establish the outcome is outcome unknown: the step goes to
    // NEEDS_REVIEW on its first attempt instead of retrying (adapted after the merge; the suite was
    // written when it retried three times and then FAILED).
    expect(inserted).toEqual([s[0]!.idempotency_key]);
    expect(s.map((x) => [x.status, x.attempts])).toEqual([['NEEDS_REVIEW', 1], ['QUEUED', 0], ['QUEUED', 0]]);
    await expectDatabaseKeys(BARBER, b.bookingId, b.approvalId, s);
    expect(w.calendar.events.has(s[0]!.idempotency_key)).toBe(false);
    expect((await w.t.db.query('select status, google_event_id from bookings where id = $1', [b.bookingId])).rows).toEqual([{ status: 'RETRY_REQUIRED', google_event_id: null }]);
    expect(await count(w, 'message_dispatches where approval_id = $1', [b.approvalId])).toBe(0);
    expect(await count(w, 'sync_jobs where record_id = $1', [b.bookingId])).toBe(0);
    expect(delta(w, before)).toEqual(NONE);
  });

  it('the slot is taken between proposal and approval: SLOT_CONFLICT, no event, no confirmation', async () => {
    const before = counts(w);
    const b = await bookingProposal(w, { minDays: 4 });
    // Someone else's appointment lands on the slot after the proposal.
    w.calendar.busy.push({ start: b.startUtc, end: new Date(Date.parse(b.startUtc) + 30 * 60_000).toISOString() });
    try {
      await approve(w, BARBER, b.approvalId);
      await kickAndSettle(w);
    } finally { w.calendar.busy.length = 0; }
    expect((await steps(w, b.approvalId)).map((x) => x.status)).toEqual(['FAILED', 'QUEUED', 'QUEUED']);
    expect(await statusOf(w, 'bookings', b.bookingId)).toBe('SLOT_CONFLICT');
    expect(await count(w, "activity_events where type = 'booking.slot_conflict' and payload->>'bookingId' = $1", [b.bookingId])).toBe(1);
    expect(await count(w, 'message_dispatches where approval_id = $1', [b.approvalId])).toBe(0);
    expect(delta(w, before)).toEqual(NONE);
  });

  it('the message channel answers with a result outside its contract: never marked sent, never sent twice', async () => {
    const before = counts(w);
    const original = w.messages.adapter.send;
    const received: string[] = [];
    w.messages.adapter.send = async (input) => { w.messages.sent.push(input); received.push(input.idempotencyKey); return { status: 'DELIVERED_MAYBE' } as never; };
    let ids: { orderId: string; approvalId: string };
    try {
      ids = await pizzaOrder(w);
      await approve(w, PIZZA, ids.approvalId);
      await kickAndSettle(w);
    } finally { w.messages.adapter.send = original; }
    await kickAndSettle(w);
    const s = await steps(w, ids.approvalId);
    expect(s.map((x) => [x.status, x.attempts])).toEqual([['SUCCEEDED', 1], ['NEEDS_REVIEW', 1], ['SUCCEEDED', 1]]);
    expect(received).toEqual([s[1]!.idempotency_key]);
    expect(await count(w, "message_dispatches where approval_id = $1 and status in ('SENT','DELIVERED')", [ids.approvalId])).toBe(0);
    expect(await count(w, 'message_dispatches where approval_id = $1', [ids.approvalId])).toBe(1);
    expect(await count(w, "activity_events where type = 'message.sent' and correlation_id = $1", [ids.approvalId])).toBe(0);
    expect((await order(w, ids.orderId)).status).toBe('PAYMENT_PENDING');
    expect(delta(w, before)).toEqual({ square: 1, messages: 1, calendar: 0, sheets: 0 });
  });

  describe('two callers propose the same slot before the owner decides', () => {
    let first: { bookingId: string; approvalId: string };
    let second: { bookingId: string; approvalId: string };
    let secondResponse: { statusCode: number; body: string };
    it('approving both books the slot once: one Calendar event, one confirmation, the second booking is never booked', async () => {
      const before = counts(w);
      const startUtc = zonedIso(nextLocalDate([3, 4], 8), '15:00', TZ);
      // With consent, through the composed proposal port on a live simulated call, as test/e2e/flows.test.ts
      // does (the toolset proposes qr_only since B-15). Adapted after the merge from the read-back flow.
      let op = 0;
      const propose = async (name: string, to: string) => {
        w.model.push(async () => 'One moment.', async () => 'Thanks, the owner will confirm.');
        const opened = await sim(w, 'agt_barber_01', BARBER, { message: 'A haircut at three please' });
        const callId = opened.body.callId;
        const call = (await w.t.db.query('select agent_version_id from calls where id = $1', [callId])).rows[0] as { agent_version_id: string };
        const made = await w.app.composed.toolsetPorts.proposals.createBookingProposal({ businessId: BARBER, agentVersionId: call.agent_version_id, callId,
          correlationId: callId, operationId: `op-adv-same-slot-${++op}`, signal: new AbortController().signal, serviceId: 'svc_haircut', startUtc,
          customer: { name, messageRecipient: to, messageConsent: true }, messageChannel: w.app.composed.providers.messageChannel });
        await sim(w, 'agt_barber_01', BARBER, { callId, message: 'Thanks', end: true });
        expect(made).toMatchObject({ ok: true });
        if (!made.ok) throw new Error(made.reason);
        return { bookingId: made.bookingId, approvalId: made.approvalId };
      };
      first = await propose('Ana', '+15555550124');
      second = await propose('Bo', '+15555550125');
      await approve(w, BARBER, first.approvalId);
      await kickAndSettle(w);
      expect(await statusOf(w, 'bookings', first.bookingId)).toBe('BOOKED_VERIFIED');
      const hash = (await getApproval(w, BARBER, second.approvalId)).payloadHash;
      secondResponse = await decide(w, BARBER, second.approvalId, 'approve', hash);
      await kickAndSettle(w);
      expect(await statusOf(w, 'bookings', second.bookingId)).not.toBe('BOOKED_VERIFIED');
      expect(await count(w, "bookings where status in ('RECHECKING_SLOT','BOOKED_VERIFIED') and start_utc = $1", [startUtc])).toBe(1);
      expect(await count(w, 'message_dispatches where approval_id = $1', [second.approvalId])).toBe(0);
      expect(w.messages.sent.filter((m) => m.to === '+15555550125')).toEqual([]);
      expect(delta(w, before)).toEqual({ square: 0, messages: 1, calendar: 1, sheets: 1 });
    });
    // Was DEFECT 2 in the pull request (the decision answered 500). Commit 815f430 mapped the overlap to
    // SLOT_CONFLICT; the booking move and the booking.slot_conflict event (FLOWS X1) were added after the merge.
    it('the second approval answers without a server error and the booking moves to SLOT_CONFLICT', async () => {
      expect(secondResponse.statusCode).toBeLessThan(500);
      expect(JSON.parse(secondResponse.body)).toMatchObject({ code: 'SLOT_CONFLICT' });
      expect(await statusOf(w, 'bookings', second.bookingId)).toBe('SLOT_CONFLICT');
      expect(await count(w, "activity_events where type = 'booking.slot_conflict' and payload->>'bookingId' = $1", [second.bookingId])).toBe(1);
    });
  });

  // Was DEFECT 1 in the pull request. FLOWS B18 and section 4: the checkout step re-checks availability
  // in catalog_items and, when an item is gone, fails with no Square call and moves the order to
  // UNAVAILABLE. Fixed after the merge (cartAvailable in compose/executor.ts).
  it('an item that became unavailable after the proposal: no Square call, no message, order UNAVAILABLE', async () => {
    const before = counts(w);
    const ids = await pizzaOrder(w);
    await w.t.admin((q) => q.query("update public.catalog_items set is_available = false where business_id = $1 and square_variation_id = 'SQ_VAR_PEP_LG'", [PIZZA]));
    try {
      await approve(w, PIZZA, ids.approvalId);
      await kickAndSettle(w);
      expect(delta(w, before)).toEqual(NONE);
      expect((await order(w, ids.orderId)).status).toBe('UNAVAILABLE');
      expect((await steps(w, ids.approvalId)).map((x) => x.status)).toEqual(['FAILED', 'QUEUED', 'QUEUED']);
      expect(await count(w, 'message_dispatches where approval_id = $1', [ids.approvalId])).toBe(0);
    } finally {
      await w.t.admin((q) => q.query("update public.catalog_items set is_available = true where business_id = $1 and square_variation_id = 'SQ_VAR_PEP_LG'", [PIZZA]));
    }
  });
});
