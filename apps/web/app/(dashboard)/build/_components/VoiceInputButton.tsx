'use client';

import {Button} from '@astryxdesign/core/Button';
import {Icon} from '@astryxdesign/core/Icon';

/**
 * Placeholder for owner voice input. It is visible but disabled and never
 * asks for the microphone. Task U-12 replaces it with a voice session that
 * calls useBuilderThreadContext().send(transcript, "voice") on each final
 * transcript, so voice turns join the same thread as typed ones.
 */
export function VoiceInputButton() {
  return (
    <Button
      label="Voice input is not available yet"
      tooltip="Voice input comes in a later update. Type your answer for now."
      icon={<Icon icon="microphone" />}
      isIconOnly
      variant="ghost"
      size="sm"
      isDisabled
    />
  );
}
