'use client';

/**
 * Publish, with the owner's explicit confirmation in a dialog. Rules it keeps:
 * - Only the dialog's confirm button publishes. It sends confirm: true and the
 *   makeLive choice the owner ticked.
 * - A second fast press is ignored, and the button is disabled while the
 *   request is open.
 * - The published state comes only from the server's answer, in the info tone
 *   (an agent being live is not a green success state).
 * - A known open required conflict is shown next to the button, but the
 *   server is the one that refuses.
 */

import {useRef, useState} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import {Code} from '@astryxdesign/core/Code';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {Layout, LayoutContent, LayoutFooter} from '@astryxdesign/core/Layout';
import {List, ListItem} from '@astryxdesign/core/List';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {StatusBadge} from '@/components/StatusBadge';
import {isApiError, usePublishAgent, type Agent, type ApiError, type PublishResponse} from '@/lib/api';
import {formatDateTime} from '@/lib/format';
import {statusView} from '@/lib/status';
import {groupCapabilities} from '../../../../build/_lib/spec';
import {publishErrorView} from '../_lib/preview';

export type LiveRoute = {
  phoneNumber?: string;
  /** Who answers the number now: this agent, another named agent, nobody, or not known yet. */
  answeredBy: 'this' | 'other' | 'nobody' | 'unknown';
  otherName?: string;
};

function PublishError({
  error,
  builderHref,
  onRetry,
  isPending,
}: {
  error: ApiError;
  builderHref: string | null;
  onRetry: () => void;
  isPending: boolean;
}) {
  const view = publishErrorView(error, builderHref);
  return (
    <Banner
      status="error"
      title={view.title}
      description={view.message}
      collapsible={false}
      endContent={
        <HStack gap={2} wrap="wrap">
          {view.canRetry ? <Button label="Try again" size="sm" isDisabled={isPending} onClick={onRetry} /> : null}
          {view.next ? <Button label={view.next.label} size="sm" variant="primary" href={view.next.href} /> : null}
        </HStack>
      }>
      <VStack gap={1}>
        {view.conflictIds.length > 0 ? (
          <List density="compact" edge="flush" listStyle="disc" header={<Text type="supporting">Open conflicts:</Text>}>
            {view.conflictIds.map((id) => (
              <ListItem key={id} label={<Code>{id}</Code>} />
            ))}
          </List>
        ) : null}
        {view.issues.length > 0 ? (
          <List density="compact" edge="flush" listStyle="disc">
            {view.issues.map((issue) => (
              <ListItem key={issue} label={<Text type="supporting">{issue}</Text>} />
            ))}
          </List>
        ) : null}
        {error.correlationId ? <Text type="supporting">Reference: {error.correlationId}</Text> : null}
      </VStack>
    </Banner>
  );
}

function routeSentence(route: LiveRoute, makeLive: boolean): string {
  const phone = route.phoneNumber ?? 'the phone number';
  if (route.answeredBy === 'this') {
    return `This agent already answers ${phone}. It keeps answering it with the new version.`;
  }
  if (!makeLive) {
    const who =
      route.answeredBy === 'other' && route.otherName
        ? `${route.otherName} keeps answering ${phone}.`
        : route.answeredBy === 'nobody'
          ? `${phone} stays unanswered.`
          : `${phone} keeps its current agent.`;
    return `The agent goes live but does not answer the phone. ${who}`;
  }
  if (route.answeredBy === 'other' && route.otherName) {
    return `It starts answering ${phone}, replacing ${route.otherName}, which answers it now.`;
  }
  if (route.answeredBy === 'nobody') return `It starts answering ${phone}. No agent answers it now.`;
  return `It starts answering ${phone}, replacing whichever agent answers it now.`;
}

