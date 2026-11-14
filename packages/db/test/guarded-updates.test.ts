import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimExecution, claimNextExecution, decideApproval, expireApprovals, recordWebhookEvent,
} from '../src/guarded-updates';
import {
  BOOKING_BUNDLE, createApproval, createBooking, createExecution, createMigratedDb, createOrder, createOwner,
  hex64, uniq, type Owner,
} from './helpers';

let db: PGlite;
let owner: Owner;

beforeAll(async () => {
  db = await createMigratedDb();
  owner = await createOwner(db);
});
afterAll(async () => {
  await db.close();
});

const past = () => new Date(Date.now() - 60_000);

describe('decideApproval: one-use approval', () => {
  it('succeeds once; a second attempt changes zero rows', async () => {
    const a = await createApproval(db, owner);
    const args = {
      approvalId: String(a.id), businessId: owner.businessId, ownerUserId: owner.userId, payloadHash: String(a.payload_hash),
    };
    const first = await decideApproval(db, { ...args, decision: 'APPROVED' });
    expect(first?.state).toBe('APPROVED');
    expect(first?.decided_by).toBe(owner.userId);
    expect(first?.decided_at).toBeInstanceOf(Date);
    expect(await decideApproval(db, { ...args, decision: 'APPROVED' })).toBeNull();
    expect(await decideApproval(db, { ...args, decision: 'REJECTED' })).toBeNull();
    const { rows } = await db.query(`select state from public.approval_requests where id = $1`, [a.id]);
    expect(rows[0]).toEqual({ state: 'APPROVED' });
  });

  it('changes zero rows when the request has expired', async () => {
    const a = await createApproval(db, owner, { expires_at: past() });
    expect(
      await decideApproval(db, {
        approvalId: String(a.id), businessId: owner.businessId, decision: 'APPROVED', ownerUserId: owner.userId,
        payloadHash: String(a.payload_hash),
      }),
    ).toBeNull();
  });

  it('changes zero rows when the payload hash does not match', async () => {
    const a = await createApproval(db, owner);
    expect(
      await decideApproval(db, {
        approvalId: String(a.id), businessId: owner.businessId, decision: 'APPROVED', ownerUserId: owner.userId,
        payloadHash: `sha256:${'0'.repeat(64)}`,
      }),
    ).toBeNull();
    const { rows } = await db.query(`select state from public.approval_requests where id = $1`, [a.id]);
    expect(rows[0]).toEqual({ state: 'PENDING' });
  });

  it('changes zero rows for another business', async () => {
    const other = await createOwner(db);
    const a = await createApproval(db, owner);
    expect(
      await decideApproval(db, {
        approvalId: String(a.id), businessId: other.businessId, decision: 'APPROVED', ownerUserId: other.userId,
        payloadHash: String(a.payload_hash),
      }),
    ).toBeNull();
  });

  it('records a rejection with its reason', async () => {
    const a = await createApproval(db, owner);
    const row = await decideApproval(db, {
      approvalId: String(a.id), businessId: owner.businessId, decision: 'REJECTED', ownerUserId: owner.userId,
      payloadHash: String(a.payload_hash), reason: 'out of dough',
    });
    expect(row?.state).toBe('REJECTED');
    expect(row?.decision_reason).toBe('out of dough');
  });
});

describe('claimExecution: only one worker owns an execution', () => {
  it('the first claim wins; a second claim returns nothing', async () => {
    const a = await createApproval(db, owner);
    const e = await createExecution(db, owner, String(a.id));
    const first = await claimExecution(db, { executionId: String(e.id), workerId: 'worker-a' });
    expect(first?.status).toBe('RUNNING');
    expect(first?.attempts).toBe(1);
    expect(first?.locked_by).toBe('worker-a');
    expect(await claimExecution(db, { executionId: String(e.id), workerId: 'worker-b' })).toBeNull();
  });

  it('a step waits until the step before it succeeded', async () => {
    const a = await createApproval(db, owner);
    const step0 = await createExecution(db, owner, String(a.id));
    const step1 = await createExecution(db, owner, String(a.id), { action_type: 'message.checkout.send', step_index: 1 });
    const step2 = await createExecution(db, owner, String(a.id), { action_type: 'local.order.record', step_index: 2 });
    expect(await claimExecution(db, { executionId: String(step1.id), workerId: 'w' })).toBeNull();
    await claimExecution(db, { executionId: String(step0.id), workerId: 'w' });
    await db.query(`update public.action_executions set status = 'SUCCEEDED', finished_at = now() where id = $1`, [step0.id]);
    // qr_only: the message step is SKIPPED, which still lets local.order.record run.
    await db.query(`update public.action_executions set status = 'SKIPPED' where id = $1`, [step1.id]);
    expect((await claimExecution(db, { executionId: String(step2.id), workerId: 'w' }))?.status).toBe('RUNNING');
  });

  it('a step that is not due yet is not claimed', async () => {
    const a = await createApproval(db, owner);
    const e = await createExecution(db, owner, String(a.id), { next_attempt_at: new Date(Date.now() + 60_000) });
    expect(await claimExecution(db, { executionId: String(e.id), workerId: 'w' })).toBeNull();
  });

  it('a fourth attempt is refused by the database', async () => {
    const a = await createApproval(db, owner);
    const e = await createExecution(db, owner, String(a.id), { attempts: 3 });
    await expect(claimExecution(db, { executionId: String(e.id), workerId: 'w' })).rejects.toThrow(/violates check constraint/);
  });

  it('claimNextExecution takes one due row and never the same row twice', async () => {
    const fresh = await createMigratedDb();
    try {
      const o = await createOwner(fresh);
      const a = await createApproval(fresh, o);
      await createExecution(fresh, o, String(a.id));
      await createExecution(fresh, o, String(a.id), { action_type: 'message.checkout.send', step_index: 1 });
      const first = await claimNextExecution(fresh, { workerId: 'w1' });
      expect(first?.step_index).toBe(0);
      // Step 1 waits for step 0, so nothing else is claimable.
      expect(await claimNextExecution(fresh, { workerId: 'w2' })).toBeNull();
    } finally {
      await fresh.close();
    }
  });
});

