'use client';

/**
 * The confirm dialog for a rollback. Rules it keeps:
 * - Nothing is sent until the owner presses the confirm button. It sends
 *   `confirm: true` with the chosen version.
 * - The button is disabled while the request is open, and a second fast press
 *   is ignored, so the rollback cannot fire twice.
 * - It reports success only from the server answer. The dialog cannot be
 *   closed while the request is open.
 * - Every documented error gets its own message. Nothing changed in any of them.
 */

import {useRef} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {Layout, LayoutContent, LayoutFooter} from '@astryxdesign/core/Layout';
import {List, ListItem} from '@astryxdesign/core/List';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {useRollbackAgent, type Agent, type AgentVersion, type PublishResponse} from '@/lib/api';
import {changedLabels, rollbackErrorView, versionLabel} from '../_lib/versions';

export type RollbackDialogProps = {
  isOpen: boolean;
  businessId: string;
  agent: Agent;
  target: AgentVersion | null;
  /** The version active when the dialog opened, when it is in the list. */
  active?: AgentVersion;
  onClose: () => void;
  /** Called once, with the server answer, after the rollback succeeded. */
  onRolledBack: (response: PublishResponse) => void;
  /** Refetch the agent and the history (after NOT_FOUND, INVALID_STATE or a lost answer). */
  onReload: () => void;
};

export function RollbackDialog({isOpen, onClose, ...rest}: RollbackDialogProps) {
  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      width={600}
      maxHeight="90dvh"
      purpose="form">
      {isOpen && rest.target ? <RollbackContent onClose={onClose} {...rest} target={rest.target} /> : null}
    </Dialog>
  );
}

function RollbackContent({
  businessId,
  agent,
  target,
  active,
  onClose,
  onRolledBack,
  onReload,
}: Omit<RollbackDialogProps, 'isOpen' | 'target'> & {target: AgentVersion}) {
  const rollback = useRollbackAgent(businessId, agent.id);
  const inFlight = useRef(false);
  const errorView = rollback.error ? rollbackErrorView(rollback.error) : null;
  const pending = rollback.isPending;
  const done = rollback.isSuccess;
  // Only a retryable error leaves the confirm button on.
  const locked = errorView !== null && errorView.next !== 'retry';

  const send = () => {
    if (inFlight.current || pending || done || locked) return;
    inFlight.current = true;
    rollback.mutate(
      {toVersionId: target.id, confirm: true},
      {
        onSuccess: (res) => onRolledBack(res),
        onSettled: () => {
          inFlight.current = false;
        },
      },
    );
  };

  const close = () => {
    if (pending) return;
    onClose();
  };

  const n = target.version;
  const changes = active ? changedLabels(active, target) : [];
  const phoneLine = agent.isLiveAgent
    ? `This agent answers your number, so the number follows: new calls use version ${target.version}.`
    : 'This agent does not answer your number. The rollback does not move the number.';

  const body = (
    <VStack gap={4}>
      <VStack gap={2}>
        <Heading level={3}>What happens</Heading>
        <List density="compact" edge="flush" listStyle="disc">
          <ListItem label={<Text>{`The agent goes back to version ${n}. No new version is created.`}</Text>} />
          <ListItem label={<Text>{phoneLine}</Text>} />
          <ListItem label={<Text>{`Calls in progress keep the version they started with. Calls that start afterwards use version ${n}.`}</Text>} />
          <ListItem
            label={
              <Text>
                {active
                  ? `No version is edited or deleted. ${versionLabel(active)} stays in the history, and you can go back to it the same way.`
                  : 'No version is edited or deleted. Every version stays in the history.'}
              </Text>
            }
          />
          {agent.state === 'paused' ? (
            <ListItem label={<Text>This agent is paused. The rollback makes it live again on this version.</Text>} />
          ) : null}
        </List>
      </VStack>

      {active ? (
        <VStack gap={1}>
          <Heading level={3}>{`From ${versionLabel(active)} to ${versionLabel(target)}`}</Heading>
          <Text type="supporting">
            {changes.length > 0
              ? `Changes: ${changes.join(', ')}. Compare the two versions on this page for the details.`
              : 'The name, goal, greeting, knowledge, failure policy and capabilities are the same in both.'}
          </Text>
        </VStack>
      ) : null}

      {errorView ? (
        <Banner
          status="error"
          title={errorView.title}
          description={errorView.message}
          collapsible={false}
          endContent={
            errorView.next === 'retry' ? (
              <Button label="Try again" onClick={send} isDisabled={pending} />
            ) : errorView.next === 'knowledge' ? (
              <Button label="Open Knowledge review" href="/knowledge" />
            ) : errorView.next === 'reload' ? (
              <Button
                label="Reload the history"
                onClick={() => {
                  onReload();
                  onClose();
                }}
              />
            ) : errorView.next === 'sign_in' ? (
              <Button label="Sign in" href="/sign-in" />
            ) : undefined
          }>
          <VStack gap={1}>
            {errorView.conflictIds && errorView.conflictIds.length > 0 ? (
              <Text type="supporting">{`Open conflicts: ${errorView.conflictIds.join(', ')}`}</Text>
            ) : null}
            {errorView.correlationId ? <Text type="supporting">{`Reference: ${errorView.correlationId}`}</Text> : null}
          </VStack>
        </Banner>
      ) : null}
    </VStack>
  );

  const footer = (
    <HStack gap={2} justify="end" wrap="wrap" vAlign="center">
      <Button label="Cancel" variant="ghost" onClick={close} isDisabled={pending} />
      <Button
        label={`Roll back to version ${n}`}
        variant="primary"
        onClick={send}
        isDisabled={done || locked}
        isLoading={pending}
      />
    </HStack>
  );

  return (
    <Layout
      height="fill"
      header={
        <DialogHeader
          title={`Roll back to version ${n}?`}
          subtitle={agent.name}
          onOpenChange={() => close()}
        />
      }
      content={<LayoutContent>{body}</LayoutContent>}
      footer={<LayoutFooter hasDivider>{footer}</LayoutFooter>}
    />
  );
}
