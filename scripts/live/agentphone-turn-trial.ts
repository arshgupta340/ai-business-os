// Drives the AgentPhone realtime turn engine (apps/server/src/telephony/agentphone/realtime.ts) against the
// real OpenAI Realtime model in text mode, with no AgentPhone and no HTTP: the phone prompt with the fixture
// shop data, the AgentPhone channel lines, and the mock toolset, so no provider, database row or approval is
// touched. A scripted caller asks the closing time and a price, orders a large pepperoni, gives a name and a
// time, and says yes. Each reply is printed with its word count and turn time, and the last line says whether
// the reply carried hangup (the server's closing line after a stored proposal, as on a real call).
// It costs a few cents of model use and needs OPENAI_API_KEY.
//
//   npx tsx scripts/live/agentphone-turn-trial.ts ["caller line" "caller line" ...]
//
// Text mode is not the phone: it shows what AgentPhone would be asked to say and how fast the model
// answers, not how AgentPhone's speech engine reads it aloud.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REALTIME_MODEL, type AgentSpec, type ToolName } from '@abos/contracts';
import { STAGE_SHOPS, pizzaCatalog, pizzaSpecV2, pizzaVerifiedFacts, type StageShopKey } from '@abos/contracts/fixtures';
import { createMockToolset } from '../../apps/server/src/tools/mock/index';
import { buildInstructions } from '../../apps/server/src/voice/prompt';
import { checkSessionCapabilities, createWsOpenAISocketFactory } from '../../apps/server/src/voice/relay';
import type { FactsSnapshot } from '../../apps/server/src/voice/types';
import type { CancellableToolHandler } from '../../apps/server/src/tools/real/types';
import { isStoredProposal, openRealtimeCall } from '../../apps/server/src/telephony/agentphone/realtime';
import { agentPhoneChannelLines, agentPhoneGreeting, closingLine, sayableName } from '../../apps/server/src/telephony/agentphone/speech';

let dir = process.cwd();
for (;;) { const f = join(dir, '.env.local'); if (existsSync(f)) { process.loadEnvFile(f); break; } const up = dirname(dir); if (up === dir) break; dir = up; }
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

const DEFAULT_LINES = ['What time do you close tonight?', 'How much is a large pepperoni?', 'One large pepperoni please.', 'That is all. The name is Sam.', 'Six thirty tonight.', 'Yes.'];
const callerLines = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_LINES;

// STAGE=pizza|barber|salon runs the call as one of the three stage shops (fixtures/demo-stage.ts), with the
// mock toolset reading that shop's facts. Without it the call runs on the two-pizza fixture.
const stageKey = process.env.STAGE as StageShopKey | undefined;
const stage = stageKey ? STAGE_SHOPS[stageKey] : undefined;
if (stageKey && !stage) throw new Error('STAGE must be pizza, barber or salon');
const stageFactList = stage ? [...stage.facts, ...stage.services.map((x) => ({ kind: 'service' as const, key: x.id, value: { ...x } }))] : [];
const businessName = stage ? stage.name : 'Demo Pizza Co.';
const spec: AgentSpec = stage ? { ...stage.agent, version: 1 } : pizzaSpecV2;
const menu = stage ? (stage.catalog.length > 0 ? stage.catalog : undefined) : pizzaCatalog;
const facts: FactsSnapshot = {
  facts: stage
    ? (stageFactList.map((f) => ({ kind: f.kind, key: f.key, value: f.value, version: 1 })) as FactsSnapshot['facts'])
    : pizzaVerifiedFacts.flatMap((f) => (f.kind === 'menu_item' || f.status !== 'verified' ? [] : [{ kind: f.kind, key: f.key, value: f.value, version: f.version }])),
  timezone: 'America/Los_Angeles',
};
const now = new Date();
const check = checkSessionCapabilities(spec);
if (!check.ok) throw new Error('the fixture spec has a capability that is not allowed');
const tools: readonly ToolName[] = check.tools;
const toolset = createMockToolset({ businessId: spec.businessId, now: () => now,
  ...(stage ? { catalog: stage.catalog, facts: stageFactList.map((f) => ({ ...f, businessId: stage.businessId, status: 'verified' })) as never } : {}) });
const greeting = agentPhoneGreeting(businessName, spec.template, process.env.AGENTPHONE_GREETING, stage?.services.map((x) => x.name));
const instructions = `${buildInstructions(spec, { businessName, messageChannel: 'qr_only', facts, menu, nowMs: now.getTime() })}\n${agentPhoneChannelLines(greeting, businessName)}`;
const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

const opened = Date.now();
const rt = await openRealtimeCall({
  socketFactory: createWsOpenAISocketFactory({ apiKey }), model: process.env.OPENAI_REALTIME_MODEL ?? REALTIME_MODEL, instructions, tools,
  handler: toolset.handler as unknown as CancellableToolHandler,
  ctx: { businessId: spec.businessId, agentVersionId: 'agv_trial', callId: 'call_trial', correlationId: 'call_trial' },
  onToolResult: (e) => { console.log(`  [tool ${e.tool} -> ${e.ok ? 'ok' : 'failed'} in ${e.latencyMs} ms]`); },
});
console.log(`--- session open in ${Date.now() - opened} ms; prompt ${instructions.length} characters ---`);
console.log(`AGENT (greeting, ${words(greeting)} words): ${greeting}`);

let hangup = false;
const times: number[] = [];
for (const line of callerLines) {
  console.log(`CALLER: ${line}`);
  const t0 = Date.now();
  const r = await rt.turn(line);
  const ms = Date.now() - t0;
  times.push(ms);
  const proposal = r.tools.find((e) => (e.tool === 'propose_order' || e.tool === 'propose_booking') && isStoredProposal(e.result));
  const args = proposal?.args as { contact?: { name?: unknown }; customer?: { name?: unknown } } | undefined;
  const reply = proposal ? closingLine(spec.template, businessName, sayableName(args?.contact?.name ?? args?.customer?.name)) : r.kind === 'tool_limit' ? '(tool limit reached)' : r.text;
  console.log(`AGENT (${words(reply)} words, ${ms} ms, ${r.toolCalls} tool calls${proposal ? ', server closing line' : ''}): ${reply}`);
  if (proposal || r.kind === 'tool_limit') { hangup = true; break; }
}
rt.close('call_end');
const sorted = [...times].sort((a, b) => a - b);
console.log(`--- turns ${times.length}; p50 ${sorted[Math.floor(sorted.length / 2)] ?? 0} ms; max ${sorted.at(-1) ?? 0} ms; last reply carried hangup: ${hangup ? 'yes' : 'no'} ---`);
