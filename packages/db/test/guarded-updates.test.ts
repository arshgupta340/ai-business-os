import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordWebhookEvent } from '../src/guarded-updates';
// Issue #93: the administrator-only SQL helpers moved out of the package into this test file.
import { claimExecution, claimNextExecution, decideApproval, expireApprovals } from './legacy-admin-sql';
import {
  BOOKING_BUNDLE, createApproval, createApprovedApproval, createBooking, createExecution, createMigratedDb,
  createOrder, createOwner, hash, hex64, uniq, type Owner,
} from './helpers';

let db: PGlite;
let owner: Owner;
let other: Owner;

beforeAll(async () => {
  db = await createMigratedDb();
  owner = await createOwner(db);
  other = await createOwner(db);
});
afterAll(async () => {
  await db.close();
});

const past = () => new Date(Date.now() - 60_000);

function decideArgs(a: Record<string, unknown>, o: Owner = owner) {
  return {
    approvalId: String(a.id), businessId: o.businessId, ownerUserId: o.userId, payloadHash: String(a.payload_hash),
  };
}

describe('decideApproval: one-use approval', () => {
  it('succeeds once; a second attempt changes zero rows', async () => {
    const a = await createApproval(db, owner);
    const first = await decideApproval(db, { ...decideArgs(a), decision: 'APPROVED' });
    expect(first?.state).toBe('APPROVED');
    expect(first?.decided_by).toBe(owner.userId);
    expect(first?.decided_at).toBeInstanceOf(Date);
    expect(await decideApproval(db, { ...decideArgs(a), decision: 'APPROVED' })).toBeNull();
    expect(await decideApproval(db, { ...decideArgs(a), decision: 'REJECTED' })).toBeNull();
    const { rows } = await db.query(`select state from public.approval_requests where id = $1`, [a.id]);
    expect(rows[0]).toEqual({ state: 'APPROVED' });
  });

  it('changes zero rows when the request has expired', async () => {
    const a = await createApproval(db, owner, { expires_at: past() });
    expect(await decideApproval(db, { ...decideArgs(a), decision: 'APPROVED' })).toBeNull();
  });

  it('changes zero rows when the payload hash does not match', async () => {
    const a = await createApproval(db, owner);
    expect(
      await decideApproval(db, { ...decideArgs(a), payloadHash: `sha256:${'0'.repeat(64)}`, decision: 'APPROVED' }),
    ).toBeNull();
    const { rows } = await db.query(`select state from public.approval_requests where id = $1`, [a.id]);
    expect(rows[0]).toEqual({ state: 'PENDING' });
  });

  it('changes zero rows for another business', async () => {
    const a = await createApproval(db, owner);
    expect(await decideApproval(db, { ...decideArgs(a, other), payloadHash: String(a.payload_hash), decision: 'APPROVED' })).toBeNull();
  });

  it('changes zero rows when the deciding user does not own the business (right business and hash)', async () => {
    const a = await createApproval(db, owner);
    expect(await decideApproval(db, { ...decideArgs(a), ownerUserId: other.userId, decision: 'APPROVED' })).toBeNull();
    const { rows } = await db.query(`select state, decided_by from public.approval_requests where id = $1`, [a.id]);
    expect(rows[0]).toEqual({ state: 'PENDING', decided_by: null });
  });

  it('records a rejection with its reason', async () => {
    const a = await createApproval(db, owner);
    const row = await decideApproval(db, { ...decideArgs(a), decision: 'REJECTED', reason: 'out of dough' });
    expect(row?.state).toBe('REJECTED');
    expect(row?.decision_reason).toBe('out of dough');
  });
});

describe('approval_requests is bound to the payload the owner saw', () => {
  it('an approval cannot be created already decided', async () => {
    await expect(
      createApproval(db, owner, { state: 'APPROVED', decided_at: new Date(), decided_by: owner.userId }),
    ).rejects.toThrow(/must be created PENDING/);
  });

  it("an approved request's payload, hash, bundle, subject and expiry cannot change", async () => {
    const a = await createApprovedApproval(db, owner);
    const changes: [string, unknown][] = [
      ['payload', JSON.stringify({ businessId: owner.businessId, totalMinor: 1 })],
      ['payload_hash', hash()],
      ['action_bundle', ['local.fact.update']],
      ['subject_id', `ord_${uniq()}`],
      ['expires_at', new Date(Date.now() + 86_400_000)],
      ['business_id', other.businessId],
    ];
    for (const [column, value] of changes) {
      await expect(
        db.query(`update public.approval_requests set ${column} = $2 where id = $1`, [a.id, value]),
        column,
      ).rejects.toThrow(/already APPROVED, it cannot change/);
    }
  });

  it('a pending request cannot have its payload or hash changed either', async () => {
    const a = await createApproval(db, owner);
    await expect(
      db.query(`update public.approval_requests set payload_hash = $2 where id = $1`, [a.id, hash()]),
    ).rejects.toThrow(/only state and decision columns can change/);
    await expect(
      db.query(`update public.approval_requests set payload = '{}' where id = $1`, [a.id]),
    ).rejects.toThrow(/only state and decision columns can change/);
  });

  it('a decided request cannot be decided again or moved back to PENDING', async () => {
    const a = await createApprovedApproval(db, owner);
    await expect(
      db.query(`update public.approval_requests set state = 'PENDING', decided_at = null, decided_by = null where id = $1`, [a.id]),
    ).rejects.toThrow(/cannot change/);
    await expect(
      db.query(`update public.approval_requests set state = 'REJECTED' where id = $1`, [a.id]),
    ).rejects.toThrow(/cannot change/);
    const r = await createApproval(db, owner);
    await decideApproval(db, { ...decideArgs(r), decision: 'REJECTED' });
    await expect(
      db.query(`update public.approval_requests set state = 'APPROVED' where id = $1`, [r.id]),
    ).rejects.toThrow(/already REJECTED, it cannot change/);
  });
});