describe('recordWebhookEvent: record a provider event once', () => {
  it('the first insert returns the row; a replay returns null', async () => {
    const args = { source: 'square' as const, providerEventId: `sq_${uniq()}`, eventType: 'payment.updated', payload: { status: 'COMPLETED' } };
    const first = await recordWebhookEvent(db, args);
    expect(first?.provider_event_id).toBe(args.providerEventId);
    expect(await recordWebhookEvent(db, args)).toBeNull();
    const { rows } = await db.query(
      `select count(*)::int as n from public.webhook_events where provider_event_id = $1`, [args.providerEventId],
    );
    expect(rows[0]).toEqual({ n: 1 });
  });
});

describe('expireApprovals: the expiry sweep', () => {
  it('expires only overdue PENDING approvals and moves their order or booking', async () => {
    const order = await createOrder(db, owner);
    const overdueOrder = await createApproval(db, owner, { subject_id: order.id, expires_at: past() });
    await db.query(`update public.orders set approval_id = $1 where id = $2`, [overdueOrder.id, order.id]);

    const booking = await createBooking(db, owner, { calendar_id: `cal_${uniq()}` });
    const overdueBooking = await createApproval(db, owner, {
      subject_id: booking.id, bundle_type: 'booking_bundle', action_bundle: BOOKING_BUNDLE, expires_at: past(),
    });
    const notDue = await createApproval(db, owner);
    const decidedOverdue = await createApproval(db, owner, {
      expires_at: past(), state: 'APPROVED', decided_at: new Date(), decided_by: owner.userId,
    });

    const swept = await expireApprovals(db);
    const ids = swept.map((r) => r.id);
    expect(ids).toContain(overdueOrder.id);
    expect(ids).toContain(overdueBooking.id);
    expect(ids).not.toContain(notDue.id);
    expect(ids).not.toContain(decidedOverdue.id);
    expect(swept.find((r) => r.id === overdueOrder.id)?.subject_moved).toBe(true);

    const states = await db.query(
      `select (select state from public.approval_requests where id = $1) as apv,
              (select status from public.orders where id = $2) as ord,
              (select status from public.bookings where id = $3) as bkg,
              (select decided_at is not null from public.approval_requests where id = $1) as stamped`,
      [overdueOrder.id, order.id, booking.id],
    );
    expect(states.rows[0]).toEqual({ apv: 'EXPIRED', ord: 'APPROVAL_EXPIRED', bkg: 'EXPIRED', stamped: true });

    // An expired approval can no longer be decided.
    expect(
      await decideApproval(db, {
        approvalId: String(overdueOrder.id), businessId: owner.businessId, decision: 'APPROVED', ownerUserId: owner.userId,
        payloadHash: String(overdueOrder.payload_hash),
      }),
    ).toBeNull();
    // Running the sweep again finds nothing new.
    expect((await expireApprovals(db)).map((r) => r.id)).not.toContain(overdueOrder.id);
  });

  it('keeps idempotency keys stable: the claim never rewrites the key', async () => {
    const a = await createApproval(db, owner);
    const key = hex64();
    const e = await createExecution(db, owner, String(a.id), { idempotency_key: key });
    const claimed = await claimExecution(db, { executionId: String(e.id), workerId: 'w' });
    expect(claimed?.idempotency_key).toBe(key);
  });
});
