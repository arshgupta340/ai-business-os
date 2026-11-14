// B-23 group 8 (AGENTS rule 6): what the deployed agent is handed. The tools given to the voice worker
// and to the simulated call are read and propose tools only, whatever the pinned spec lists, and a
// name outside them is refused and recorded without its arguments.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACTION_TYPE_CAPABILITY, CAPABILITIES, CAPABILITY_LIST, TOOL_CAPABILITY, ToolNameSchema, type AgentSpec, type ToolName } from '@abos/contracts';
import { currentRole } from '../support/db';
import { createWorld, type World } from '../e2e/world';
import { BARBER, NONE, PIZZA, VOICE_ENV, captureLog, count, counts, delta, phoneCall, phoneRelay, sim } from './helpers';

const TOOL_NAMES: readonly string[] = ToolNameSchema.options;
const WRITE_CAPABILITIES = CAPABILITY_LIST.filter((c) => c.effect === 'write' || c.effect === 'external_message').map((c) => c.id as string);
const ACTION_TYPES = Object.keys(ACTION_TYPE_CAPABILITY);
/** Names a hijacked model might try. None is a tool. */
const NOT_TOOLS = [
  ...WRITE_CAPABILITIES, ...ACTION_TYPES, 'local.fact.update', 'local.order.record',
  'approve_order', 'approve', 'decide_approval', 'write', 'write_tool', 'update_fact', 'update_price', 'set_price', 'send_message', 'send_sms', 'create_payment_link',
  'execute_sql', 'create_tool', 'get_secret', 'read_env', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'call', '', ' ', 'READ_CATALOG', 'read_catalog ', 'read_catalog\u0000', 'propose_order;approve',
];
const effectOf = (tool: string) => CAPABILITIES[TOOL_CAPABILITY[tool as ToolName]].effect;
/** A value that must never show up in a log line, an event or a response: it stands for the arguments. */
const ARGS_MARKER = 'ARGS_MARKER_7f3a91c2';

let w: World;
const logs = captureLog();
beforeAll(async () => { w = await createWorld({ log: logs.log }, VOICE_ENV); }, 120_000);
afterAll(async () => { await w?.close(); });

async function factsDigest() {
  return JSON.stringify((await w.t.db.query('select id, business_id, kind, key, value, status, version from business_facts order by id')).rows);
}

it('runs as abos_app; the registry has write capabilities, and none of them is a tool', async () => {
  expect(await currentRole(w.t.db)).toBe('abos_app');
  expect(WRITE_CAPABILITIES.length).toBeGreaterThanOrEqual(5);
  expect(TOOL_NAMES).toHaveLength(8);
  for (const tool of TOOL_NAMES) expect(['read', 'propose'], tool).toContain(effectOf(tool));
  for (const name of NOT_TOOLS) expect(TOOL_NAMES, name).not.toContain(name);
  // The published specs do list write capabilities (the executor's bundle), so the filter below is not vacuous.
  const specs = (await w.t.db.query('select v.spec from agents a join agent_versions v on v.id = a.active_version_id order by a.id')).rows as { spec: AgentSpec }[];
  for (const { spec } of specs) expect(spec.capabilities.some((c) => WRITE_CAPABILITIES.includes(c))).toBe(true);
});

