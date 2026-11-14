'use client';

import {useRef, useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Text} from '@astryxdesign/core/Text';
import {usePauseAgent, type Agent} from '@/lib/api';
import {ErrorNotice} from '../../_components/ErrorNotice';
import {ConfirmDialog} from './ConfirmDialog';

/**
 * Pause with the owner's confirmation. The state badge on the page comes
 * from the agent read, which refetches after the server answers, so the
 * page never shows "Paused" before the server has paused the agent.
 */
export function PauseControl({businessId, agent, answersNumber}: {businessId: string; agent: Agent; answersNumber: boolean}) {
  const [isOpen, setOpen] = useState(false);
  const pause = usePauseAgent(businessId, agent.id);
  const sending = useRef(false);

  const open = () => {
    pause.reset();
    setOpen(true);
  };

  const confirm = async () => {
    if (sending.current) return;
    sending.current = true;
    try {
      await pause.mutateAsync();
      setOpen(false);
    } catch {
      // The error shows in the dialog.
    } finally {
      sending.current = false;
    }
  };

  return (
    <>
      <Button label="Pause agent" onClick={open} />
      <ConfirmDialog
        isOpen={isOpen}
        title={`Pause ${agent.name}?`}
        confirmLabel="Pause agent"
        confirmVariant="destructive"
        isPending={pause.isPending}
        onConfirm={() => void confirm()}
        onClose={() => setOpen(false)}>
        <Text type="body">{`${agent.name} stops taking new calls. Calls in progress finish on the version they started with.`}</Text>
        {answersNumber ? (
          <Text type="body">This agent answers the phone number. While it is paused, callers hear a short closed message and the call ends.</Text>
        ) : null}
        <Text type="supporting">Actions you already approved still run. To take calls again, publish the agent from Preview and test.</Text>
        {pause.error ? <ErrorNotice error={pause.error} context="pause" onRetry={() => void confirm()} /> : null}
      </ConfirmDialog>
    </>
  );
}
