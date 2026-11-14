// ---------------------------------------------------------------------------
// VENDOR CONSTANTS. Every OpenAI and Twilio wire name this spike depends on.
// If a real call shows a name is wrong, fix it here and nowhere else.
// Sources (read 2026-11-13):
//   OpenAI WebSocket guide:   https://developers.openai.com/api/docs/guides/realtime-websocket
//   OpenAI conversations:     https://developers.openai.com/api/docs/guides/realtime-conversations
//   Twilio sample index.js:   https://github.com/twilio-samples/speech-assistant-openai-realtime-api-node/blob/main/index.js
//   Twilio stream messages:   https://www.twilio.com/docs/voice/media-streams/websocket-messages
//   Twilio <Stream> TwiML:    https://www.twilio.com/docs/voice/twiml/stream
// ---------------------------------------------------------------------------

/** WebSocket URL. The model ID goes in the `model` query parameter. Auth is `Authorization: Bearer`. */
export const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime';

/** G.711 u-law, which is what Twilio Media Streams send and accept (audio/x-mulaw, 8000 Hz). */
export const AUDIO_FORMAT = { type: 'audio/pcmu' } as const;

/** Voice for the model's speech. Not verified that `alloy` is offered for gpt-realtime-2.1. */
export const VOICE = 'alloy';

/** Turn detection. `server_vad` is what the Twilio sample uses. */
export const TURN_DETECTION = { type: 'server_vad' } as const;

/** Client events we send to OpenAI. */
export const OAI_CLIENT = {
  sessionUpdate: 'session.update',
  audioAppend: 'input_audio_buffer.append',
  responseCreate: 'response.create',
  itemCreate: 'conversation.item.create',
  itemTruncate: 'conversation.item.truncate',
} as const;

/** Server events we read from OpenAI. */
export const OAI_SERVER = {
  sessionCreated: 'session.created',
  sessionUpdated: 'session.updated',
  audioDelta: 'response.output_audio.delta',
  speechStarted: 'input_audio_buffer.speech_started',
  speechStopped: 'input_audio_buffer.speech_stopped',
  responseDone: 'response.done',
  error: 'error',
} as const;

/** Item types inside `response.done` output and `conversation.item.create`. */
export const OAI_ITEM = {
  functionCall: 'function_call',
  functionCallOutput: 'function_call_output',
} as const;

/** Twilio Media Stream events. */
export const TWILIO_EVENT = {
  connected: 'connected',
  start: 'start',
  media: 'media',
  mark: 'mark',
  stop: 'stop',
  clear: 'clear',
} as const;

/** G.711 u-law at 8000 Hz: one byte per sample, so 8 bytes per millisecond. */
export const ULAW_BYTES_PER_MS = 8;

/** Name of the `<Parameter>` that carries the stream token (SPEC 2.9). */
export const STREAM_TOKEN_PARAM = 'streamToken';

/** Path of the Media Stream WebSocket. */
export const WS_PATH = '/ws/phone';

/** Path of the Twilio voice webhook. */
export const VOICE_WEBHOOK_PATH = '/webhooks/twilio/voice';
