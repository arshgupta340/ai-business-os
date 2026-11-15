// The AgentPhone realtime turn engine (telephony/agentphone/realtime.ts) against a fake Realtime socket.
// No network, no database: a fake tool handler records what the model asked for.
import { describe, expect, it } from 'vitest';
import type { ToolName } from '@abos/contracts';
import type { CancellableToolHandler } from '../../src/tools/real/types';
import { openRealtimeCall, TOOL_NOT_RUN, withDollars, type RealtimeCallDeps } from '../../src/telephony/agentphone/realtime';
import { fakeRealtime, type FakeRealtime } from './fake-realtime';

const TOOLS: ToolName[] = ['read_catalog', 'read_business_facts', 'quote_order', 'propose_order', 'get_order_status'];
const CTX = { businessId: 'biz_pizza_01', agentVersionId: 'agv_1', callId: 'call_1', correlationId: 'call_1' };
const QUOTE = { ok: true, quote: { quoteId: 'quo_1', totalMinor: 1299 } };
const PROPOSAL = { ok: true, proposalId: 'ord_1', approvalId: 'apr_1', missingFields: [] };

function handler(behaviour: Partial<Record<ToolName, (args: unknown) => Promise<unknown>>> = {}) {
  const calls: { tool: ToolName; args: unknown }[] = [];
  const h = {
    async call(tool: ToolName, args: unknown) {
      calls.push({ tool, args });
      const f = behaviour[tool];
      if (f) return f(args);
      if (tool === 'quote_order') return QUOTE;
      if (tool === 'propose_order') return PROPOSAL;
      return { ok: true };
    },
  } as unknown as CancellableToolHandler;
  return { h, calls };
}

