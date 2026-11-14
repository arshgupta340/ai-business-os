'use client';
/**
 * The microphone control in the builder composer (the sendActions slot).
 *
 * Astryx ships ChatDictationButton and useChatDictation, but they run the
 * browser's own SpeechRecognition with its own microphone capture. Builder
 * voice goes to the OpenAI Realtime API over WebRTC instead, and needs mute
 * and a stop that closes the connection, so this control is built from
 * Astryx Button, Icon, StatusDot, Text and HStack.
 */
import {Button} from '@astryxdesign/core/Button';
import {HStack} from '@astryxdesign/core/HStack';
import {Icon} from '@astryxdesign/core/Icon';
import {StatusDot} from '@astryxdesign/core/StatusDot';
import {Text} from '@astryxdesign/core/Text';
import {useBusiness} from '@/lib/session';
import {useBuilderThreadContext} from '../_hooks/useBuilderThread';
import {useVoiceSession, type UseVoiceSessionOptions, type VoiceDisplayPhase} from './useVoiceSession';
import {STICKY_FAILURES, type VoiceFailure, type VoiceNote} from './voiceSession';

export const PRIVACY_NOTE = 'Speech is sent to OpenAI for transcription.';
export const NOT_AVAILABLE = 'Voice is not available in this environment.';

export function failureSentence(failure: VoiceFailure, retryInSeconds: number | null): string {
  switch (failure) {
    case 'mock':
    case 'integration_unavailable':
      return `${NOT_AVAILABLE} Type your answer instead.`;
    case 'unsupported':
      return 'This browser does not support voice, so type your answer instead.';
    case 'microphone_denied':
      return 'The microphone is blocked, so voice is off. Type your answer, or allow the microphone and try again.';
    case 'no_microphone':
      return 'No microphone was found, so voice is off. Type your answer instead.';
    case 'microphone_failed':
      return 'The microphone did not start, so voice is off. Type your answer instead.';
    case 'rate_limited':
      return retryInSeconds && retryInSeconds > 0
        ? `Voice was started too many times. Try again in ${retryInSeconds} seconds, or type your answer.`
        : 'Voice was started too many times. Try again now, or type your answer.';
    case 'mint_failed':
      return 'Voice did not start. Type your answer, or try voice again.';
    case 'expired':
      return 'Voice took too long to start. Type your answer, or try voice again.';
    case 'connection_failed':
      return 'Voice did not connect. Type your answer, or try voice again.';
    case 'connection_lost':
      return 'The voice connection dropped. Type your answer, or start voice again.';
  }
}

export function noteSentence(note: VoiceNote): string {
  switch (note) {
    case 'not_heard':
      return 'That was not heard clearly. Say it again or type it.';
    case 'busy':
      return 'The builder was still answering, so that was not sent. Say it again after the reply.';
    case 'not_sent':
      return 'What you said was not sent. Check the chat to send it again.';
  }
}

function statusSentence(phase: VoiceDisplayPhase, isMuted: boolean): string {
  switch (phase) {
    case 'requesting_microphone':
      return 'Waiting for microphone permission.';
    case 'connecting':
      return 'Connecting voice.';
    case 'sending':
      return 'Sending what you said.';
    case 'speaking':
      return 'Reading the reply aloud.';
    default:
      return isMuted ? 'Muted.' : 'Listening.';
  }
}

export type VoiceControlProps = Omit<UseVoiceSessionOptions, 'businessId' | 'thread'>;

export function VoiceControl(props: VoiceControlProps) {
  const thread = useBuilderThreadContext();
  const {businessId} = useBusiness();
  const voice = useVoiceSession({businessId, thread, ...props});
  const {state, phase} = voice;

  if (state.failure && STICKY_FAILURES.has(state.failure)) {
    return (
      <HStack gap={2} vAlign="center">
        <Text type="supporting" role="status">
          {state.failure === 'unsupported' ? 'Voice is not supported in this browser.' : NOT_AVAILABLE}
        </Text>
        <Button
          label={failureSentence(state.failure, null)}
          icon={<Icon icon="microphone" />}
          isIconOnly
          variant="ghost"
          size="sm"
          isDisabled
        />
      </HStack>
    );
  }

  if (voice.isActive) {
    const message = state.note ? noteSentence(state.note) : statusSentence(phase, state.isMuted);
    const isConnected = phase === 'listening' || phase === 'speaking' || phase === 'sending';
    return (
      <HStack gap={2} vAlign="center" wrap="wrap">
        <StatusDot
          variant={isConnected ? (state.isMuted ? 'neutral' : 'accent') : 'neutral'}
          label={isConnected ? 'Voice is on' : 'Voice is starting'}
          isPulsing={phase === 'listening' && !state.isMuted}
        />
        <Text type="supporting" role="status">
          {message} {PRIVACY_NOTE}
        </Text>
        <Button
          label={state.isMuted ? 'Unmute the microphone' : 'Mute the microphone'}
          tooltip={state.isMuted ? 'Unmute the microphone' : 'Mute the microphone'}
          icon={<Icon icon="microphone" />}
          isIconOnly
          variant={state.isMuted ? 'secondary' : 'ghost'}
          size="sm"
          isDisabled={!isConnected}
          onClick={() => voice.setMuted(!state.isMuted)}
        />
        <Button label="Stop voice" tooltip="Stop voice" icon={<Icon icon="stop" />} isIconOnly variant="ghost" size="sm" onClick={voice.stop} />
      </HStack>
    );
  }

  const message = state.failure ? failureSentence(state.failure, voice.retryInSeconds) : state.phase === 'ended' ? 'Voice is off.' : null;
  return (
    <HStack gap={2} vAlign="center" wrap="wrap">
      {message ? (
        <Text type="supporting" role="status">
          {message}
        </Text>
      ) : null}
      <Button
        label="Talk to the builder"
        tooltip={`Speak instead of typing. ${PRIVACY_NOTE}`}
        icon={<Icon icon="microphone" />}
        isIconOnly
        variant="ghost"
        size="sm"
        isDisabled={!voice.canStart}
        onClick={voice.start}
      />
    </HStack>
  );
}