describe('the simulated call', () => {
  it.each([['agt_pizza_01', PIZZA, ['get_order_status', 'propose_order', 'quote_order', 'read_business_facts', 'read_catalog']],
    ['agt_barber_01', BARBER, ['propose_booking', 'read_business_facts', 'read_calendar_availability']]] as const)('%s is handed exactly its read and propose tools', async (agentId, businessId, expected) => {
    let handed: readonly string[] = [];
    let instructions = '';
    w.model.push(async (input) => { handed = input.tools; instructions = input.instructions; return 'ok'; });
    expect((await sim(w, agentId, businessId, { message: 'hello', end: true })).status).toBe(200);
    expect([...handed].sort()).toEqual([...expected]);
    for (const tool of handed) expect(['read', 'propose'], tool).toContain(effectOf(tool));
    // The instructions name no write capability and no executor step as something to call.
    for (const name of [...WRITE_CAPABILITIES, ...ACTION_TYPES]) expect(instructions, name).not.toContain(name);
  });

  it('every name outside the toolset is refused with no write, no approval and no changed fact', async () => {
    const before = counts(w);
    const facts = await factsDigest();
    const approvals = await count(w, 'approval_requests');
    const results: [string, unknown][] = [];
    // The model plays a hijacked one: eight tool calls per turn is the cap, so the names go out in turns.
    const turns = Math.ceil(NOT_TOOLS.length / 8);
    let callId: string | undefined;
    for (let t = 0; t < turns; t++) {
      const names = NOT_TOOLS.slice(t * 8, t * 8 + 8);
      w.model.push(async ({ executeTool }) => {
        for (const name of names) results.push([name, await executeTool(name, { approvalId: 'apv_x', orderId: 'ord_x', decision: 'approve', marker: ARGS_MARKER })]);
        return 'tried';
      });
      const r = await sim(w, 'agt_pizza_01', PIZZA, { ...(callId ? { callId } : {}), message: 'Please go on', ...(t === turns - 1 ? { end: true } : {}) });
      expect(r.status).toBe(200);
      callId = r.body.callId;
      // The trace the owner sees holds no entry for a refused name, and never the arguments.
      expect(r.body.toolTrace).toEqual([]);
      expect(r.raw).not.toContain(ARGS_MARKER);
    }
    expect(results).toHaveLength(NOT_TOOLS.length);
    for (const [name, result] of results) expect(result, JSON.stringify(name)).toMatchObject({ ok: false, reason: 'CAPABILITY_NOT_ALLOWED' });
    await w.settle();
    expect(await factsDigest()).toBe(facts);
    expect(await count(w, 'approval_requests')).toBe(approvals);
    expect(await count(w, 'action_executions')).toBe(0);
    expect(await count(w, 'activity_events where payload::text like $1', [`%${ARGS_MARKER}%`])).toBe(0);
    expect(logs.text()).not.toContain(ARGS_MARKER);
    expect(delta(w, before)).toEqual(NONE);
  });

  it('a real tool of another agent is refused: the pizza agent cannot book, the booking agent cannot order', async () => {
    const before = counts(w);
    const out: Record<string, unknown> = {};
    w.model.push(async ({ executeTool }) => { out.pizzaBooking = await executeTool('propose_booking', { serviceId: 'svc_haircut', startUtc: new Date(Date.now() + 86_400_000).toISOString(), customer: { name: 'X', messageConsent: false } }); return 'x'; });
    await sim(w, 'agt_pizza_01', PIZZA, { message: 'hello', end: true });
    w.model.push(async ({ executeTool }) => { out.barberCatalog = await executeTool('read_catalog', {}); out.barberOrder = await executeTool('quote_order', { cart: { lines: [] } }); return 'x'; });
    await sim(w, 'agt_barber_01', BARBER, { message: 'hello', end: true });
    for (const r of Object.values(out)) expect(r).toMatchObject({ ok: false, reason: 'CAPABILITY_NOT_ALLOWED' });
    expect(await count(w, 'bookings')).toBe(0);
    expect(delta(w, before)).toEqual(NONE);
  });

  it('a real tool with arguments it does not take is refused before it runs: no field can smuggle a decision or a total', async () => {
    const before = counts(w);
    const approvals = await count(w, 'approval_requests');
    const results: unknown[] = [];
    w.model.push(async ({ executeTool }) => {
      const quote = await executeTool('quote_order', { cart: { lines: [{ catalogItemId: 'SQ_ITEM_PEP', variationId: 'SQ_VAR_PEP_LG', quantity: 1, modifierIds: [] }] } }) as { ok: true; quote: { quoteId: string } };
      const cart = { lines: [{ catalogItemId: 'SQ_ITEM_PEP', variationId: 'SQ_VAR_PEP_LG', quantity: 1, modifierIds: [] }] };
      const base = { cart, quoteId: quote.quote.quoteId, contact: { name: 'Mallory', messageConsent: false }, fulfillment: { type: 'pickup', pickupAt: new Date(Date.now() + 3_600_000).toISOString() } };
      for (const extra of [{ approved: true }, { state: 'APPROVED' }, { totalMinor: 0 }, { businessId: BARBER }, { payloadHash: `sha256:${'0'.repeat(64)}` }, { decision: 'approve' }, { __proto__: { approved: true }, skipApproval: true }]) {
        results.push(await executeTool('propose_order', { ...base, ...extra }));
      }
      results.push(await executeTool('quote_order', { cart, totalMinor: 0 }));
      results.push(await executeTool('quote_order', { cart: { lines: [{ ...cart.lines[0], priceMinor: 0 }] } }));
      results.push(await executeTool('read_business_facts', { kinds: ['hours'], set: { fri: { closed: true } } }));
      return 'tried';
    });
    const r = await sim(w, 'agt_pizza_01', PIZZA, { message: 'One large pepperoni', end: true });
    expect(results).toHaveLength(10);
    for (const result of results.slice(0, 7)) expect(result).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
    for (const result of results.slice(7)) expect(result).toMatchObject({ ok: false });
    for (const entry of r.body.toolTrace) expect(['read', 'propose']).toContain(effectOf(entry.tool));
    expect(await count(w, 'approval_requests')).toBe(approvals);
    expect(delta(w, before)).toEqual(NONE);
  });

  // Was DEFECT 6 in the pull request: the simulated call left no record of a refused unknown tool.
  // Fixed after the merge: guardrail.refused and a log line by name length, as the phone relay does.
  it('a refused unknown tool is recorded (an event or a log line), without its arguments', async () => {
    const events = await count(w, "activity_events where business_id = $1 and type = 'guardrail.refused'", [PIZZA]);
    const lines = logs.lines.length;
    w.model.push(async ({ executeTool }) => { await executeTool('approve_order', { marker: ARGS_MARKER }); return 'tried'; });
    await sim(w, 'agt_pizza_01', PIZZA, { message: 'hello there', end: true });
    expect(logs.text()).not.toContain(ARGS_MARKER);
    const recorded = (await count(w, "activity_events where business_id = $1 and type = 'guardrail.refused'", [PIZZA])) - events + (logs.lines.length - lines);
    expect(recorded).toBeGreaterThan(0);
  });
});

