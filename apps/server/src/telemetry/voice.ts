// first_audio from the phone path (task B-30, issue #37), without a change to apps/server/src/voice/.
//
// The relay already measures the time from the Twilio stream connecting to the first agent audio
// frame sent to Twilio (`TimingTracker`, voice/logic.ts). It reaches nothing durable: the call-end
// port (`CallsPort.endCall(callId, endReason)`) and the `call.ended` event have no field for it. It
// is only logged, once per call at the end, as `voice: call ended` with `connectToFirstAudioMs`.
//
// The relay redacts every log string, and a call ID (`call_` plus 32 hex characters) is redacted as
// a token, so the log line cannot say which call it is. What identifies the call is the toolset:
// the relay's shutdown disposes the call's toolset and then, in the same synchronous step with no
// await between them, logs `voice: call ended` (voice/relay.ts, `shutdown`). So the composition
// root wraps the voice toolset's dispose with `callEnding`, and wraps the voice logger with
// `logger`, which records that line's value as a `first_audio` sample for the call that just ended,
// with the call ID as its correlation ID. Every log line passes through unchanged.
import type { TelemetryPort } from './types';

/** The logger shape the voice plugin takes (structurally the same as the voice module's VoiceLogger). */
export interface TappableLogger {
  info(data: Record<string, unknown>, msg: string): void;
  warn(data: Record<string, unknown>, msg: string): void;
  error(data: Record<string, unknown>, msg: string): void;
}

/** The exact message and field the relay logs when a call ends (voice/relay.ts). */
export const CALL_ENDED_LOG_MESSAGE = 'voice: call ended';
export const FIRST_AUDIO_FIELD = 'connectToFirstAudioMs';

export interface FirstAudioTap {
  /** Call from the voice toolset's dispose, which the relay runs just before it logs the call end. */
  callEnding(call: { callId: string; businessId: string }): void;
  /** Wraps the logger the voice plugin is given. */
  logger(base: TappableLogger): TappableLogger;
}

export function createFirstAudioTap(telemetry: TelemetryPort): FirstAudioTap {
  let ending: { callId: string; businessId: string } | undefined;
  return {
    callEnding(call) { ending = call; },
    logger(base) {
      return {
        info(data, msg) {
          base.info(data, msg);
          if (msg !== CALL_ENDED_LOG_MESSAGE) return;
          // Taken and cleared on every call-end line, so a value can never be credited to another call.
          const call = ending;
          ending = undefined;
          const ms = data[FIRST_AUDIO_FIELD];
          if (call === undefined || typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return;
          // Telemetry never breaks a call.
          try { telemetry.record('first_audio', { businessId: call.businessId, correlationId: call.callId, ms }); } catch { /* ignored */ }
        },
        warn: (data, msg) => base.warn(data, msg),
        error: (data, msg) => base.error(data, msg),
      };
    },
  };
}