export function PublishPanel({
  businessId,
  agent,
  route,
  blockingConflictCount,
  builderHref,
  timeZone,
  onPublished,
  published,
}: {
  businessId: string;
  agent: Agent;
  route: LiveRoute;
  blockingConflictCount: number;
  builderHref: string | null;
  timeZone: string;
  onPublished: (result: PublishResponse) => void;
  published: PublishResponse | null;
}) {
  const publish = usePublishAgent(businessId, agent.id);
  const [isOpen, setIsOpen] = useState(false);
  const [makeLive, setMakeLive] = useState(agent.isLiveAgent);
  const inFlight = useRef(false);
  const {groups} = groupCapabilities(agent.draftSpec.capabilities);
  const afterApproval = groups.find((g) => g.key === 'afterApproval');
  const agentView = statusView('agent', agent.state);
  const activeVersion = agent.activeVersion?.version;

  const open = () => {
    publish.reset();
    setMakeLive(agent.isLiveAgent);
    setIsOpen(true);
  };

  const confirm = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await publish.mutateAsync({confirm: true, makeLive});
      setIsOpen(false);
      onPublished(result);
    } catch {
      // The error shows in the dialog with its next step.
    } finally {
      inFlight.current = false;
    }
  };

  const error = publish.error && isApiError(publish.error) ? publish.error : null;

  return (
    <Card>
      <VStack gap={3}>
        <HStack gap={2} vAlign="center" justify="between" wrap="wrap">
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Heading level={2}>Publish</Heading>
            <StatusBadge label={agentView.label} tone={agentView.tone} />
            {activeVersion ? <Text type="supporting">Active version {activeVersion}</Text> : <Text type="supporting">Never published</Text>}
          </HStack>
          <Button label="Publish" variant="primary" onClick={open} isDisabled={publish.isPending} />
        </HStack>

        {published ? (
          <Banner
            status="info"
            title={`Published as version ${published.version.version}`}
            description={
              published.agent.isLiveAgent
                ? `This agent is live and answers ${published.phoneNumber}.`
                : `This agent is live. It does not answer ${published.phoneNumber}.`
            }
            collapsible={false}>
            <Text type="supporting">
              Version <Code>{published.version.id}</Code>, published {formatDateTime(published.version.publishedAt, timeZone)}. It cannot be
              changed.
            </Text>
          </Banner>
        ) : agent.state === 'paused' ? (
          <Text type="supporting">This agent is paused. Publishing takes it live again.</Text>
        ) : (
          <Text type="supporting">Publishing creates a version and takes the agent live. You confirm in the next step.</Text>
        )}

        {blockingConflictCount > 0 ? (
          <Banner
            status="error"
            title={blockingConflictCount === 1 ? 'A required conflict is open' : `${blockingConflictCount} required conflicts are open`}
            description="The server refuses to publish while a required conflict is open. Resolve it in Knowledge first."
            collapsible={false}
            endContent={<Button label="Resolve in Knowledge" size="sm" href="/knowledge" />}
          />
        ) : null}
      </VStack>

      <Dialog
        isOpen={isOpen}
        onOpenChange={(next) => {
          if (!next && !publish.isPending) setIsOpen(false);
        }}
        width={600}
        maxHeight="90dvh"
        purpose="form">
        {isOpen ? (
          <Layout
            height="fill"
            header={
              <DialogHeader title={`Publish ${agent.name}?`} onOpenChange={() => (publish.isPending ? undefined : setIsOpen(false))} />
            }
            content={
              <LayoutContent>
                <VStack gap={3}>
                  <Text type="body">When you publish:</Text>
                  <List density="compact" edge="flush" listStyle="disc">
                    <ListItem
                      label={
                        <Text type="body">
                          A new version is created from this draft. A version is never changed after it is published. If the draft has not
                          changed since the active version, that version is used again.
                        </Text>
                      }
                    />
                    <ListItem
                      label={<Text type="body">The agent goes live with the tools listed on this page. It only reads and proposes.</Text>}
                    />
                    {afterApproval ? (
                      <ListItem
                        label={
                          <Text type="body">
                            These run only after you approve each action. {afterApproval.items.map((i) => i.description).join('; ')}.
                          </Text>
                        }
                      />
                    ) : null}
                    <ListItem label={<Text type="body">{routeSentence(route, makeLive)}</Text>} />
                  </List>
                  {route.answeredBy !== 'this' ? (
                    <CheckboxInput
                      label={`Answer ${route.phoneNumber ?? 'the phone number'} with this agent`}
                      description={
                        route.answeredBy === 'other' && route.otherName
                          ? `${route.otherName} stops answering it.`
                          : 'Only one agent answers the number.'
                      }
                      value={makeLive}
                      onChange={(checked) => setMakeLive(checked)}
                      isDisabled={publish.isPending}
                    />
                  ) : null}
                  {blockingConflictCount > 0 ? (
                    <Banner
                      status="warning"
                      title="A required conflict is open"
                      description="The server is expected to refuse this publish until you resolve it in Knowledge."
                      collapsible={false}
                    />
                  ) : null}
                  {error ? (
                    <PublishError error={error} builderHref={builderHref} onRetry={() => void confirm()} isPending={publish.isPending} />
                  ) : null}
                </VStack>
              </LayoutContent>
            }
            footer={
              <LayoutFooter hasDivider>
                <HStack gap={2} justify="end" wrap="wrap">
                  <Button label="Cancel" variant="ghost" isDisabled={publish.isPending} onClick={() => setIsOpen(false)} />
                  <Button
                    label="Publish now"
                    variant="primary"
                    isLoading={publish.isPending}
                    isDisabled={publish.isPending}
                    onClick={() => void confirm()}
                  />
                </HStack>
              </LayoutFooter>
            }
          />
        ) : null}
      </Dialog>
    </Card>
  );
}
