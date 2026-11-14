import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BOOKING_BUNDLE, createApproval, createApprovedApproval, createBooking, createExecution, createMigratedDb,
  createOrder, createOwner, hash, hex64, insert, uniq, type Owner,
} from './helpers';

// SPEC 2.4. Orders and bookings hold the states from AWAITING_OWNER_APPROVAL on; the conversation
// states before that live in calls.stage (SPEC 2.4 rulings), so the two checks together cover the machine.
const ORDER_STATES = [
  'AWAITING_OWNER_APPROVAL', 'APPROVED', 'CREATING_CHECKOUT', 'PAYMENT_LINK_READY', 'MESSAGE_SENT', 'PAYMENT_PENDING',
  'PAID_VERIFIED', 'FULFILLMENT_READY', 'REJECTED', 'APPROVAL_EXPIRED', 'UNAVAILABLE', 'PAYMENT_FAILED', 'CANCELLED',
  'RECOVERY_REQUIRED',
];
const ORDER_CONVERSATION_STAGES = ['CALL_STARTED', 'COLLECTING', 'VALIDATING', 'UNAVAILABLE', 'CUSTOMER_CONFIRMED'];
const BOOKING_STATES = [
  'AWAITING_OWNER_APPROVAL', 'RECHECKING_SLOT', 'BOOKED_VERIFIED', 'SLOT_CONFLICT', 'REJECTED', 'EXPIRED', 'RETRY_REQUIRED',
];
const BOOKING_CONVERSATION_STAGES = ['INQUIRY', 'SLOT_SEARCH', 'PROPOSAL', 'CUSTOMER_CONFIRMED'];
const APPROVAL_STATES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'];
const EXECUTION_STATES = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'SKIPPED', 'FAILED', 'NEEDS_REVIEW'];
const SYNC_JOB_STATES = ['PENDING', 'RUNNING', 'DONE', 'RETRYING', 'FAILED'];
const DISPATCH_STATES = ['QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'UNKNOWN'];
const CALL_STATES = ['IN_PROGRESS', 'COMPLETED', 'DROPPED', 'FAILED'];
// SPEC 2.5.
const EVENT_TYPES = [
  'call.started', 'call.ended', 'proposal.created', 'approval.requested', 'approval.decided', 'approval.expired',
  'execution.started', 'execution.succeeded', 'execution.failed', 'checkout.created', 'message.sent', 'message.failed',
  'payment.verified', 'payment.failed', 'booking.verified', 'booking.slot_conflict', 'order.status_changed',
  'booking.status_changed', 'sync.queued', 'sync.succeeded', 'sync.failed', 'fact.changed', 'extraction.completed',
  'agent.published', 'agent.paused', 'live_agent.changed', 'guardrail.refused', 'webhook.rejected',
];

const CHECK_VIOLATION = /violates check constraint/;
const UNIQUE_VIOLATION = /duplicate key value violates unique constraint/;

let db: PGlite;
let owner: Owner;

beforeAll(async () => {
  db = await createMigratedDb();
  owner = await createOwner(db);
});
afterAll(async () => {
  await db.close();
});

/** A fully filled order, so every status passes the other checks and only the status check is tested. */
function orderWithRefs(status: string) {
  const s = uniq();
  return createOrder(db, owner, {
    status, square_order_id: `sqo_${s}`, square_payment_link_id: `sql_${s}`,
    checkout_url: `https://example.test/${s}`, square_payment_id: `sqp_${s}`,
  });
}

let slot = 0;
function bookingWithRefs(status: string) {
  // Each booking gets its own hour so the overlap rule never interferes with the status check.
  slot += 1;
  const start = new Date(Date.UTC(2027, 0, 1, 0, 0) + slot * 3_600_000);
  const end = new Date(start.getTime() + 1_800_000);
  return createBooking(db, owner, { status, google_event_id: `evt${uniq()}`, start_utc: start, end_utc: end });
}

// Approvals are always created PENDING (approval_requests_guard), so each state is reached by an update.
async function approvalIn(state: string) {
  const a = await createApproval(db, owner);
  if (state === 'PENDING') return a;
  const byOwner = state === 'APPROVED' || state === 'REJECTED';
  const { rows } = await db.query(
    `update public.approval_requests set state = $2, decided_at = now(), decided_by = $3 where id = $1 returning *`,
    [a.id, state, byOwner ? owner.userId : null],
  );
  return rows[0];
}

async function executionIn(status: string) {
  const approval = await createApprovedApproval(db, owner);
  return createExecution(db, owner, String(approval.id), { status, finished_at: new Date() });
}

async function dispatchIn(status: string, channel = 'surge', idempotencyKey = hex64()) {
  const order = await createOrder(db, owner);
  const approval = await createApprovedApproval(db, owner, { subject_id: order.id });
  const exe = await createExecution(db, owner, String(approval.id), { action_type: 'message.checkout.send', step_index: 1 });
  return insert(db, 'message_dispatches', {
    business_id: owner.businessId, approval_id: approval.id, execution_id: exe.id, order_id: order.id,
    channel, recipient: '+15555550123', template: 'checkout_link', body_hash: hash(), idempotency_key: idempotencyKey,
    status, provider_message_id: `pm_${uniq()}`,
  });
}

function callIn(status: string, stage = 'CALL_STARTED') {
  const ended = status !== 'IN_PROGRESS';
  return insert(db, 'calls', {
    business_id: owner.businessId, agent_id: owner.agentId, agent_version_id: owner.agentVersionId,
    channel: 'test_console', status, stage, ended_at: ended ? new Date(Date.now() + 1000) : null,
  });
}

function syncJobIn(state: string) {
  return insert(db, 'sync_jobs', {
    business_id: owner.businessId, target: 'google_sheets', record_type: 'order', record_id: `ord_${uniq()}`, state,
  });
}

describe('status check constraints accept every SPEC 2.4 state and reject a made-up one', () => {
  const machines: [string, string[], (s: string) => Promise<unknown>][] = [
    ['orders.status', ORDER_STATES, orderWithRefs],
    ['bookings.status', BOOKING_STATES, bookingWithRefs],
    ['approval_requests.state', APPROVAL_STATES, approvalIn],
    ['action_executions.status', EXECUTION_STATES, executionIn],
    ['sync_jobs.state', SYNC_JOB_STATES, syncJobIn],
    ['message_dispatches.status', DISPATCH_STATES, (s) => dispatchIn(s)],
    ['calls.status', CALL_STATES, (s) => callIn(s)],
    ['calls.stage (order conversation)', ORDER_CONVERSATION_STAGES, (s) => callIn('IN_PROGRESS', s)],
    ['calls.stage (booking conversation)', BOOKING_CONVERSATION_STAGES, (s) => callIn('IN_PROGRESS', s)],
  ];
  for (const [name, states, make] of machines) {
    it(name, async () => {
      for (const state of states) await expect(make(state), state).resolves.toBeTruthy();
      await expect(make('MADE_UP_STATE')).rejects.toThrow(CHECK_VIOLATION);
    });
  }

  it('orders.status does not hold the conversation states that SPEC moves to calls.stage', async () => {
    await expect(orderWithRefs('CALL_STARTED')).rejects.toThrow(CHECK_VIOLATION);
    await expect(bookingWithRefs('INQUIRY')).rejects.toThrow(CHECK_VIOLATION);
  });

  it('activity_events.type accepts every SPEC 2.5 type and rejects a misspelled one', async () => {
    for (const type of EVENT_TYPES) {
      await insert(db, 'activity_events', {
        business_id: owner.businessId, type, correlation_id: owner.callId, actor_type: 'system',
      });
    }
    await expect(
      insert(db, 'activity_events', { business_id: owner.businessId, type: 'order.statuschanged', correlation_id: 'x', actor_type: 'system' }),
    ).rejects.toThrow(CHECK_VIOLATION);
  });
});

describe('never-broken rules held by constraints', () => {
  it('action_executions.idempotency_key is unique', async () => {
    const key = hex64();
    const a1 = await createApprovedApproval(db, owner);
    const a2 = await createApprovedApproval(db, owner);
    await createExecution(db, owner, String(a1.id), { idempotency_key: key });
    await expect(createExecution(db, owner, String(a2.id), { idempotency_key: key })).rejects.toThrow(UNIQUE_VIOLATION);
  });

  it('action_executions cannot queue the same step of one approval twice', async () => {
    const a = await createApprovedApproval(db, owner);
    await createExecution(db, owner, String(a.id));
    await expect(createExecution(db, owner, String(a.id))).rejects.toThrow(UNIQUE_VIOLATION);
  });

  it('webhook_events stores the same (source, provider_event_id) once', async () => {
    const id = `evt_sq_${uniq()}`;
    await insert(db, 'webhook_events', { source: 'square', provider_event_id: id, event_type: 'payment.updated' });
    await expect(
      insert(db, 'webhook_events', { source: 'square', provider_event_id: id, event_type: 'payment.updated' }),
    ).rejects.toThrow(UNIQUE_VIOLATION);
    // The same provider ID from a different source is a different event.
    await insert(db, 'webhook_events', { source: 'twilio_status', provider_event_id: id, event_type: 'status' });
  });

  describe('bookings_no_overlap', () => {
    const at = (h: number, m = 0) => new Date(Date.UTC(2027, 5, 1, h, m));

    it('two overlapping RECHECKING_SLOT or BOOKED_VERIFIED rows on one calendar cannot both exist', async () => {
      const cal = `cal_${uniq()}`;
      await createBooking(db, owner, { calendar_id: cal, status: 'BOOKED_VERIFIED', google_event_id: `e${uniq()}`, start_utc: at(10), end_utc: at(11) });
      await expect(
        createBooking(db, owner, { calendar_id: cal, status: 'RECHECKING_SLOT', start_utc: at(10, 30), end_utc: at(11, 30) }),
      ).rejects.toThrow(/bookings_no_overlap/);
      await expect(
        createBooking(db, owner, { calendar_id: cal, status: 'BOOKED_VERIFIED', google_event_id: `e${uniq()}`, start_utc: at(10, 15), end_utc: at(10, 45) }),
      ).rejects.toThrow(/bookings_no_overlap/);
    });

    it('moving a second overlapping booking into RECHECKING_SLOT fails (the local slot lock)', async () => {
      const cal = `cal_${uniq()}`;
      const a = await createBooking(db, owner, { calendar_id: cal, start_utc: at(9), end_utc: at(10) });
      const b = await createBooking(db, owner, { calendar_id: cal, start_utc: at(9, 30), end_utc: at(10, 30) });
      await db.query(`update public.bookings set status = 'RECHECKING_SLOT' where id = $1`, [a.id]);
      await expect(
        db.query(`update public.bookings set status = 'RECHECKING_SLOT' where id = $1`, [b.id]),
      ).rejects.toThrow(/bookings_no_overlap/);
    });

    it('back to back and non-overlapping slots can both exist', async () => {
      const cal = `cal_${uniq()}`;
      await createBooking(db, owner, { calendar_id: cal, status: 'RECHECKING_SLOT', start_utc: at(12), end_utc: at(13) });
      await createBooking(db, owner, { calendar_id: cal, status: 'RECHECKING_SLOT', start_utc: at(13), end_utc: at(14) });
      await createBooking(db, owner, { calendar_id: cal, status: 'BOOKED_VERIFIED', google_event_id: `e${uniq()}`, start_utc: at(15), end_utc: at(16) });
    });

    it('the same time on another calendar does not block', async () => {
      await createBooking(db, owner, { calendar_id: `cal_${uniq()}`, status: 'RECHECKING_SLOT', start_utc: at(17), end_utc: at(18) });
      await createBooking(db, owner, { calendar_id: `cal_${uniq()}`, status: 'RECHECKING_SLOT', start_utc: at(17), end_utc: at(18) });
    });

    it('a REJECTED (or other inactive) booking does not block', async () => {
      const cal = `cal_${uniq()}`;
      await createBooking(db, owner, { calendar_id: cal, status: 'REJECTED', start_utc: at(19), end_utc: at(20) });
      await createBooking(db, owner, { calendar_id: cal, status: 'SLOT_CONFLICT', start_utc: at(19), end_utc: at(20) });
      await createBooking(db, owner, { calendar_id: cal, status: 'BOOKED_VERIFIED', google_event_id: `e${uniq()}`, start_utc: at(19), end_utc: at(20) });
    });
  });

  it('business_facts holds at most one verified fact per business, kind and key', async () => {
    const key = `mon_${uniq()}`;
    const base = { business_id: owner.businessId, kind: 'hours', key, value: { open: '11:00', close: '21:00' }, source_type: 'seed' };
    const v1 = await insert(db, 'business_facts', { ...base, status: 'verified', verified_at: new Date(), version: 1 });
    await expect(
      insert(db, 'business_facts', { ...base, status: 'verified', verified_at: new Date(), version: 2 }),
    ).rejects.toThrow(/business_facts_one_verified/);
    // Drafts never collide, and the supersede-then-verify order works.
    const draft = await insert(db, 'business_facts', { ...base, source_type: 'owner_chat', status: 'draft' });
    await insert(db, 'business_facts', { ...base, source_type: 'upload', status: 'draft' });
    await db.query(`update public.business_facts set status = 'superseded' where id = $1`, [v1.id]);
    await db.query(
      `update public.business_facts set status = 'verified', verified_at = now(), version = 2, supersedes_id = $2 where id = $1`,
      [draft.id, v1.id],
    );
    const { rows } = await db.query(
      `select count(*)::int as n from public.business_facts where business_id = $1 and key = $2 and status = 'verified'`,
      [owner.businessId, key],
    );
    expect(rows[0]).toEqual({ n: 1 });
  });

  describe('agent_versions', () => {
    it('a published version cannot be updated or deleted', async () => {
      await expect(
        db.query(`update public.agent_versions set spec = '{"changed": true}' where id = $1`, [owner.agentVersionId]),
      ).rejects.toThrow(/published and immutable/);
      await expect(
        db.query(`delete from public.agent_versions where id = $1`, [owner.agentVersionId]),
      ).rejects.toThrow(/published and immutable/);
    });

    it('a draft version can be updated, and publishing it once is allowed', async () => {
      const v = await insert(db, 'agent_versions', {
        business_id: owner.businessId, agent_id: owner.agentId, version: 100 + slot++, spec: { draft: true },
      });
      await db.query(`update public.agent_versions set spec = '{"draft": false}' where id = $1`, [v.id]);
      await db.query(`update public.agent_versions set published_at = now() where id = $1`, [v.id]);
      await expect(
        db.query(`update public.agent_versions set spec = '{}' where id = $1`, [v.id]),
      ).rejects.toThrow(/published and immutable/);
    });

    it('no session setting unlocks a published version; only TRUNCATE (the reset path) removes it', async () => {
      await expect(
        db.transaction(async (tx) => {
          await tx.query(`set local app.allow_reset = 'on'`);
          await tx.query(`delete from public.agent_versions where id = $1`, [owner.agentVersionId]);
        }),
      ).rejects.toThrow(/published and immutable/);
      const fresh = await createMigratedDb();
      try {
        await createOwner(fresh);
        await fresh.exec('truncate public.agents, public.agent_versions cascade');
        const { rows } = await fresh.query(`select count(*)::int as n from public.agent_versions`);
        expect(rows[0]).toEqual({ n: 0 });
      } finally {
        await fresh.close();
      }
    });
  });

  it('an agent referenced by an activity event cannot be deleted, and the event keeps its agent_id', async () => {
    const agent = await insert(db, 'agents', { business_id: owner.businessId, name: 'Draft', template: 'custom' });
    const e = await insert(db, 'activity_events', {
      business_id: owner.businessId, type: 'agent.paused', agent_id: agent.id, correlation_id: 'bld_x', actor_type: 'owner',
    });
    await expect(db.query(`delete from public.agents where id = $1`, [agent.id])).rejects.toThrow(/foreign key/);
    const { rows } = await db.query(`select agent_id from public.activity_events where id = $1`, [e.id]);
    expect(rows[0]).toEqual({ agent_id: agent.id });
    // An agent with no events can still be deleted.
    const unused = await insert(db, 'agents', { business_id: owner.businessId, name: 'Unused', template: 'custom' });
    await db.query(`delete from public.agents where id = $1`, [unused.id]);
  });

  it('activity_events rejects UPDATE and DELETE', async () => {
    const e = await insert(db, 'activity_events', {
      business_id: owner.businessId, type: 'call.started', correlation_id: owner.callId, actor_type: 'system',
    });
    await expect(
      db.query(`update public.activity_events set payload = '{"x": 1}' where id = $1`, [e.id]),
    ).rejects.toThrow(/append only/);
    await expect(db.query(`delete from public.activity_events where id = $1`, [e.id])).rejects.toThrow(/append only/);
  });

  it('message_dispatches.channel rejects qr_only and its idempotency key is unique', async () => {
    await expect(dispatchIn('QUEUED', 'qr_only')).rejects.toThrow(CHECK_VIOLATION);
    const key = hex64();
    await dispatchIn('QUEUED', 'surge', key);
    await expect(dispatchIn('QUEUED', 'whatsapp_sandbox', key)).rejects.toThrow(UNIQUE_VIOLATION);
  });

  it('message_dispatches must carry the approval and business of its execution', async () => {
    const order = await createOrder(db, owner);
    const approval = await createApprovedApproval(db, owner, { subject_id: order.id });
    const otherApproval = await createApprovedApproval(db, owner);
    const exe = await createExecution(db, owner, String(approval.id), { action_type: 'message.checkout.send', step_index: 1 });
    const other = await createOwner(db);
    const base = {
      execution_id: exe.id, order_id: order.id, channel: 'surge', recipient: '+15555550123',
      template: 'checkout_link', body_hash: hash(),
    };
    await expect(
      insert(db, 'message_dispatches', { ...base, business_id: owner.businessId, approval_id: otherApproval.id, idempotency_key: hex64() }),
    ).rejects.toThrow(/message_dispatches_execution_approval_fk/);
    await expect(
      insert(db, 'message_dispatches', { ...base, business_id: other.businessId, approval_id: approval.id, idempotency_key: hex64() }),
    ).rejects.toThrow(/message_dispatches_execution_approval_fk/);
    await insert(db, 'message_dispatches', { ...base, business_id: owner.businessId, approval_id: approval.id, idempotency_key: hex64() });
  });

  it('message_dispatches cannot be marked SENT without a provider message ID', async () => {
    const d = await dispatchIn('QUEUED');
    await expect(
      db.query(`update public.message_dispatches set status = 'SENT', provider_message_id = null where id = $1`, [d.id]),
    ).rejects.toThrow(CHECK_VIOLATION);
  });

  it('orders: a Square order ID and a payment link ID each attach to one order only', async () => {
    const sqo = `sqo_${uniq()}`;
    const sql = `sql_${uniq()}`;
    await createOrder(db, owner, { square_order_id: sqo, square_payment_link_id: sql });
    await expect(createOrder(db, owner, { square_order_id: sqo })).rejects.toThrow(/orders_square_order_id_key/);
    await expect(createOrder(db, owner, { square_payment_link_id: sql })).rejects.toThrow(/orders_square_payment_link_id_key/);
    // Orders with no Square IDs yet do not collide.
    await createOrder(db, owner);
    await createOrder(db, owner);
  });

  it('orders cannot reach a paid state without a Square payment ID', async () => {
    const s = uniq();
    await expect(
      createOrder(db, owner, {
        status: 'PAID_VERIFIED', square_order_id: `sqo_${s}`, square_payment_link_id: `sql_${s}`, checkout_url: 'https://example.test',
      }),
    ).rejects.toThrow(/orders_paid_states_need_payment/);
  });

  it('approval_requests pins each bundle type to its SPEC 2.3 step list', async () => {
    await expect(
      createApproval(db, owner, { bundle_type: 'order_bundle', action_bundle: ['square.checkout.create', 'local.order.record'] }),
    ).rejects.toThrow(/approval_requests_bundle_matches_type/);
    await createApproval(db, owner, { bundle_type: 'booking_bundle', action_bundle: BOOKING_BUNDLE });
  });

  it('capabilities cannot store a write or message capability that skips approval', async () => {
    const base = { description: 'x', handler_id: 'h', input_schema: {}, output_schema: {}, tier: 'MUST' };
    await expect(
      insert(db, 'capabilities', { ...base, id: 'message.checkout.send', effect: 'external_message', approval_mode: 'none' }),
    ).rejects.toThrow(/capabilities_write_requires_approval/);
    await insert(db, 'capabilities', { ...base, id: 'catalog.read', effect: 'read', approval_mode: 'none' });
  });
});