describe('action_executions exist only for an approved bundle', () => {
  it('an execution cannot be inserted for a PENDING, REJECTED or EXPIRED approval', async () => {
    const pending = await createApproval(db, owner);
    await expect(createExecution(db, owner, String(pending.id))).rejects.toThrow(/is PENDING, not APPROVED/);

    const rejected = await createApproval(db, owner);
    await decideApproval(db, { ...decideArgs(rejected), decision: 'REJECTED' });
    await expect(createExecution(db, owner, String(rejected.id))).rejects.toThrow(/is REJECTED, not APPROVED/);

    const expired = await createApproval(db, owner, { expires_at: past() });
    await expireApprovals(db);
    await expect(createExecution(db, owner, String(expired.id))).rejects.toThrow(/is EXPIRED, not APPROVED/);
  });

  it('an execution must be in the approval business', async () => {
    const a = await createApprovedApproval(db, owner);
    await expect(createExecution(db, other, String(a.id))).rejects.toThrow(/does not match the approval's business/);
  });

  it("an execution must be the approval's step at its position, with Sheets steps left out", async () => {
    const a = await createApprovedApproval(db, owner);
    await expect(
      createExecution(db, owner, String(a.id), { action_type: 'local.order.record', step_index: 0 }),
    ).rejects.toThrow(/step 0 of approval .* is not local.order.record/);
    // Step 3 would be sheets.order.append, which never gets a row; there is no step 3.
    await expect(
      createExecution(db, owner, String(a.id), { action_type: 'local.order.record', step_index: 3 }),
    ).rejects.toThrow(/is not local.order.record/);
    await expect(
      createExecution(db, owner, String(a.id), { action_type: 'calendar.event.create', step_index: 0 }),
    ).rejects.toThrow(/is not calendar.event.create/);
    await createExecution(db, owner, String(a.id), { action_type: 'local.order.record', step_index: 2 });
  });

  it('the identity and idempotency key of an execution cannot change after insert', async () => {
    const a = await createApprovedApproval(db, owner);
    const e = await createExecution(db, owner, String(a.id));
    await expect(
      db.query(`update public.action_executions set idempotency_key = $2 where id = $1`, [e.id, hex64()]),
    ).rejects.toThrow(/cannot change/);
    await expect(
      db.query(`update public.action_executions set step_index = 1, action_type = 'message.checkout.send' where id = $1`, [e.id]),
    ).rejects.toThrow(/cannot change/);
  });
});

describe('claimExecution: only one worker owns an execution, and only for an approved bundle', () => {
  it('the first claim wins; a second claim returns nothing', async () => {
    const a = await createApprovedApproval(db, owner);
    const e = await createExecution(db, owner, String(a.id));
    const first = await claimExecution(db, { executionId: String(e.id), workerId: 'worker-a' });
    expect(first?.status).toBe('RUNNING');
    expect(first?.attempts).toBe(1);
    expect(first?.locked_by).toBe('worker-a');
    expect(first?.idempotency_key).toBe(e.idempotency_key);
    expect(await claimExecution(db, { executionId: String(e.id), workerId: 'worker-b' })).toBeNull();
  });

  it('a step waits until the step before it succeeded; a skipped message step does not block', async () => {
    const a = await createApprovedApproval(db, owner);
    const step0 = await createExecution(db, owner, String(a.id));
    const step1 = await createExecution(db, owner, String(a.id), { action_type: 'message.checkout.send', step_index: 1 });
    const step2 = await createExecution(db, owner, String(a.id), { action_type: 'local.order.record', step_index: 2 });
    expect(await claimExecution(db, { executionId: String(step1.id), workerId: 'w' })).toBeNull();
    await claimExecution(db, { executionId: String(step0.id), workerId: 'w' });
    expect(await claimExecution(db, { executionId: String(step1.id), workerId: 'w' })).toBeNull();
    await db.query(`update public.action_executions set status = 'SUCCEEDED', finished_at = now() where id = $1`, [step0.id]);
    // qr_only: the message step is SKIPPED, which still lets local.order.record run.
    await db.query(`update public.action_executions set status = 'SKIPPED' where id = $1`, [step1.id]);
    expect((await claimExecution(db, { executionId: String(step2.id), workerId: 'w' }))?.status).toBe('RUNNING');
  });

  it('a missing earlier step blocks a later one', async () => {
    const a = await createApprovedApproval(db, owner);
    // Only step 2 exists; steps 0 and 1 were never inserted.
    const step2 = await createExecution(db, owner, String(a.id), { action_type: 'local.order.record', step_index: 2 });
    expect(await claimExecution(db, { executionId: String(step2.id), workerId: 'w' })).toBeNull();
    // Step 0 alone, succeeded, still leaves step 1 missing.
    const step0 = await createExecution(db, owner, String(a.id));
    await db.query(`update public.action_executions set status = 'SUCCEEDED', finished_at = now() where id = $1`, [step0.id]);
    expect(await claimExecution(db, { executionId: String(step2.id), workerId: 'w' })).toBeNull();
  });

  it('a step that is not due yet is not claimed', async () => {
    const a = await createApprovedApproval(db, owner);
    const e = await createExecution(db, owner, String(a.id), { next_attempt_at: new Date(Date.now() + 60_000) });
    expect(await claimExecution(db, { executionId: String(e.id), workerId: 'w' })).toBeNull();
  });

  it('a fourth attempt is refused by the database', async () => {
    const a = await createApprovedApproval(db, owner);
    const e = await createExecution(db, owner, String(a.id), { attempts: 3 });
    await expect(claimExecution(db, { executionId: String(e.id), workerId: 'w' })).rejects.toThrow(/violates check constraint/);
  });

  it('claimNextExecution takes one claimable row and never the same row twice', async () => {
    const fresh = await createMigratedDb();
    try {
      const o = await createOwner(fresh);
      const a = await createApprovedApproval(fresh, o);
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

  it('the claim itself refuses pending, rejected, cross-business and wrong-step rows that bypassed the insert check', async () => {
    const fresh = await createMigratedDb();
    try {
      const o = await createOwner(fresh);
      const o2 = await createOwner(fresh);
      const pending = await createApproval(fresh, o);
      const rejected = await createApproval(fresh, o);
      await decideApproval(fresh, { ...decideArgs(rejected, o), decision: 'REJECTED' });
      const approved = await createApprovedApproval(fresh, o);
      const approved2 = await createApprovedApproval(fresh, o);
      // Second wall: turn the insert trigger off to plant rows a buggy writer might leave behind.
      await fresh.exec('alter table public.action_executions disable trigger action_executions_match_approval');
      const planted = [
        await createExecution(fresh, o, String(pending.id)),
        await createExecution(fresh, o, String(rejected.id)),
        await createExecution(fresh, o2, String(approved.id)),
        await createExecution(fresh, o, String(approved2.id), { action_type: 'local.order.record', step_index: 0 }),
      ];
      await fresh.exec('alter table public.action_executions enable trigger action_executions_match_approval');
      for (const e of planted) {
        expect(await claimExecution(fresh, { executionId: String(e.id), workerId: 'w' }), String(e.approval_id)).toBeNull();
      }
      expect(await claimNextExecution(fresh, { workerId: 'w' })).toBeNull();
    } finally {
      await fresh.close();
    }
  });

  it('claimNextExecution skips a queued row whose approval is no longer valid', async () => {
    const fresh = await createMigratedDb();
    try {
      const o = await createOwner(fresh);
      const a = await createApprovedApproval(fresh, o);
      await createExecution(fresh, o, String(a.id));
      // Simulate a row that slipped past the insert trigger: decided after it expired.
      await fresh.exec('alter table public.approval_requests disable trigger approval_requests_guard');
      await fresh.query(`update public.approval_requests set decided_at = expires_at + interval '1 second' where id = $1`, [a.id]);
      await fresh.exec('alter table public.approval_requests enable trigger approval_requests_guard');
      expect(await claimNextExecution(fresh, { workerId: 'w' })).toBeNull();
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
    const decided = await createApprovedApproval(db, owner);

    const swept = await expireApprovals(db);
    const ids = swept.map((r) => r.id);
    expect(ids).toContain(overdueOrder.id);
    expect(ids).toContain(overdueBooking.id);
    expect(ids).not.toContain(notDue.id);
    expect(ids).not.toContain(decided.id);
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
    expect(await decideApproval(db, { ...decideArgs(overdueOrder), decision: 'APPROVED' })).toBeNull();
    // Running the sweep again finds nothing new.
    expect((await expireApprovals(db)).map((r) => r.id)).not.toContain(overdueOrder.id);
  });
});
