// Issue #95 item 8, on the composed server: the phone relay with the real toolset, the approval engine
// and the test database as abos_app. A caller who keeps changing the cart and saying yes gets a bounded
// number of approvals, and the refused proposal is in the activity feed. No provider is called.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../../src/voice/relay';
import { NONE, PIZZA, VOICE_ENV, captureLog, counts, phoneCall, phoneRelay, pickupAt, sim } from '../adversarial/helpers';
import { createWorld, type World } from './world';

describe('phone call caps on the composed server', () => {
  let w: World;
  const logs = captureLog();
  beforeAll(async () => { w = await createWorld({ log: logs.log }, VOICE_ENV); }, 120_000);
  afterAll(async () => { await w?.close(); });

  it('one call stores at most the proposal cap of approvals; the next proposal is refused and recorded, and nothing external is written', async () => {
    const call = await phoneCall(w, PIZZA, 'CA_e2e_caps');
    call.toolset.dispose();
    const relay = await phoneRelay(call, { logger: logs.log as never });
    await relay.connect();
    const cap = DEFAULT_LIMITS.maxProposals;
    const results: Record<string, unknown>[] = [];
    // The caller changes the cart and says yes again, one more time than the cap allows.
    for (let n = 1; n <= cap + 1; n++) {
      const cart = { lines: [{ catalogItemId: 'SQ_ITEM_PEP', variationId: 'SQ_VAR_PEP_LG', quantity: n, modifierIds: [] }] };
      const quoted = await relay.toolCall('quote_order', JSON.stringify({ cart }), `fc_q_${n}`) as { ok: boolean; quote: { quoteId: string } };
      expect(quoted.ok, JSON.stringify(quoted)).toBe(true);
      results.push(await relay.toolCall('propose_order', JSON.stringify({ cart, quoteId: quoted.quote.quoteId, fulfillment: { type: 'pickup', pickupAt: pickupAt() }, contact: { name: 'Sam', messageConsent: false } }), `fc_p_${n}`));
    }
    expect(results.slice(0, cap).map((r) => r.ok)).toEqual(Array(cap).fill(true));
    expect(results[cap]).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });

    const approvals = (await w.t.db.query(`select a.id from approval_requests a join orders o on o.id = a.subject_id where o.call_id = $1`, [call.callId])).rows;
    expect(approvals).toHaveLength(cap);
    expect((await w.t.db.query('select count(*)::int as n from orders where call_id = $1', [call.callId])).rows[0]).toEqual({ n: cap });
    // Recorded in the feed with fixed codes, against this call.
    const refused = (await w.t.db.query("select correlation_id, payload from activity_events where business_id = $1 and type = 'guardrail.refused' and payload->>'reasonCode' = 'proposal_limit'", [PIZZA])).rows as { correlation_id: string; payload: Record<string, unknown> }[];
    expect(refused).toEqual([{ correlation_id: call.callId, payload: { callId: call.callId, rule: 'unsupported_request', reasonCode: 'proposal_limit', toolName: 'propose_order' } }]);
    // The agent was told, by the server, to say it cannot send another request.
    const told = relay.models[0]!.ofType('conversation.item.create').map((m) => JSON.stringify(m)).filter((t) => t.includes('I cannot send another request on this call'));
    expect(told).toHaveLength(1);
    // A read still works after the cap, and nothing was written outside our database.
    expect(await relay.toolCall('read_catalog', JSON.stringify({ query: 'pepperoni' }), 'fc_read')).toMatchObject({ ok: true });
    await relay.hangUp();
    expect(counts(w)).toEqual(NONE);
    const ended = (await w.t.db.query("select type from activity_events where correlation_id = $1 and type = 'call.ended'", [call.callId])).rows;
    expect(ended).toHaveLength(1);
  });
});

// The simulated call (P-18) has a cap of 8 tool calls per turn. It had no cap per call, so many turns
// could fill the approvals inbox the same way. It now has the phone path's proposal cap, counted from
// the proposals the database holds for the call, so a server restart does not reset it.
describe('simulated call: the proposal cap per call', () => {
  let w: World;
  const logs = captureLog();
  beforeAll(async () => { w = await createWorld({ log: logs.log }); }, 120_000);
  afterAll(async () => { await w?.close(); });

  it('one simulated call stores at most the proposal cap of approvals, across turns; the next proposal is refused and recorded', async () => {
    const cap = DEFAULT_LIMITS.maxProposals;
    const results: Record<string, unknown>[] = [];
    let callId: string | undefined;
    for (let n = 1; n <= cap + 1; n++) {
      const cart = { lines: [{ catalogItemId: 'SQ_ITEM_PEP', variationId: 'SQ_VAR_PEP_LG', quantity: n, modifierIds: [] }] };
      w.model.push(async ({ executeTool }) => {
        const q = await executeTool('quote_order', { cart }) as { ok: boolean; quote: { quoteId: string } };
        results.push(await executeTool('propose_order', { cart, quoteId: q.quote.quoteId, fulfillment: { type: 'pickup', pickupAt: pickupAt() }, contact: { name: 'Sam', messageConsent: false } }) as Record<string, unknown>);
        return 'ok';
      });
      const res = await sim(w, 'agt_pizza_01', PIZZA, { ...(callId ? { callId } : {}), message: `Make it ${n} pizzas. Yes, send it.` });
      expect(res.status, res.raw).toBe(200);
      callId = res.body.callId;
    }
    expect(results.slice(0, cap).map((r) => r.ok)).toEqual(Array(cap).fill(true));
    expect(results[cap]).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
    expect((await w.t.db.query('select count(*)::int as n from orders where call_id = $1', [callId])).rows[0]).toEqual({ n: cap });
    expect((await w.t.db.query('select count(*)::int as n from approval_requests a join orders o on o.id = a.subject_id where o.call_id = $1', [callId])).rows[0]).toEqual({ n: cap });
    const refused = (await w.t.db.query("select correlation_id, payload from activity_events where business_id = $1 and type = 'guardrail.refused' and payload->>'reasonCode' = 'proposal_limit'", [PIZZA])).rows;
    expect(refused).toEqual([{ correlation_id: callId, payload: { callId, rule: 'unsupported_request', reasonCode: 'proposal_limit', toolName: 'propose_order' } }]);
    // A read still works on the same call, and ending it writes call.ended.
    let read: unknown;
    w.model.push(async ({ executeTool }) => { read = await executeTool('read_catalog', { query: 'pepperoni' }); return 'ok'; });
    expect((await sim(w, 'agt_pizza_01', PIZZA, { callId, message: 'What do you have?', end: true })).status).toBe(200);
    expect(read).toMatchObject({ ok: true });
    expect(counts(w)).toEqual(NONE);
  });
});
