import type { REALTIME_MODEL } from './env';

// The session configuration sent to OpenAI when a client secret is minted.
// This is the security boundary of owner voice, so the server builds all of it
// and the browser sends none of it.
//
// docs/API.md 3.5 and docs/FLOWS.md step A3: the voice model has no tools and
// decides nothing. The browser sends each final owner transcript to
// POST /api/builder/sessions/:id/messages with inputMode "voice", the same code
// path as typed chat (registry check, unsupported requests, spec validation),
// and the voice model only speaks the reply the server returns.
//
// So the tool list is empty, tool_choice is "none", and turn detection does not
// create a response by itself (create_response: false). The model speaks only
// when the browser asks it to read a builder reply aloud.
//
// Field names follow the OpenAI API reference for POST /v1/realtime/client_secrets
// (read 2026-11-14). The real call has not run: there is no OPENAI_API_KEY.

// Shortest practical expiry. The API accepts 10 to 7200 seconds. The browser
// asks for the microphone first, then mints, then posts its SDP offer at once,
// so 60 seconds is enough. The docs do not say whether the secret must stay
// valid after the WebRTC connection is set up.
export const CLIENT_SECRET_TTL_SECONDS = 60;

// Picked from the enum in the API reference. SPEC names no transcription model.
export const INPUT_TRANSCRIPTION_MODEL = 'whisper-1';

// The builder tools the voice model may call. Empty on purpose (see above).
export const BUILDER_VOICE_TOOLS: readonly never[] = Object.freeze([]);

export const BUILDER_VOICE_INSTRUCTIONS = [
  'You are the voice of a setup assistant that helps a small-business owner build a phone agent.',
  'You have no tools and you decide nothing. A separate builder service hears what the owner says and writes every reply.',
  'Do not answer the owner on your own.',
  'When you are asked to speak a reply, read that reply aloud as written, in a calm and friendly voice.',
  'Never add questions, facts, prices, hours, promises or advice of your own, and never say that something was saved, published or approved unless the reply says so.',
].join(' ');

export interface RealtimeSessionConfig {
  type: 'realtime';
  model: typeof REALTIME_MODEL;
  instructions: string;
  output_modalities: ['audio'];
  tools: readonly never[];
  tool_choice: 'none';
  audio: {
    input: {
      transcription: { model: string };
      turn_detection: { type: 'server_vad'; create_response: false; interrupt_response: true };
    };
  };
}

export interface ClientSecretRequest {
  expires_after: { anchor: 'created_at'; seconds: number };
  session: RealtimeSessionConfig;
}

export function builderVoiceClientSecretRequest(model: typeof REALTIME_MODEL): ClientSecretRequest {
  return {
    expires_after: { anchor: 'created_at', seconds: CLIENT_SECRET_TTL_SECONDS },
    session: {
      type: 'realtime',
      model,
      instructions: BUILDER_VOICE_INSTRUCTIONS,
      output_modalities: ['audio'],
      tools: BUILDER_VOICE_TOOLS,
      tool_choice: 'none',
      audio: {
        input: {
          transcription: { model: INPUT_TRANSCRIPTION_MODEL },
          turn_detection: { type: 'server_vad', create_response: false, interrupt_response: true },
        },
      },
    },
  };
}
