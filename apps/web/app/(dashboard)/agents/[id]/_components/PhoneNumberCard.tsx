'use client';

import {useRef, useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {LoadingState} from '@/components/LoadingState';
import {StatusBadge} from '@/components/StatusBadge';
import {useAgents, useLiveAgent, useSetLiveAgent, type Agent} from '@/lib/api';
import {formatRelative} from '@/lib/format';
import {useBusiness} from '@/lib/session';
import {ErrorNotice} from '../../_components/ErrorNotice';
import {answersNumber, canOfferLiveSwitch, numberOwner, numberOwnerSentence, replacedAgentLabel} from '../../_lib/agents-view';
import {ConfirmDialog} from './ConfirmDialog';

/**
 * The shared phone number (P-06): who answers it now and, for a live agent
 * that does not answer it, the switch. The switch needs the owner's
 * confirmation, names the agent it replaces and shows the new owner of the
 * number only from the live agent read after the server answers.
 */
export function PhoneNumberCard({businessId, agent, timeZone}: {businessId: string; agent: Agent; timeZone: string}) {
  const {businesses} = useBusiness();
  const liveAgent = useLiveAgent();
  const agents = useAgents(businessId);
  const setLive = useSetLiveAgent();
  const [isOpen, setOpen] = useState(false);
  const sending = useRef(false);

  let body;
  if (liveAgent.isPending) {
    body = <LoadingState label="Checking the phone number" />;
  } else if (liveAgent.error) {
    body = <ErrorNotice error={liveAgent.error} context="load" onRetry={() => void liveAgent.refetch()} />;
  } else {
    const live = liveAgent.data;
    const owner = numberOwner(live, businessId, agents.data?.items ?? [agent], businesses);
    const answers = answersNumber(agent, live);
    const replaced = replacedAgentLabel(owner);
    const offer = canOfferLiveSwitch(agent, live);

    const confirm = async () => {
      if (sending.current) return;
      sending.current = true;
      try {
        await setLive.mutateAsync({agentId: agent.id});
        setOpen(false);
      } catch {
        // The error shows in the dialog.
      } finally {
        sending.current = false;
      }
    };

    body = (
      <VStack gap={3}>
        {answers ? (
          <VStack gap={1}>
            <HStack>
              <StatusBadge label="Answers the phone number" tone="info" />
            </HStack>
            <Text type="body">{live.phoneNumber}</Text>
            {agent.state === 'paused' ? (
              <Text type="body">This agent is paused, so callers hear a short closed message and the call ends.</Text>
            ) : null}
            {live.updatedAt ? <Text type="supporting">{`Set ${formatRelative(live.updatedAt, timeZone)}`}</Text> : null}
          </VStack>
        ) : (
          <VStack gap={1}>
            {owner.kind === 'none' ? (
              <HStack>
                <StatusBadge label="No agent is answering the phone number" tone="neutral" />
              </HStack>
            ) : (
              <Text type="body">{numberOwnerSentence(owner)}</Text>
            )}
            <Text type="supporting">This agent does not answer the phone number.</Text>
          </VStack>
        )}

        {offer ? (
          <HStack>
            <Button
              label="Make this agent answer the phone"
              variant="primary"
              onClick={() => {
                setLive.reset();
                setOpen(true);
              }}
            />
          </HStack>
        ) : !answers && agent.state !== 'live' ? (
          <Text type="supporting">
            {agent.state === 'draft'
              ? 'Publish this agent before it can answer the phone number.'
              : 'This agent is paused. Publish it again before it can answer the phone number.'}
          </Text>
        ) : null}

        <ConfirmDialog
          isOpen={isOpen}
          title={`Make ${agent.name} answer the phone?`}
          confirmLabel="Make this agent answer"
          isPending={setLive.isPending}
          onConfirm={() => void confirm()}
          onClose={() => setOpen(false)}>
          <Text type="body">
            {replaced
              ? `${replaced.charAt(0).toUpperCase()}${replaced.slice(1)} stops answering. New calls to the phone number go to ${agent.name}.`
              : `No agent answers the phone number now. New calls go to ${agent.name}.`}
          </Text>
          <Text type="supporting">Calls in progress stay with the agent they started with.</Text>
          {setLive.error ? <ErrorNotice error={setLive.error} context="liveSwitch" onRetry={() => void confirm()} /> : null}
        </ConfirmDialog>
      </VStack>
    );
  }

  return (
    <Card>
      <VStack gap={3}>
        <Heading level={2}>Phone number</Heading>
        {body}
      </VStack>
    </Card>
  );
}
