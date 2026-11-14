// Checks that the real realtime model ACCEPTS the phone session settings this server sends
// (audio format, turn detection, noise reduction, tools, prompt), without placing a call.
// It opens one session, sends the exact session.update the relay builds, and reports whether
// the provider answered session.updated or an error. No audio is sent. A few cents of model use.
//
//   npx tsx scripts/live/session-check.ts
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';
import { REALTIME_MODEL } from '@abos/contracts';
import { pizzaCatalog, pizzaSpecV2, pizzaVerifiedFacts } from '@abos/contracts/fixtures';
import { OPENAI_REALTIME_URL, VOICE } from '../../apps/server/src/voice/constants';
import { buildInstructions } from '../../apps/server/src/voice/prompt';
import { buildSessionUpdate, checkSessionCapabilities } from '../../apps/server/src/voice/relay';

let dir = process.cwd();
for (;;) { const f = join(dir, '.env.local'); if (existsSync(f)) { process.loadEnvFile(f); break; } const up = dirname(dir); if (up === dir) break; dir = up; }
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

const check = checkSessionCapabilities(pizzaSpecV2);
if (!check.ok) throw new Error('the fixture spec has a capability that is not allowed');
const facts = {
  facts: pizzaVerifiedFacts.flatMap((f) => (f.kind === 'menu_item' ? [] : [{ kind: f.kind, key: f.key, value: f.value, version: f.version }])),
  timezone: 'America/Los_Angeles',
};
const model = process.env.OPENAI_REALTIME_MODEL ?? REALTIME_MODEL;
const instructions = buildInstructions(pizzaSpecV2, { businessName: 'Demo Pizza Co.', messageChannel: 'qr_only', facts, menu: pizzaCatalog, nowMs: Date.now() } as never);
const update = (buildSessionUpdate as (a: unknown) => { session: { audio?: { input?: unknown } } })({ model, voice: VOICE, instructions, tools: check.tools });
console.log('audio.input sent:', JSON.stringify(update.session.audio?.input));

const ws = new WebSocket(`${OPENAI_REALTIME_URL}?model=${encodeURIComponent(model)}`, { headers: { Authorization: `Bearer ${apiKey}` } });
const done = (line: string, code: number) => { console.log(line); process.exitCode = code; ws.close(); };
ws.on('open', () => ws.send(JSON.stringify(update)));
ws.on('message', (data) => {
  const ev = JSON.parse(String(data)) as { type: string; error?: { type?: string; code?: string; message?: string; param?: string }; session?: { audio?: { input?: unknown } } };
  if (ev.type === 'session.updated') done(`ACCEPTED. audio.input as the provider stored it: ${JSON.stringify(ev.session?.audio?.input)}`, 0);
  else if (ev.type === 'error') done(`REFUSED: type=${ev.error?.type} code=${ev.error?.code} param=${ev.error?.param} message=${String(ev.error?.message).slice(0, 200)}`, 1);
});
ws.on('error', (err) => done(`SOCKET ERROR: ${err.name}`, 1));
setTimeout(() => done('TIMED OUT waiting for session.updated', 1), 15000).unref();
