// Migration 0007 (SPEC D-12): AgentPhone as a message channel and a webhook source. Additive only.
// Runs on local PGlite; the application statements run as abos_app.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { ORDER_BUNDLE, createMigratedDb, createOrder, createOwner, createSupabaseLikeDb, insert, migrationDb, uniq } from './helpers';
import { applyMigrations, readMigrations } from '../src/migrate';
import * as runtime from '../src/runtime';

let db: PGlite;
beforeAll(async () => { db = await createMigratedDb(); }, 60_000);
afterAll(async () => { await db.close(); });
const hash = (s: string) => 'sha256:' + createHash('sha256').update(s).digest('hex');
async function as<T>(target: PGlite, role: string, fn: () => Promise<T>): Promise<T> {
  await target.exec(`set role ${role}`);
  try { return await fn(); } finally { await target.exec('reset role'); }
}

async function approvedOrder(target: PGlite, messageChannel: string) {
  const owner = await createOwner(target);
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const subject = await createOrder(target, owner);
  const payload = { businessId: owner.businessId, subjectId: String(subject.id), agentVersionId: owner.agentVersionId, cartHash: subject.cart_hash,
    totalMinor: 1200, currency: 'USD', pickupAt: null, messageRecipient: '+15555550123', messageChannel, actionBundle: ORDER_BUNDLE, expiresAt };
  const canonical = JSON.stringify(payload);
  return as(target, 'abos_app', async () => {
    const a = await runtime.createApproval(target, { businessId: owner.businessId, bundleType: 'order_bundle', subjectId: String(subject.id),
      actorType: 'deployed_agent', actorId: owner.agentVersionId, payload, canonical, payloadHash: hash(canonical), actionBundle: ORDER_BUNDLE, expiresAt });
    const { executions } = await runtime.runtimeDecideAndEnqueue(target, { businessId: owner.businessId, approvalId: a.id,
      ownerUserId: owner.userId, payloadHash: a.payload_hash, decision: 'APPROVED' });
    return { businessId: owner.businessId, subjectId: String(subject.id), executions };
  });
}

describe('0007 agentphone channel', () => {
  it('follows 0006, is followed only by 0008, and applies on top of 0006 without touching existing rows', async () => {
    const names = readMigrations().map((f) => f.name);
    expect(names[6]).toBe('0007_agentphone_channel.sql');
    expect(names.slice(7)).toEqual(['0008_owner_recovery.sql']);
    const fresh = await createSupabaseLikeDb();
    try {
      await fresh.exec('set role supabase_postgres');
      await applyMigrations(migrationDb(fresh), readMigrations().slice(0, 6));
      await fresh.exec('reset role');
      await as(fresh, 'abos_app', () => insert(fresh, 'webhook_events', { source: 'square', provider_event_id: 'ev-' + uniq(), event_type: 'payment.updated' }));
      const before = (await fresh.query<{ n: number }>('select count(*)::int n from public.webhook_events')).rows[0]!.n;
      await fresh.exec('set role supabase_postgres');
      expect((await applyMigrations(migrationDb(fresh))).applied).toEqual(['0007_agentphone_channel.sql', '0008_owner_recovery.sql']);
      await fresh.exec('reset role');
      expect((await fresh.query<{ n: number }>('select count(*)::int n from public.webhook_events')).rows[0]!.n).toBe(before);
    } finally { await fresh.close(); }
  }, 60_000);

  it('stores a signature-verified agentphone webhook row once per provider event ID and still refuses an unknown source', async () => {
    const id = 'whd_' + uniq();
    await as(db, 'abos_app', async () => {
      const first = await db.query(`insert into public.webhook_events (source, provider_event_id, event_type) values ('agentphone', $1, 'agent.call_ended')
        on conflict (source, provider_event_id) do nothing returning id`, [id]);
      const again = await db.query(`insert into public.webhook_events (source, provider_event_id, event_type) values ('agentphone', $1, 'agent.call_ended')
        on conflict (source, provider_event_id) do nothing returning id`, [id]);
      expect(first.rows).toHaveLength(1);
      expect(again.rows).toHaveLength(0);
      await expect(db.query("insert into public.webhook_events (source, provider_event_id, event_type) values ('telnyx', $1, 'x')", ['x-' + uniq()])).rejects.toThrow(/webhook_events_source_check/);
    });
  });

  it('accepts an order approval on agentphone, records its dispatch, and a receipt moves it to DELIVERED', async () => {
    const p = await approvedOrder(db, 'agentphone');
    const checkout = { businessId: p.businessId, executionId: p.executions[0]!.id, workerId: 'w', attempt: 1 };
    const message = { businessId: p.businessId, executionId: p.executions[1]!.id, workerId: 'm', attempt: 1 };
    const providerId = 'msg_' + uniq();
    const delivered = await as(db, 'abos_app', async () => {
      await runtime.runtimeClaimExecution(db, checkout);
      await runtime.saveCheckout(db, { ...checkout, squareOrderId: 'sq-' + p.subjectId, paymentLinkId: 'link-' + p.subjectId, url: 'https://example.test/c' });
      await runtime.finishExecution(db, { ...checkout, status: 'SUCCEEDED', externalRef: 'sq-' + p.subjectId });
      await runtime.runtimeClaimExecution(db, message);
      const d = await runtime.recordDispatch(db, { ...message, bodyHash: hash('body') });
      expect(d.channel).toBe('agentphone');
      await runtime.updateDispatch(db, { ...message, dispatchId: d.id, status: 'SENT', providerMessageId: providerId });
      await runtime.finishExecution(db, { ...message, status: 'SUCCEEDED', externalRef: providerId });
      return runtime.updateDispatchStatus(db, { businessId: p.businessId, dispatchId: d.id, status: 'DELIVERED' });
    });
    expect(delivered.status).toBe('DELIVERED');
  });

  it('still refuses a message channel that is not listed', async () => {
    await expect(approvedOrder(db, 'telnyx')).rejects.toThrow(/MATERIAL: message routing/);
    await expect(db.query("select private.material('order_bundle', '{}'::jsonb)")).rejects.toThrow();
    const def = (await db.query<{ d: string }>("select pg_get_constraintdef(oid) d from pg_constraint where conname = 'message_dispatches_channel_check'")).rows[0]!.d;
    for (const c of ['surge', 'android_gateway', 'whatsapp_sandbox', 'agentphone']) expect(def).toContain(`'${c}'`);
  });
});
