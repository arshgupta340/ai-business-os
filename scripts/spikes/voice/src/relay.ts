// One phone call: Twilio Media Stream <-> our server <-> OpenAI Realtime.
// No audio or transcript is written anywhere. Only event types and timings are logged.
import WebSocket from 'ws';
import {
  AUDIO_FORMAT,
  OAI_CLIENT,
  OAI_ITEM,
  OAI_SERVER,
  OPENAI_REALTIME_URL,
  STREAM_TOKEN_PARAM,
  TURN_DETECTION,
  TWILIO_EVENT,
  VOICE,
} from './constants.js';
import type { SpikeEnv } from './env.js';
import { PlaybackTracker, StreamTokenStore, TimingTracker, ulawBase64DurationMs } from './logic.js';
import { INSTRUCTIONS, runTool, toolDefinitions } from './tools.js';

type Json = Record<string, any>;

/** Remove the API key and anything that looks like an OpenAI key from a log line. */
export function redact(text: string, secret: string): string {
  let out = secret ? text.split(secret).join('[redacted]') : text;
  out = out.replace(/sk-[A-Za-z0-9_\-*]{4,}/g, '[redacted]');
  return out.replace(/(Incorrect API key provided: )[^.]*\./, '$1[redacted].');
}

export function handlePhoneStream(twilioWs: WebSocket, env: SpikeEnv, tokens: StreamTokenStore): void {
  const tag = () => `[call ${callSid ?? '?'}]`;
  let callSid: string | undefined;
  let streamSid: string | undefined;
  let openai: WebSocket | null = null;
  let sessionReady = false;
  let droppedEarlyChunks = 0;
  let closed = false;
  let bargeIns = 0;
  let toolCalls = 0;
  const startedAt = Date.now();
  const playback = new PlaybackTracker();
  const timing = new TimingTracker();

  const sendTwilio = (msg: Json) => {
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.send(JSON.stringify(msg));
  };
  const sendOpenAI = (msg: Json) => {
    if (openai?.readyState === WebSocket.OPEN) openai.send(JSON.stringify(msg));
  };

  const shutdown = (reason: string) => {
    if (closed) return;
    closed = true;
    const s = timing.summary();
    console.log(`${tag()} ended: ${reason}`);
    console.log(
      `${tag()} SUMMARY duration=${Date.now() - startedAt} ms, connect to first audio=${s.connectToFirstAudioMs ?? 'n/a'} ms, ` +
        `turns=${JSON.stringify(s.turns)} ms, turn p50=${s.p50 ?? 'n/a'} ms, turn max=${s.max ?? 'n/a'} ms, ` +
        `tool calls=${toolCalls}, barge-ins=${bargeIns}, caller audio chunks dropped before session ready=${droppedEarlyChunks}`,
    );
    if (openai && (openai.readyState === WebSocket.OPEN || openai.readyState === WebSocket.CONNECTING)) openai.close();
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
  };

  // ---------------- OpenAI side ----------------
  const openOpenAI = () => {
    const url = `${OPENAI_REALTIME_URL}?model=${encodeURIComponent(env.OPENAI_REALTIME_MODEL)}`;
    openai = new WebSocket(url, { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` } });

    openai.on('open', () => {
      console.log(`${tag()} OpenAI socket open (model ${env.OPENAI_REALTIME_MODEL})`);
      sendOpenAI({
        type: OAI_CLIENT.sessionUpdate,
        session: {
          type: 'realtime',
          model: env.OPENAI_REALTIME_MODEL,
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

    openai.on('message', (raw) => {
      let ev: Json;
      try {
        ev = JSON.parse(raw.toString());
      } catch {
        return;
      }
      switch (ev.type) {
        case OAI_SERVER.sessionCreated:
          console.log(`${tag()} session.created`);
          break;
        case OAI_SERVER.sessionUpdated:
          if (!sessionReady) {
            sessionReady = true;
            console.log(`${tag()} session.updated; asking the model to speak first`);
            sendOpenAI({ type: OAI_CLIENT.responseCreate });
          }
          break;
        case OAI_SERVER.audioDelta: {
          if (!streamSid || typeof ev.delta !== 'string') break;
          const itemId: string = ev.item_id ?? 'unknown';
          sendTwilio({ event: TWILIO_EVENT.media, streamSid, media: { payload: ev.delta } });
          const mark = playback.onAudioSent(itemId, ulawBase64DurationMs(ev.delta));
          sendTwilio({ event: TWILIO_EVENT.mark, streamSid, mark: { name: mark } });
          const line = timing.onAudioSent(Date.now());
          if (line) console.log(`${tag()} TIMING ${line}`);
          break;
        }
        case OAI_SERVER.speechStarted: {
          timing.onSpeechStarted();
          const cut = playback.interrupt();
          if (cut && streamSid) {
            bargeIns++;
            const t0 = Date.now();
            sendTwilio({ event: TWILIO_EVENT.clear, streamSid });
            sendOpenAI({
              type: OAI_CLIENT.itemTruncate,
              item_id: cut.itemId,
              content_index: 0,
              audio_end_ms: cut.audioEndMs,
            });
            console.log(`${tag()} BARGE-IN: cleared Twilio buffer and truncated item at ${cut.audioEndMs} ms (${Date.now() - t0} ms to send)`);
          } else {
            console.log(`${tag()} caller speech started (no model audio pending)`);
          }
          break;
        }
        case OAI_SERVER.speechStopped:
          timing.onSpeechStopped(Date.now());
          console.log(`${tag()} caller speech stopped`);
          break;
        case OAI_SERVER.responseDone:
          void handleResponseDone(ev);
          break;
        case OAI_SERVER.error:
          // An invalid-key error echoes part of the key, so redact before logging.
          console.error(`${tag()} OpenAI error: ${redact(JSON.stringify(ev.error ?? ev), env.OPENAI_API_KEY)}`);
          break;
        default:
          break;
      }
    });

    openai.on('unexpected-response', (_req, res) => {
      console.error(`${tag()} OpenAI refused the WebSocket: HTTP ${res.statusCode}. Check OPENAI_API_KEY and OPENAI_REALTIME_MODEL.`);
    });
    openai.on('error', (err) => console.error(`${tag()} OpenAI socket error: ${err.message}`));
    openai.on('close', (code) => shutdown(`OpenAI socket closed (code ${code})`));
  };

  const handleResponseDone = async (ev: Json) => {
    const output: Json[] = Array.isArray(ev.response?.output) ? ev.response.output : [];
    const calls = output.filter((o) => o?.type === OAI_ITEM.functionCall);
    if (ev.response?.status && ev.response.status !== 'completed') {
      console.log(`${tag()} response.done status=${ev.response.status}`);
    }
    if (calls.length === 0) return;
    for (const call of calls) {
      const t0 = Date.now();
      const result = await runTool(String(call.name), String(call.arguments ?? '{}'));
      toolCalls++;
      console.log(`${tag()} TOOL ${call.name} ok=${result.ok} in ${Date.now() - t0} ms`);
      sendOpenAI({
        type: OAI_CLIENT.itemCreate,
        item: { type: OAI_ITEM.functionCallOutput, call_id: call.call_id, output: JSON.stringify(result) },
      });
    }
    sendOpenAI({ type: OAI_CLIENT.responseCreate });
  };

  // ---------------- Twilio side ----------------
  twilioWs.on('message', (raw) => {
    let msg: Json;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.event) {
      case TWILIO_EVENT.connected:
        break;
      case TWILIO_EVENT.start: {
        callSid = msg.start?.callSid;
        streamSid = msg.start?.streamSid ?? msg.streamSid;
        const token: string | undefined = msg.start?.customParameters?.[STREAM_TOKEN_PARAM];
        const check = tokens.consume(token, callSid);
        if (!check.ok) {
          console.error(`${tag()} stream token rejected (${check.reason}); closing`);
          shutdown(`stream token rejected: ${check.reason}`);
          return;
        }
        timing.onConnect(Date.now());
        console.log(`${tag()} stream started; token accepted; opening OpenAI`);
        openOpenAI();
        break;
      }
      case TWILIO_EVENT.media:
        if (!streamSid) return; // no start yet: ignore
        if (!sessionReady) {
          droppedEarlyChunks++;
          return;
        }
        sendOpenAI({ type: OAI_CLIENT.audioAppend, audio: msg.media?.payload });
        break;
      case TWILIO_EVENT.mark:
        if (msg.mark?.name) playback.onMark(String(msg.mark.name));
        break;
      case TWILIO_EVENT.stop:
        shutdown('Twilio sent stop');
        break;
      default:
        break;
    }
  });
  twilioWs.on('error', (err) => console.error(`${tag()} Twilio socket error: ${err.message}`));
  twilioWs.on('close', () => shutdown('Twilio socket closed'));
}
