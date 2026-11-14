'use client';

import {Button} from '@astryxdesign/core/Button';
import {HStack} from '@astryxdesign/core/HStack';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {StatusBadge} from '@/components/StatusBadge';
import {statusView} from '@/lib/status';
import type {FactEdit} from './useFactEdit';

/**
 * What happened to the newest change for one fact. Nothing here is green: a
 * saved change shows the verified fact itself, which is the info tone.
 */
export function EditNotice({edit, describe, subject}: {edit: FactEdit; describe: (value: unknown) => string; subject: string}) {
  const {phase, approval} = edit;
  if (!phase || !approval) return null;
  const after = describe(approval.payload.after);

  if (phase === 'waiting') {
    const view = statusView('approval', 'PENDING');
    return (
      <VStack gap={1}>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <StatusBadge label={view.label} tone={view.tone} />
          <Text type="supporting">{`Change waiting for your confirmation: ${after}`}</Text>
        </HStack>
        <HStack>
          <Button label="Review and confirm" size="sm" onClick={edit.reopen} />
        </HStack>
      </VStack>
    );
  }
  if (phase === 'saving') {
    const view = statusView('approval', 'APPROVED');
    return (
      <HStack gap={2} vAlign="center" wrap="wrap">
        <StatusBadge label={view.label} tone={view.tone} />
        <Text type="supporting">{`Saving your change to ${after}. The value above changes once the save step finishes.`}</Text>
      </HStack>
    );
  }
  const text =
    phase === 'saved'
      ? `Your change to ${after} is saved.`
      : phase === 'discarded'
        ? `You discarded the change to ${after}. ${subject} did not change.`
        : `The confirmation for ${after} expired before you confirmed it. ${subject} did not change.`;
  const view =
    phase === 'saved' ? statusView('fact', 'verified') : statusView('approval', phase === 'discarded' ? 'REJECTED' : 'EXPIRED');
  return (
    <HStack gap={2} vAlign="center" wrap="wrap">
      <StatusBadge label={view.label} tone={view.tone} />
      <Text type="supporting">{text}</Text>
      <Button label="Dismiss" size="sm" variant="ghost" onClick={edit.dismiss} />
    </HStack>
  );
}
