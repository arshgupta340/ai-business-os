// Probe: talk to the OpenAI Realtime API with exactly the session setup the phone relay uses,
// but with no Twilio and no phone. It answers, with only an OpenAI key:
//   1. Does the model accept this session shape (formats, voice, turn detection, tools)?
//   2. Does it speak first, and how fast?
//   3. Do audio deltas carry an item_id (the barge-in logic needs it)?
//   4. Does a question trigger the tool, and does the result come back as speech?
// Run: npm run probe      (needs OPENAI_API_KEY and OPENAI_REALTIME_MODEL in .env.local)
// No audio is saved. Nothing but pass or fail lines is printed.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';
import { AUDIO_FORMAT, OAI_CLIENT, OAI_ITEM, OAI_SERVER, OPENAI_REALTIME_URL, TURN_DETECTION, VOICE } from './constants.js';
import { ulawBase64DurationMs } from './logic.js';
import { INSTRUCTIONS, runTool, toolDefinitions } from './tools.js';

type Json = Record<string, any>;

function loadEnvFile(): void {
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, '.env.local');
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

loadEnvFile();
const apiKey = process.env.OPENAI_API_KEY ?? '';
const model = process.env.OPENAI_REALTIME_MODEL ?? '';
if (!apiKey || !model) {
  console.error(`Missing ${!apiKey ? 'OPENAI_API_KEY' : 'OPENAI_REALTIME_MODEL'} in .env.local.`);
  process.exit(1);
}
const redact = (text: string) => text.split(apiKey).join('[key]').replace(/sk-[A-Za-z0-9_-]{8,}/g, '[key]');

