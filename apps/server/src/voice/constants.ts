// Every OpenAI Realtime and Twilio Media Stream wire name the voice worker depends on.
// Lifted from scripts/spikes/voice, whose session shape and event names were run against
// gpt-realtime-2.1 on 2026-11-13. The Twilio leg has not yet been run on a real call.
// If a real call shows a name is wrong, fix it here and nowhere else.

/** WebSocket URL. The model ID goes in the `model` query parameter. Auth is `Authorization: Bearer`. */
export const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime';

/** G.711 u-law, which Twilio Media Streams send and accept (audio/x-mulaw, 8000 Hz). No transcoding. */
export const AUDIO_FORMAT = { type: 'audio/pcmu' } as const;

/** Voice for the model's speech. */
export const VOICE = 'alloy';

export const TURN_DETECTION = { type: 'server_vad' } as const;

/** Client events we send to OpenAI. */
export const OAI_CLIENT = {
  sessionUpdate: 'session.update',
  audioAppend: 'input_audio_buffer.append',
  responseCreate: 'response.create',
  itemCreate: 'conversation.item.create',
  itemTruncate: 'conversation.item.truncate',
} as const;

/** Server events we read from OpenAI. Every other event, transcripts included, is dropped unread. */
export const OAI_SERVER = {
  sessionCreated: 'session.created',
  sessionUpdated: 'session.updated',
  audioDelta: 'response.output_audio.delta',
  speechStarted: 'input_audio_buffer.speech_started',
  speechStopped: 'input_audio_buffer.speech_stopped',
  responseDone: 'response.done',
  error: 'error',
  /** The PROPOSED text step reads these only while it waits for the caller's one answer turn. */
  audioCommitted: 'input_audio_buffer.committed',
  transcriptionCompleted: 'conversation.item.input_audio_transcription.completed',
  transcriptionFailed: 'conversation.item.input_audio_transcription.failed',
  /** The model's own transcript of one response's audio, read only for the server's offer line. */
  outputTranscriptDone: 'response.output_audio_transcript.done',
} as const;

/**
 * PROPOSED text step. Input transcription is turned on only while the relay waits for the caller's
 * answer to the text offer (`audio.input.transcription`), and off again after. Field and event names
 * were read from OpenAI's Realtime reference on 2026-11-14; not yet run against the live API.
 */
export const TRANSCRIBE_MODEL = 'gpt-4o-transcribe';

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
  /** A keypad press on a bidirectional stream: `{ event: 'dtmf', dtmf: { track: 'inbound', digit } }`. Read from Twilio's docs on 2026-11-14; not yet seen on a real call. */
  dtmf: 'dtmf',
} as const;

/** G.711 u-law at 8000 Hz: one byte per sample, so 8 bytes per millisecond. */
export const ULAW_BYTES_PER_MS = 8;

/** Name of the `<Parameter>` that carries the stream token (SPEC 2.9). */
export const STREAM_TOKEN_PARAM = 'streamToken';

/** Path of the Media Stream WebSocket. */
export const WS_PATH = '/ws/phone';

/** Path of the Twilio voice webhook. */
export const VOICE_WEBHOOK_PATH = '/webhooks/twilio/voice';
