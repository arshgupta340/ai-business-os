// 0006 receipts: a WhatsApp delivery receipt that arrives while the send step is still RUNNING is
// deferred (update_dispatch_status raises the retryable receipt error). The webhook row stays
// unprocessed, the step is not blocked, and recovery applies the receipt later.
import twilio from 'twilio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENDPOINTS, type Cart, type Quote, type ToolResult } from '@abos/contracts';
import { isRetryableReceiptError, updateDispatchStatus } from '@abos/db';
import { createDbExecutor } from '../../src/compose/executor';
import { notWiredExecutor, type SeamDeps } from '../../src/compose/seams';
import type { Db } from '../../src/db/index';
import { OWNER, PUBLIC_URL, createWorld, nextLocalDate, zonedIso, type World } from './world';

const PIZZA = 'biz_pizza_01';
const TOKEN = 'test-twilio-token';
const CART: Cart = { lines: [{ catalogItemId: 'SQ_ITEM_PEP', variationId: 'SQ_VAR_PEP_LG', quantity: 1, modifierIds: [] }] };
const silentLog: SeamDeps['log'] = { info() {}, warn() {}, error() {} };

describe('a delivery receipt that arrives before the send step finishes', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld({ executor: notWiredExecutor }, { TWILIO_AUTH_TOKEN: TOKEN, TWILIO_ACCOUNT_SID: 'ACtest', OPENAI_API_KEY: 'test-openai-key' });
    // WhatsApp sandbox is the one channel with delivery receipts; the fake sender stands in for it.
    (w.messages.adapter as { channel: string }).channel = 'whatsapp_sandbox';
    (w.app.composed.providers as { messageChannel: string }).messageChannel = 'whatsapp_sandbox';
  }, 120_000);
  afterAll(async () => { await w?.close(); });

  async function receipt(messageSid: string, status: string) {
    const params = { MessageSid: messageSid, MessageStatus: status };
    const url = `${PUBLIC_URL}/webhooks/twilio/status`;
    const signature = twilio.getExpectedTwilioSignature(TOKEN, url, params);
    const res = await w.app.inject({ method: 'POST', url: '/webhooks/twilio/status', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature },
      payload: new URLSearchParams(params).toString() });
    expect(res.statusCode).toBe(204);
    await new Promise((r) => setImmediate(r));
    await w.app.composed.webhooks!.idle();
  }

  it('does not block the step, stays unprocessed, and is applied on recovery', async () => {
    let quote: Quote | undefined;
    w.model.push(async ({ executeTool }) => { const r = await executeTool('quote_order', { cart: CART }) as ToolResult<'quote_order'>; if (r.ok) quote = r.quote; return 'quoted'; }, async () => 'bye');
    const first = (await w.app.inject({ method: 'POST', url: `/api/agents/agt_pizza_01/sim-call?businessId=${PIZZA}`, headers: OWNER, payload: { message: 'One large pepperoni' } })).json() as { callId: string };
    const call = (await w.t.db.query('select agent_version_id from calls where id = $1', [first.callId])).rows[0] as { agent_version_id: string };
    const c = w.app.composed;
    const { approval } = await c.engine.createOrderProposal({ businessId: PIZZA, callId: first.callId, agentVersionId: call.agent_version_id, cart: CART, quote: quote!,
      contact: { name: 'Sam', messageRecipient: '+15555550123', messageConsent: true, consentAt: new Date().toISOString() },
      fulfillment: { type: 'pickup', pickupAt: zonedIso(nextLocalDate([0, 1, 2, 3, 4, 5, 6]), '18:00', 'America/Los_Angeles') }, messageChannel: 'whatsapp_sandbox' });
    const list = ENDPOINTS.listApprovals.response.parse((await w.app.inject({ url: `/api/approvals?businessId=${PIZZA}`, headers: OWNER })).json());
    const a = list.items.find((x) => x.id === approval.id)!;
    expect((await w.app.inject({ method: 'POST', url: `/api/approvals/${approval.id}/decision?businessId=${PIZZA}`, headers: OWNER, payload: { decision: 'approve', payloadHash: a.payloadHash } })).statusCode).toBe(200);

    // After the dispatch is recorded SENT (its own transaction) and before the step finishes, a FAILED
    // receipt arrives and its job runs to the end.
    const db = c.db as Db;
    const original = db.transaction.bind(db);
    let injected = false;
    db.transaction = async (fn) => {
      let sent = false;
      const result = await original((tx) => fn({ query: (text, params) => { if (text.includes('private.update_dispatch(')) sent = true; return tx.query(text, params); } }));
      if (sent && !injected) {
        injected = true;
        const d = (await w.t.db.query("select provider_message_id from message_dispatches where approval_id = $1", [approval.id])).rows[0] as { provider_message_id: string };
        const row = (await w.t.db.query("select id from message_dispatches where approval_id = $1", [approval.id])).rows[0] as { id: string };
        // The routine itself defers it at this point (the step is RUNNING).
        await expect(updateDispatchStatus(w.t.db, { businessId: PIZZA, dispatchId: row.id, status: 'FAILED' })).rejects.toSatisfy(isRetryableReceiptError);
        await receipt(d.provider_message_id, 'failed');
      }
      return result;
    };
    const executor = createDbExecutor({ env: c.env, db: c.db, engine: c.engine, providers: c.providers, now: c.now, newId: c.newId, log: silentLog }, { workerId: 'worker-rcpt' });
    try { await executor.drain(); } finally { db.transaction = original; await executor.stop(); }
    expect(injected).toBe(true);

    const msgStep = (await w.t.db.query("select status from action_executions where approval_id = $1 and action_type = 'message.checkout.send'", [approval.id])).rows[0];
    expect(msgStep).toEqual({ status: 'SUCCEEDED' });
    expect((await w.t.db.query('select status from message_dispatches where approval_id = $1', [approval.id])).rows[0]).toEqual({ status: 'SENT' });
    const pending = "select count(*)::int as n from webhook_events where source = 'twilio_status' and processed_at is null";
    expect((await w.t.db.query(pending, [])).rows[0]).toEqual({ n: 1 });

    // Review finding 7: an unprocessed row older than the 15 minute payment window is still recovered.
    await w.t.admin((q) => q.query("update webhook_events set received_at = now() - interval '2 hours' where source = 'twilio_status' and processed_at is null"));
    // Recovery of stored but unprocessed rows (also what runs after a restart) applies it now.
    expect(await c.webhooks!.recoverNow()).toBe(1);
    expect((await w.t.db.query('select status from message_dispatches where approval_id = $1', [approval.id])).rows[0]).toEqual({ status: 'FAILED' });
    expect((await w.t.db.query(pending, [])).rows[0]).toEqual({ n: 0 });
  }, 30_000);
});