function open(fake: FakeRealtime, h: CancellableToolHandler, extra: Partial<RealtimeCallDeps> = {}) {
  return openRealtimeCall({ socketFactory: fake.factory, model: 'gpt-realtime-test', instructions: 'PHONE PROMPT', tools: TOOLS, handler: h, ctx: CTX, ...extra });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('AgentPhone realtime engine', () => {
  it('opens one text session with the phone prompt and the allowed tools, and answers a turn with no tool call', async () => {
    const fake = fakeRealtime();
    fake.push(() => ({ text: 'We close at ten tonight.' }));
    const { h, calls } = handler();
    const rt = await open(fake, h);
    const session = fake.session()!.session as Record<string, unknown>;
    expect(session.output_modalities).toEqual(['text']);
    expect(session.instructions).toBe('PHONE PROMPT');
    expect((session.tools as { name: string }[]).map((t) => t.name)).toEqual(TOOLS);
    expect(JSON.stringify(session.tools)).not.toMatch(/checkout|send_message|write/);
    const r = await rt.turn('What time do you close?');
    expect(r).toMatchObject({ kind: 'reply', text: 'We close at ten tonight.', toolCalls: 0 });
    expect(fake.userTexts).toEqual(['What time do you close?']);
    expect(calls).toHaveLength(0);
    rt.close('call_end');
    expect(rt.closed).toBe(true);
  });

  it('runs two tool calls in one turn through the same handler and answers each before the final text', async () => {
    const fake = fakeRealtime();
    fake.push(
      () => ({ calls: [{ name: 'quote_order', args: { cart: { lines: [] } } }] }),
      ({ outputs }) => ({ calls: [{ name: 'propose_order', args: { quoteId: (outputs[0]!.quote as { quoteId: string }).quoteId, contact: { name: 'Sam' } } }] }),
      () => ({ text: 'Done.' }),
    );
    const { h, calls } = handler();
    const seen: string[] = [];
    const rt = await open(fake, h, { onToolResult: (e) => { seen.push(`${e.tool}:${String(e.ok)}`); } });
    const r = await rt.turn('Yes, send it.');
    expect(r.kind).toBe('reply');
    expect(r.toolCalls).toBe(2);
    expect(calls.map((c) => c.tool)).toEqual(['quote_order', 'propose_order']);
    expect((calls[1]!.args as { quoteId: string }).quoteId).toBe('quo_1');
    expect(fake.outputs).toHaveLength(2);
    expect(seen).toEqual(['quote_order:true', 'propose_order:true']);
    expect(rt.toolCallsSeen).toBe(2);
  });

  it('answers a tool that passes its deadline with a failure, and the turn goes on', async () => {
    const fake = fakeRealtime();
    fake.push(() => ({ calls: [{ name: 'read_catalog', args: {} }] }), () => ({ text: 'Sorry, I cannot check that now.' }));
    const { h } = handler({ read_catalog: () => new Promise(() => undefined) });
    const rt = await open(fake, h, { toolTimeoutMs: 20 });
    const r = await rt.turn('Do you have wings?');
    expect(r).toMatchObject({ kind: 'reply', text: 'Sorry, I cannot check that now.' });
    expect(fake.outputs[0]).toMatchObject({ ok: false, reason: 'INTEGRATION_UNAVAILABLE' });
  });

  it('refuses function calls past the per-call cap and ends the turn with tool_limit', async () => {
    const fake = fakeRealtime();
    fake.push(() => ({ calls: [{ name: 'read_catalog', args: {} }, { name: 'read_business_facts', args: {} }, { name: 'read_catalog', args: {} }] }));
    const { h, calls } = handler();
    const refused: string[] = [];
    const rt = await open(fake, h, { maxToolCalls: 2, onRefused: (e) => { refused.push(e.reasonCode); } });
    const r = await rt.turn('Tell me everything.');
    expect(r.kind).toBe('tool_limit');
    expect(calls).toHaveLength(2);
    expect(refused).toEqual(['tool_call_limit']);
    expect(fake.outputs[2]).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
  });

  it('refuses an unknown tool, a tool the agent does not hold, and a proposal past the proposal cap', async () => {
    const fake = fakeRealtime();
    fake.push(
      () => ({ calls: [{ name: 'square_checkout', args: {} }, { name: 'propose_booking', args: {} }, { name: 'propose_order', args: {} }, { name: 'propose_order', args: {} }] }),
      () => ({ text: 'ok' }),
    );
    const { h, calls } = handler();
    const refused: string[] = [];
    const rt = await open(fake, h, { maxProposals: 1, onRefused: (e) => { refused.push(e.reasonCode); } });
    await rt.turn('x');
    expect(refused).toEqual(['unknown_tool', 'tool_not_allowed', 'proposal_limit']);
    expect(calls.map((c) => c.tool)).toEqual(['propose_order']);
  });

  it('a model error fails the turn and closes the session', async () => {
    const fake = fakeRealtime();
    fake.push(() => 'error');
    const { h } = handler();
    const closes: string[] = [];
    const rt = await open(fake, h, { onClose: (w) => { closes.push(w); } });
    await expect(rt.turn('hello')).rejects.toMatchObject({ why: 'model_error' });
    expect(rt.closed).toBe(true);
    expect(closes).toEqual(['model_error']);
    await expect(rt.turn('again')).rejects.toMatchObject({ why: 'closed' });
  });

  it('a session that is refused or never confirmed does not open', async () => {
    const { h } = handler();
    await expect(open(fakeRealtime({ refuseOpen: true }), h)).rejects.toMatchObject({ why: 'model_error' });
    await expect(open(fakeRealtime({ silentOpen: true }), h, { openTimeoutMs: 20 })).rejects.toMatchObject({ why: 'open_timeout' });
  });

  it('closes itself after the idle limit with no turn', async () => {
    const fake = fakeRealtime();
    const { h } = handler();
    const closes: string[] = [];
    const rt = await open(fake, h, { idleMs: 20, onClose: (w) => { closes.push(w); } });
    await sleep(50);
    expect(rt.closed).toBe(true);
    expect(closes).toEqual(['idle']);
  });

  it('a turn that passes the engine bound fails and closes the session', async () => {
    const fake = fakeRealtime();
    fake.push(() => 'hang');
    const { h } = handler();
    const rt = await open(fake, h, { turnLimitMs: 20 });
    await expect(rt.turn('hello')).rejects.toMatchObject({ why: 'turn_limit' });
    expect(rt.closed).toBe(true);
  });

  it('runs turns of one session one after the other, never two at once', async () => {
    const fake = fakeRealtime();
    let release!: () => void;
    const gate = new Promise<unknown>((r) => { release = () => r({ ok: true }); });
    fake.push(() => ({ calls: [{ name: 'read_catalog', args: {} }] }), () => ({ text: 'first' }), () => ({ text: 'second' }));
    const { h } = handler({ read_catalog: () => gate });
    const rt = await open(fake, h);
    const a = rt.turn('one');
    const b = rt.turn('two');
    await sleep(10);
    // The second caller text is not sent while the first turn's tool call is still running.
    expect(fake.userTexts).toEqual(['one']);
    release();
    expect(await a).toMatchObject({ text: 'first' });
    expect(await b).toMatchObject({ text: 'second' });
    expect(fake.userTexts).toEqual(['one', 'two']);
  });

  it('adds a dollars string beside every amount in cents, at any depth, and changes nothing else', () => {
    const result = { ok: true, quote: { quoteId: 'q1', totalMinor: 55460, taxMinor: 4460, lines: [{ quantity: 20, unitPriceMinor: 2550, lineTotalMinor: 51000 }] } };
    expect(withDollars(result)).toEqual({ ok: true, quote: { quoteId: 'q1', totalMinor: 55460, totalDollars: '554.60', taxMinor: 4460, taxDollars: '44.60',
      lines: [{ quantity: 20, unitPriceMinor: 2550, unitPriceDollars: '25.50', lineTotalMinor: 51000, lineTotalDollars: '510.00' }] } });
    expect(result.quote).not.toHaveProperty('totalDollars');
    expect(withDollars('text')).toBe('text');
    // A slot gets its start in the shop's own time beside the UTC instant.
    const slot = (withDollars({ slots: [{ serviceId: 'svc_haircut', startUtc: '2026-11-16T00:00:00Z', endUtc: '2026-11-16T00:30:00Z', timezone: 'America/Los_Angeles' }] }) as
      { slots: Record<string, string>[] }).slots[0]!;
    expect(slot.startUtc).toBe('2026-11-16T00:00:00Z');
    expect(slot.startLocal).toMatch(/^Sunday, November 15.* 4:00 PM$/);
    expect(withDollars({ startUtc: 'not a time', timezone: 'America/Los_Angeles' })).toEqual({ startUtc: 'not a time', timezone: 'America/Los_Angeles' });
    expect(withDollars({ noteMinor: 'x' })).toEqual({ noteMinor: 'x' });
  });

  it('an abandoned turn starts no further tool call and asks for no further response', async () => {
    const fake = fakeRealtime();
    fake.push(() => ({ calls: [{ name: 'read_catalog', args: {} }] }));
    const { h, calls } = handler();
    const rt = await open(fake, h);
    const r = await rt.turn('x', { abandoned: () => true });
    expect(calls).toHaveLength(0);
    expect(fake.outputs[0]).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED', message: TOOL_NOT_RUN });
    expect(r.kind).toBe('reply');
    expect(fake.sent.filter((e) => e.type === 'response.create')).toHaveLength(1);
  });
});
