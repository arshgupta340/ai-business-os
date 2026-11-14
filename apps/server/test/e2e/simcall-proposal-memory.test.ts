// Live run 2026-11-14: after a successful propose_order, the agent's next line was "I haven't submitted
// your order." The simulated call keeps only spoken text between turns, so the model never saw its own
// tool result. The runner now tells the model, on every later turn, what this call already sent.
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Cart, ToolResult } from '@abos/contracts';
import { notWiredExecutor } from '../../src/compose/seams';
import { OWNER, createWorld, nextLocalDate, zonedIso, type World } from './world';

const CART: Cart = { lines: [{ catalogItemId: 'SQ_ITEM_PEP', variationId: 'SQ_VAR_PEP_LG', quantity: 1, modifierIds: [] }] };
let w: World;
beforeAll(async () => { w = await createWorld({ executor: notWiredExecutor }); }, 120_000);
afterAll(async () => { await w?.close(); });

async function sim(body: Record<string, unknown>) {
  const res = await w.app.inject({ method: 'POST', url: '/api/agents/agt_pizza_01/sim-call?businessId=biz_pizza_01', headers: OWNER, payload: body });
  expect(res.statusCode).toBe(200);
  return res.json() as { callId: string; reply: string };
}

it('after a proposal, later turns are told the order went to the shop for approval and a payment link follows', async () => {
  let before = '';
  let after = '';
  w.model.push(
    async (input) => {
      before = input.instructions;
      const q = await input.executeTool('quote_order', { cart: CART }) as ToolResult<'quote_order'>;
      if (!q.ok) return 'quote failed';
      const pickupAt = zonedIso(nextLocalDate([0, 1, 2, 3, 4, 5, 6]), '18:00', 'America/Los_Angeles');
      const r = await input.executeTool('propose_order', { cart: CART, contact: { name: 'Sam', messageConsent: false }, fulfillment: { type: 'pickup', pickupAt }, quoteId: q.quote.quoteId });
      return JSON.stringify(r);
    },
    async (input) => { after = input.instructions; return 'Goodbye.'; },
  );
  const first = await sim({ message: 'One large pepperoni for pickup at six, I am Sam, no texts. Yes, send it.' });
  expect(JSON.parse(first.reply)).toMatchObject({ ok: true });
  await sim({ callId: first.callId, message: 'Thanks, bye.', end: true });
  expect(before).not.toMatch(/already sent/i);
  expect(after).toMatch(/already sent this order to the shop for approval/i);
  expect(after).toMatch(/payment link/i);
  expect(after).toMatch(/do not call propose_order again/i);
});
