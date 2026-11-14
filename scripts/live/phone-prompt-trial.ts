// Reads the phone agent's wording without a phone call. Opens a text-only session on the real
// realtime model with the real phone prompt (voice/prompt.ts) and the fixture shop data, plays a
// scripted caller, and prints every agent line and tool call. Tools are the mock toolset, so no
// provider, database row or approval is touched. It costs a few cents of model use.
//
//   npx tsx scripts/live/phone-prompt-trial.ts [pizza|barber] ["caller line" "caller line" ...]
//
// Text mode is not the phone: it shows what the agent says and when it calls a tool, not how it
// sounds or how fast it answers.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';
import { REALTIME_MODEL, type AgentSpec, type ToolInput, type ToolName } from '@abos/contracts';
import { barberFacts, barberSpecV1, pizzaCatalog, pizzaSpecV2, pizzaVerifiedFacts } from '@abos/contracts/fixtures';
import { createMockToolset } from '../../apps/server/src/tools/mock/index';
import { OPENAI_REALTIME_URL } from '../../apps/server/src/voice/constants';
import { buildInstructions } from '../../apps/server/src/voice/prompt';
import { checkSessionCapabilities, phoneToolDefinitions } from '../../apps/server/src/voice/relay';
import type { FactsSnapshot } from '../../apps/server/src/voice/types';

let dir = process.cwd();
for (;;) { const f = join(dir, '.env.local'); if (existsSync(f)) { process.loadEnvFile(f); break; } const up = dirname(dir); if (up === dir) break; dir = up; }
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

const which = process.argv[2] === 'barber' ? 'barber' : 'pizza';
const DEFAULT_LINES: Record<string, string[]> = {
  pizza: ['What time do you close tonight?', 'Do you have gluten free crust?', 'How much is a large pepperoni?', 'OK, one large pepperoni please.', 'No, that is all.', 'Sam.', 'Six thirty tonight.', 'Yes.'],
  barber: ['How much is a haircut?', 'Are you open Monday?', 'I would like a haircut.', 'Next Tuesday.', 'The first one.', 'Sam.', 'Yes.'],
};
const callerLines = process.argv.length > 3 ? process.argv.slice(3) : DEFAULT_LINES[which]!;

const spec: AgentSpec = which === 'barber' ? barberSpecV1 : pizzaSpecV2;
const source = which === 'barber' ? barberFacts : pizzaVerifiedFacts;
const facts: FactsSnapshot = {
  facts: source.flatMap((f) => (f.kind === 'menu_item' || f.status !== 'verified' ? [] : [{ kind: f.kind, key: f.key, value: f.value, version: f.version }])),
  timezone: 'America/Los_Angeles',
};
const now = new Date();
const check = checkSessionCapabilities(spec);
if (!check.ok) throw new Error('the fixture spec has a capability that is not allowed');
const tools: readonly ToolName[] = check.tools;
const toolset = createMockToolset({ businessId: spec.businessId, now: () => now });
const instructions = buildInstructions(spec, {
  businessName: which === 'barber' ? 'Demo Barbershop' : 'Demo Pizza Co.', messageChannel: 'qr_only', facts,
  ...(which === 'pizza' ? { menu: pizzaCatalog } : {}), nowMs: now.getTime(),
});

console.log(`--- prompt (${instructions.length} characters) ---\n${instructions}\n--- conversation ---`);

type Json = Record<string, unknown>;
const ws = new WebSocket(`${OPENAI_REALTIME_URL}?model=${encodeURIComponent(process.env.OPENAI_REALTIME_MODEL ?? REALTIME_MODEL)}`, { headers: { Authorization: `Bearer ${apiKey}` } });
const send = (event: Json) => ws.send(JSON.stringify(event));
let next = 0;
let toolCalls = 0;
let fillers = 0;
const FILLER = /let me (check|look|see|pull)|one moment|just a (moment|second|sec)|hold on|bear with me|i('| a)m checking|i will check|give me a (moment|second)/i;

const say = () => {
  const line = callerLines[next++];
  if (line === undefined) { finish(); return; }
  console.log(`CALLER: ${line}`);
  send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: line }] } });
  send({ type: 'response.create' });
};

function finish() {
  console.log(`--- ${toolCalls} tool calls, ${fillers} filler lines ---`);
  ws.close();
}

ws.on('open', () => {
  send({ type: 'session.update', session: { type: 'realtime', output_modalities: ['text'], instructions, tools: phoneToolDefinitions(tools), tool_choice: 'auto' } });
});
ws.on('message', async (data) => {
  const ev = JSON.parse(String(data)) as Json;
  if (ev.type === 'session.updated') { send({ type: 'response.create' }); return; }
  if (ev.type === 'error') { console.log('MODEL ERROR:', JSON.stringify((ev.error as Json)?.code ?? (ev.error as Json)?.type)); return; }
  if (ev.type !== 'response.done') return;
  const output = (((ev.response as Json)?.output ?? []) as Json[]);
  let called = false;
  const announces = output.some((i) => i.type === 'function_call');
  for (const item of output) {
    if (item.type === 'message') {
      const text = ((item.content ?? []) as Json[]).map((c) => String(c.text ?? c.transcript ?? '')).join(' ').trim();
      if (text !== '') {
        const words = text.split(/\s+/).length;
        const filler = (announces && !/^got it\.?$/i.test(text)) || FILLER.test(text);
        if (filler) fillers++;
        console.log(`AGENT (${words} words${filler ? ', FILLER' : ''}): ${text}`);
      }
    } else if (item.type === 'function_call') {
      called = true;
      toolCalls++;
      const name = String(item.name) as ToolName;
      let result: unknown;
      try {
        const args = JSON.parse(String(item.arguments ?? '{}')) as ToolInput[ToolName];
        result = tools.includes(name) ? await toolset.handler.call(name, args, { businessId: spec.businessId, agentVersionId: 'agv_trial', callId: 'call_trial', correlationId: 'call_trial' } as never) : { ok: false, reason: 'CAPABILITY_NOT_ALLOWED' };
      } catch { result = { ok: false, reason: 'VALIDATION_FAILED' }; }
      const r = result as Json;
      console.log(`  [tool ${name} -> ${r.ok === true ? 'ok' : `failed ${String(r.reason ?? '')} ${String(r.message ?? '')}`}]`);
      send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: item.call_id, output: JSON.stringify(result) } });
    }
  }
  if (called) send({ type: 'response.create' });
  else say();
});
ws.on('error', (err) => { console.log('SOCKET ERROR:', err.name); process.exitCode = 1; });
setTimeout(() => { console.log('timed out'); finish(); }, 120_000).unref();