const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const record = (check: string, pass: boolean, detail = '') => {
  results.push({ check, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${check}${detail ? `  (${detail})` : ''}`);
};

const finish = (ws: WebSocket, reason: string) => {
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${reason}. ${results.length - failed} of ${results.length} checks passed.`);
  if (ws.readyState === WebSocket.OPEN) ws.close();
  setTimeout(() => process.exit(failed === 0 && results.length >= 6 ? 0 : 1), 200);
};

const t0 = Date.now();
const ws = new WebSocket(`${OPENAI_REALTIME_URL}?model=${encodeURIComponent(model)}`, {
  headers: { Authorization: `Bearer ${apiKey}` },
});
const send = (ev: Json) => ws.send(JSON.stringify(ev));

let phase: 'setup' | 'greeting' | 'tool_request' | 'tool_answer' | 'done' = 'setup';
let phaseStart = 0;
let audioMsThisResponse = 0;
let sawItemId = false;
let firstAudioLogged = false;

const timeout = setTimeout(() => {
  record(`finished within 60 seconds (stuck in phase "${phase}")`, false);
  finish(ws, 'Timed out');
}, 60_000);

ws.on('unexpected-response', (_req, res) => {
  record('WebSocket accepted', false, `HTTP ${res.statusCode}`);
  clearTimeout(timeout);
  finish(ws, 'OpenAI refused the connection');
});
ws.on('error', (err) => console.error(`socket error: ${redact(err.message)}`));

ws.on('open', () => {
  record('WebSocket accepted', true, `model ${model}, ${Date.now() - t0} ms`);
  send({
    type: OAI_CLIENT.sessionUpdate,
    session: {
      type: 'realtime',
      model,
      output_modalities: ['audio'],
      instructions: INSTRUCTIONS,
      audio: {
        input: { format: AUDIO_FORMAT, turn_detection: TURN_DETECTION },
        output: { format: AUDIO_FORMAT, voice: VOICE },
      },
      tools: toolDefinitions(),
      tool_choice: 'auto',
    },
  });
});

ws.on('message', (raw) => {
  let ev: Json;
  try {
    ev = JSON.parse(raw.toString());
  } catch {
    return;
  }

  if (ev.type === OAI_SERVER.error) {
    record(`no error event in phase "${phase}"`, false, redact(JSON.stringify(ev.error ?? ev)).slice(0, 300));
    clearTimeout(timeout);
    finish(ws, 'OpenAI returned an error');
    return;
  }

  if (ev.type === OAI_SERVER.sessionUpdated && phase === 'setup') {
    const s: Json = ev.session ?? {};
    const inFmt = s.audio?.input?.format?.type;
    const outFmt = s.audio?.output?.format?.type;
    record('session shape accepted (session.updated received)', true);
    record('audio is G.711 u-law in both directions', inFmt === AUDIO_FORMAT.type && outFmt === AUDIO_FORMAT.type, `in ${inFmt}, out ${outFmt}`);
    record('voice and tool registered', s.audio?.output?.voice === VOICE && Array.isArray(s.tools) && s.tools.length === 1, `voice ${s.audio?.output?.voice}, tools ${s.tools?.length}`);
    phase = 'greeting';
    phaseStart = Date.now();
    audioMsThisResponse = 0;
    firstAudioLogged = false;
    send({ type: OAI_CLIENT.responseCreate });
    return;
  }

  if (ev.type === OAI_SERVER.audioDelta && typeof ev.delta === 'string') {
    audioMsThisResponse += ulawBase64DurationMs(ev.delta);
    if (typeof ev.item_id === 'string' && ev.item_id) sawItemId = true;
    if (!firstAudioLogged) {
      firstAudioLogged = true;
      const ms = Date.now() - phaseStart;
      if (phase === 'greeting') record('model speaks first with no caller input', true, `first audio after ${ms} ms`);
      if (phase === 'tool_answer') record('tool result comes back as speech', true, `first audio after ${ms} ms`);
    }
    return;
  }

  if (ev.type === OAI_SERVER.responseDone) {
    const output: Json[] = Array.isArray(ev.response?.output) ? ev.response.output : [];
    const calls = output.filter((o) => o?.type === OAI_ITEM.functionCall);

    if (phase === 'greeting') {
      if (!firstAudioLogged) record('model speaks first with no caller input', false, `response status ${ev.response?.status}`);
      record('greeting audio received', audioMsThisResponse > 500, `${Math.round(audioMsThisResponse)} ms of audio`);
      record('audio deltas carry item_id (needed for barge-in)', sawItemId);
      phase = 'tool_request';
      phaseStart = Date.now();
      audioMsThisResponse = 0;
      firstAudioLogged = false;
      // A typed caller turn stands in for speech, so the tool path can be tested without audio input.
      send({
        type: OAI_CLIENT.itemCreate,
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: "What is today's special?" }] },
      });
      send({ type: OAI_CLIENT.responseCreate });
      return;
    }

    if (phase === 'tool_request') {
      const call = calls[0];
      record('question triggers the tool (function_call in response.done)', Boolean(call), call ? `${call.name}, ${Date.now() - phaseStart} ms` : `no call; status ${ev.response?.status}`);
      if (!call) {
        clearTimeout(timeout);
        finish(ws, 'Stopped: the tool was not called');
        return;
      }
      record('function call has name, arguments and call_id', typeof call.name === 'string' && typeof call.call_id === 'string' && typeof call.arguments === 'string');
      phase = 'tool_answer';
      phaseStart = Date.now();
      audioMsThisResponse = 0;
      firstAudioLogged = false;
      void runTool(call.name, call.arguments).then((result) => {
        send({
          type: OAI_CLIENT.itemCreate,
          item: { type: OAI_ITEM.functionCallOutput, call_id: call.call_id, output: JSON.stringify(result) },
        });
        send({ type: OAI_CLIENT.responseCreate });
      });
      return;
    }

    if (phase === 'tool_answer') {
      if (!firstAudioLogged) record('tool result comes back as speech', false, `response status ${ev.response?.status}`);
      record('spoken answer received after the tool call', audioMsThisResponse > 500, `${Math.round(audioMsThisResponse)} ms of audio`);
      phase = 'done';
      clearTimeout(timeout);
      finish(ws, 'Probe complete');
    }
  }
});