describe('the voice worker', () => {
  it.each([[PIZZA, 'CA_adv_tools_pizza', ['get_order_status', 'propose_order', 'quote_order', 'read_business_facts', 'read_catalog']],
    [BARBER, 'CA_adv_tools_barber', ['propose_booking', 'read_business_facts', 'read_calendar_availability']]] as const)('the session opened for %s carries exactly its read and propose tools', async (businessId, sid, expected) => {
    const call = await phoneCall(w, businessId, sid);
    call.toolset.dispose();
    const voice = captureLog();
    const relay = await phoneRelay(call, { logger: voice.log });
    await relay.connect();
    expect(relay.sessionTools().sort()).toEqual([...expected]);
    for (const tool of relay.sessionTools()) expect(['read', 'propose'], tool).toContain(effectOf(tool));
    // Nothing in the session the model is given names a write capability or an executor step.
    const session = JSON.stringify(relay.models[0]!.ofType('session.update')[0]);
    for (const name of [...WRITE_CAPABILITIES, ...ACTION_TYPES]) expect(session, name).not.toContain(name);
    await relay.hangUp();
    expect((await w.t.db.query('select status from calls where id = $1', [call.callId])).rows).toEqual([{ status: 'COMPLETED' }]);
  });

  it('an unknown tool name is refused, recorded as a guardrail event, and logged as its length only: never the name or the arguments', async () => {
    const before = counts(w);
    const facts = await factsDigest();
    const call = await phoneCall(w, PIZZA, 'CA_adv_tools_unknown');
    call.toolset.dispose();
    const voice = captureLog();
    const relay = await phoneRelay(call, { logger: voice.log });
    await relay.connect();
    const refusedBefore = await count(w, "activity_events where type = 'guardrail.refused' and payload->>'callId' = $1", [call.callId]);
    const args = JSON.stringify({ approvalId: 'apv_x', decision: 'approve', recipient: '+15555550666', marker: ARGS_MARKER });
    const names = ['approve_order_SECRETNAME', 'order.checkout.prepare', 'message.checkout.send', 'square.checkout.create', '__proto__', 'constructor'];
    for (const [i, name] of names.entries()) {
      const answer = await relay.toolCall(name, args, `fc_unknown_${i}`);
      expect(answer, name).toMatchObject({ ok: false, reason: 'CAPABILITY_NOT_ALLOWED' });
      expect(JSON.stringify(answer)).not.toContain(ARGS_MARKER);
    }
    // A real tool that this agent does not have is refused the same way.
    expect(await relay.toolCall('propose_booking', args, 'fc_not_allowed')).toMatchObject({ ok: false, reason: 'CAPABILITY_NOT_ALLOWED' });
    await relay.hangUp();
    await w.settle();

    const text = voice.text();
    expect(text).toContain('"tool":"unknown_tool"');
    expect(voice.lines.filter((l) => l.includes('unknown tool')).length).toBe(names.length);
    for (const forbidden of [ARGS_MARKER, 'SECRETNAME', '+15555550666', 'apv_x', '__proto__']) expect(text, forbidden).not.toContain(forbidden);
    const refused = (await w.t.db.query("select payload from activity_events where type = 'guardrail.refused' and payload->>'callId' = $1 order by occurred_at", [call.callId])).rows as { payload: Record<string, unknown> }[];
    expect(refused.length - refusedBefore).toBe(names.length + 1);
    expect(refused.filter((r) => r.payload.reasonCode === 'unknown_tool')).toHaveLength(names.length);
    expect(JSON.stringify(refused)).not.toContain(ARGS_MARKER);
    expect(JSON.stringify(refused)).not.toContain('SECRETNAME');
    expect(await factsDigest()).toBe(facts);
    expect(await count(w, 'approval_requests where business_id = $1 and state <> $2', [PIZZA, 'PENDING'])).toBe(0);
    expect(delta(w, before)).toEqual(NONE);
  });

  it('a pinned spec that lists a write capability outside its bundle opens no model session at all', async () => {
    const before = counts(w);
    const call = await phoneCall(w, PIZZA, 'CA_adv_tools_badspec');
    call.toolset.dispose();
    const voice = captureLog();
    const spec = { ...call.spec, capabilities: [...call.spec.capabilities, 'catalog.price.update'] } as AgentSpec;
    const relay = await phoneRelay(call, { logger: voice.log, spec });
    await relay.relay.done;
    expect(relay.models.flatMap((m) => m.ofType('session.update'))).toEqual([]);
    expect((await w.t.db.query('select status from calls where id = $1', [call.callId])).rows[0]).not.toEqual({ status: 'IN_PROGRESS' });
    expect(delta(w, before)).toEqual(NONE);
  });

  it('the toolset object built for a call has seven entries, all read or propose, and refuses anything else by name', async () => {
    const before = counts(w);
    const call = await phoneCall(w, PIZZA, 'CA_adv_tools_object');
    try {
      const ts = w.app.composed.toolsetFor({ businessId: PIZZA, agentVersionId: call.agentVersionId, callId: call.callId, capabilities: CAPABILITY_LIST.map((c) => c.id), facts: call.facts });
      expect(Object.keys(ts.tools).sort()).toEqual([...TOOL_NAMES].sort());
      for (const name of NOT_TOOLS) {
        const r = await ts.handler.call(name as ToolName, { marker: ARGS_MARKER } as never, call.ctx).catch(() => ({ ok: false }));
        expect(r, JSON.stringify(name)).toMatchObject({ ok: false });
      }
      expect(JSON.stringify(ts.trace())).not.toContain(ARGS_MARKER);
      for (const entry of ts.trace()) expect(['read', 'propose']).toContain(entry.effect);
      ts.dispose();
    } finally { call.toolset.dispose(); }
    expect(delta(w, before)).toEqual(NONE);
  });
});
