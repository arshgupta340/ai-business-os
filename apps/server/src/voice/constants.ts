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

/**
 * Interruptions and background noise (NOTES.md "Interruptions and background noise"). Every field
 * name and default below was read from OpenAI's Realtime reference and VAD guide on 2026-11-14 and
 * not yet tested on a real call. Each value can be overridden on the server with the env variable
 * named beside it (env.ts), so it can be tuned on Render without a code change.
 */
export type NoiseReduction = 'near_field' | 'far_field' | 'off';
export type VoiceTuning = {
  /** VOICE_VAD_THRESHOLD. server_vad activation threshold, 0 to 1. OpenAI's default is 0.5; higher needs louder audio. */
  vadThreshold: number;
  /** VOICE_VAD_PREFIX_PADDING_MS. Audio kept before detected speech. OpenAI's default is 300. */
  vadPrefixPaddingMs: number;
  /** VOICE_VAD_SILENCE_MS. Silence that ends a caller turn. OpenAI's default is 500. */
  vadSilenceMs: number;
  /** VOICE_NOISE_REDUCTION. `near_field` is OpenAI's type for close-talking microphones, the closest fit for a handset. */
  noiseReduction: NoiseReduction;
  /** VOICE_BARGE_IN_MIN_MS. Caller speech that lasts this long while the agent talks is an interruption. */
  bargeInMinMs: number;
  /** VOICE_GREETING_BARGE_IN_MIN_MS. The same, during the greeting, whose first sentence is the AI disclosure. */
  greetingBargeInMinMs: number;
  /** VOICE_SHORT_REPLY_GRACE_MS. A short sound that ended this close to the end of the agent's speech is answered as a turn. */
  shortReplyGraceMs: number;
  /** VOICE_BARGE_IN_TAIL_MS. Extra talk-over after a confirmed interruption before Twilio's buffer is cleared, 0 to 150. */
  bargeInTailMs: number;
};

export const DEFAULT_VOICE_TUNING: VoiceTuning = {
  vadThreshold: 0.6,
  vadPrefixPaddingMs: 300,
  vadSilenceMs: 600,
  noiseReduction: 'near_field',
  bargeInMinMs: 350,
  greetingBargeInMinMs: 700,
  shortReplyGraceMs: 1000,
  bargeInTailMs: 0,
};

/** The env overrides that are set (already validated by env.ts), as a partial tuning. */
export function voiceTuningFromEnv(env: {
  VOICE_VAD_THRESHOLD?: number | undefined; VOICE_VAD_PREFIX_PADDING_MS?: number | undefined; VOICE_VAD_SILENCE_MS?: number | undefined;
  VOICE_NOISE_REDUCTION?: NoiseReduction | undefined; VOICE_BARGE_IN_MIN_MS?: number | undefined; VOICE_GREETING_BARGE_IN_MIN_MS?: number | undefined;
  VOICE_SHORT_REPLY_GRACE_MS?: number | undefined; VOICE_BARGE_IN_TAIL_MS?: number | undefined;
}): Partial<VoiceTuning> {
  const pairs: [keyof VoiceTuning, number | string | undefined][] = [
    ['vadThreshold', env.VOICE_VAD_THRESHOLD], ['vadPrefixPaddingMs', env.VOICE_VAD_PREFIX_PADDING_MS], ['vadSilenceMs', env.VOICE_VAD_SILENCE_MS],
    ['noiseReduction', env.VOICE_NOISE_REDUCTION], ['bargeInMinMs', env.VOICE_BARGE_IN_MIN_MS], ['greetingBargeInMinMs', env.VOICE_GREETING_BARGE_IN_MIN_MS],
    ['shortReplyGraceMs', env.VOICE_SHORT_REPLY_GRACE_MS], ['bargeInTailMs', env.VOICE_BARGE_IN_TAIL_MS],
  ];
  return Object.fromEntries(pairs.filter(([, v]) => v !== undefined)) as Partial<VoiceTuning>;
}

export type TurnDetection = {
  type: 'server_vad';
  threshold: number;
  prefix_padding_ms: number;
  silence_duration_ms: number;
  /** Off: the relay asks for every reply itself, after it has decided a caller turn is real. */
  create_response: boolean;
  /** Off: one detected sound never cancels the agent; the relay's gate decides (interruption.ts). */
  interrupt_response: boolean;
};

/** The call's normal turn detection. The consent window changes only `interrupt_response` (relay.ts). */
export function turnDetectionFor(t: VoiceTuning): TurnDetection {
  return { type: 'server_vad', threshold: t.vadThreshold, prefix_padding_ms: t.vadPrefixPaddingMs, silence_duration_ms: t.vadSilenceMs, create_response: false, interrupt_response: false };
}

/** `audio.input.noise_reduction`: `{ type }`, or null to turn it off. */
export function noiseReductionFor(t: VoiceTuning): { type: 'near_field' | 'far_field' } | null {
  return t.noiseReduction === 'off' ? null : { type: t.noiseReduction };
}

/** Client events we send to OpenAI. */
export const OAI_CLIENT = {
  sessionUpdate: 'session.update',
  audioAppend: 'input_audio_buffer.append',
  responseCreate: 'response.create',
  responseCancel: 'response.cancel',
  itemCreate: 'conversation.item.create',
  itemTruncate: 'conversation.item.truncate',
  itemDelete: 'conversation.item.delete',
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
