// Issue #93 item 3: a repeated propose with a changed recipient or pickup time never returns the old
// proposal (the order material is frozen from insert, 0006), and item 4: approving a second booking for
// an overlapping slot answers SLOT_CONFLICT, not a 500.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENDPOINTS, type Cart, type Quote, type ToolResult } from '@abos/contracts';
import { OWNER, createWorld, nextLocalDate, zonedIso, type World } from './world';

const PIZZA = 'biz_pizza_01';
const BARBER = 'biz_barber_01';
const CART: Cart = { lines: [{ catalogItemId: 'SQ_ITEM_PEP', variationId: 'SQ_VAR_PEP_LG', quantity: 1, modifierIds: [] }] };

let w: World;
beforeAll(async () => { w = await createWorld(); }, 120_000);
afterAll(async () => { await w?.close(); });

async function liveCall(businessId: string, agentId: string) {
  const v = (await w.t.db.query('select active_version_id from agents where id = $1', [agentId])).rows[0] as { active_version_id: string };
  const { callId } = await w.app.composed.calls.startSimulatedCall({ businessId, agentId, agentVersionId: v.active_version_id });
  return { callId, agentVersionId: v.active_version_id };
}
async function decide(businessId: string, approvalId: string) {
  const list = ENDPOINTS.listApprovals.response.parse((await w.app.inject({ url: `/api/approvals?businessId=${businessId}`, headers: OWNER })).json());
  const a = list.items.find((x) => x.id === approvalId)!;
  return w.app.inject({ method: 'POST', url: `/api/approvals/${approvalId}/decision?businessId=${businessId}`, headers: OWNER, payload: { decision: 'approve', payloadHash: a.payloadHash } });
}

describe('#93 item 3: a repeated order propose with changed details', () => {
  it('returns the stored proposal only when everything matches; a new recipient or pickup time is refused, the pending one unchanged', async () => {
    let quote: Quote | undefined;
    w.model.push(async ({ executeTool }) => { const r = await executeTool('quote_order', { cart: CART }) as ToolResult<'quote_order'>; if (r.ok) quote = r.quote; return 'quoted'; });
    const sim = (await w.app.inject({ method: 'POST', url: `/api/agents/agt_pizza_01/sim-call?businessId=${PIZZA}`, headers: OWNER, payload: { message: 'One large' } })).json() as { callId: string };
    const call = (await w.t.db.query('select agent_version_id from calls where id = $1', [sim.callId])).rows[0] as { agent_version_id: string };
    const date = nextLocalDate([0, 1, 2, 3, 4, 5, 6]);
    const propose = (recipient: string, hhmm: string) => w.app.composed.engine.createOrderProposal({ businessId: PIZZA, callId: sim.callId, agentVersionId: call.agent_version_id,
      cart: CART, quote: quote!, contact: { name: 'Sam', messageRecipient: recipient, messageConsent: true, consentAt: new Date().toISOString() },
      fulfillment: { type: 'pickup', pickupAt: zonedIso(date, hhmm, 'America/Los_Angeles') }, messageChannel: w.app.composed.providers.messageChannel });
    const first = await propose('+15555550123', '18:00');
    const same = await propose('+15555550123', '18:00');
    expect(same.approval.id).toBe(first.approval.id);
    // Orders are unique per call and cart (0002), so a changed detail cannot be a second order row.
    await expect(propose('+15555550199', '18:00')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(propose('+15555550123', '18:30')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const pending = (await w.t.db.query("select payload from approval_requests where subject_id = $1 and state = 'PENDING'", [first.order.id])).rows as { payload: { messageRecipient: string } }[];
    expect(pending.map((p) => p.payload.messageRecipient)).toEqual(['+15555550123']);
    // The first order row is unchanged (its material is frozen).
    const row = (await w.t.db.query('select contact from orders where id = $1', [first.order.id])).rows[0] as { contact: { messageRecipient: string } };
    expect(row.contact.messageRecipient).toBe('+15555550123');
  });
});

describe('#93 item 4: two approvals for overlapping booking slots', () => {
  it('the second approve answers SLOT_CONFLICT', async () => {
    const date = nextLocalDate([3, 4], 2);
    const startUtc = zonedIso(date, '11:00', 'America/Los_Angeles');
    const endUtc = new Date(Date.parse(startUtc) + 30 * 60_000).toISOString();
    const svc = (await w.t.db.query("select value from business_facts where business_id = $1 and kind = 'service' and status = 'verified' limit 1", [BARBER])).rows[0];
    void svc;
    const cal = (await w.t.db.query("select config from integrations where business_id = $1 and provider = 'google_calendar' limit 1", [BARBER])).rows[0] as { config?: { calendarId?: string } } | undefined;
    const calendarId = cal?.config?.calendarId ?? 'demo-barber@group.calendar.google.com';
    const book = async (name: string) => {
      const { callId, agentVersionId } = await liveCall(BARBER, 'agt_barber_01');
      return w.app.composed.engine.createBookingProposal({ businessId: BARBER, callId, agentVersionId, serviceId: 'svc_haircut', serviceName: 'Haircut', calendarId,
        startUtc, endUtc, timezone: 'America/Los_Angeles', customer: { name, messageRecipient: '+15555550124', messageConsent: true },
        messageChannel: 'qr_only' });
    };
    const a = await book('Ana');
    const b = await book('Ben');
    expect((await decide(BARBER, a.approval.id)).statusCode).toBe(200);
    const second = await decide(BARBER, b.approval.id);
    expect(second.json()).toMatchObject({ code: 'SLOT_CONFLICT' });
  });
});
