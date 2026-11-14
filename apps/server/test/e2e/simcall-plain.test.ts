// Sim-call shows the agent's line as a caller would hear it: the model is told to speak plainly, and
// any Markdown it still produces is stripped from the reply.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { notWiredExecutor } from '../../src/compose/seams';
import { PLAIN_SPEECH_RULE } from '../../src/api/simcall/plain';
import { OWNER, createWorld, type World } from './world';

let w: World;
beforeAll(async () => { w = await createWorld({ executor: notWiredExecutor }); }, 120_000);
afterAll(async () => { await w?.close(); });

it('tells the model to use plain speech and strips Markdown from the reply', async () => {
  let instructions = '';
  w.model.push(async (input) => { instructions = input.instructions; return 'That comes to **$23.93**.\n- Pickup at *six*'; });
  const res = await w.app.inject({ method: 'POST', url: '/api/agents/agt_pizza_01/sim-call?businessId=biz_pizza_01', headers: OWNER, payload: { message: 'How much?', end: true } });
  expect(res.statusCode).toBe(200);
  expect(instructions).toContain(PLAIN_SPEECH_RULE);
  expect((res.json() as { reply: string }).reply).toBe('That comes to $23.93.\nPickup at six');
  expect(w.squareWrites).toEqual([]);
  expect(w.messageSends).toBe(0);
});
