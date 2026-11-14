'use client';

import type {ReactNode} from 'react';
import {useRouter} from 'next/navigation';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Divider} from '@astryxdesign/core/Divider';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {Icon} from '@astryxdesign/core/Icon';
import {Link} from '@astryxdesign/core/Link';
import {List, ListItem} from '@astryxdesign/core/List';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {StatusBadge} from '@/components/StatusBadge';
import {useApproval, useCreateAgent, type AgentSpec} from '@/lib/api';
import {statusView} from '@/lib/status';
import {useBuilderThreadContext} from '../_hooks/useBuilderThread';
import {errorText} from '@/lib/error-text';
import {agentTemplateLabel, bundleLabel} from '@/lib/labels';
import {
  CHANNEL_LABELS,
  continueState,
  ESCALATION_LABELS,
  groupCapabilities,
  groupStopConditions,
  missingFieldQuestion,
  scopeLabel,
  type StopLine,
  WRITE_POLICY_LABELS,
} from '../_lib/spec';

const NOT_SET = 'Not set yet';

function Detail({label, children}: {label: string; children: ReactNode}) {
  return (
    <VStack gap={0.5}>
      <Text type="label" color="secondary">
        {label}
      </Text>
      <Text type="body">{children}</Text>
    </VStack>
  );
}

function SectionTitle({title, end}: {title: string; end?: ReactNode}) {
  return (
    <HStack gap={2} vAlign="center" justify="between" wrap="wrap">
      <Heading level={3}>{title}</Heading>
      {end}
    </HStack>
  );
}

function SpecDetails({spec}: {spec: Partial<AgentSpec>}) {
  const scopes = (spec.knowledgeScopes ?? []).map(scopeLabel);
  return (
    <VStack gap={3}>
      <Detail label="Name">{spec.name || NOT_SET}</Detail>
      <Detail label="Goal">{spec.goal || NOT_SET}</Detail>
      <Detail label="Template">{spec.template ? agentTemplateLabel(spec.template) : NOT_SET}</Detail>
      <Detail label="Channel">{spec.channel ? CHANNEL_LABELS[spec.channel] : NOT_SET}</Detail>
      <Detail label="Greeting">{spec.greeting || NOT_SET}</Detail>
      <Detail label="Knowledge it can use">{scopes.length ? scopes.join(', ') : NOT_SET}</Detail>
      <Detail label="Actions">{spec.writePolicy ? WRITE_POLICY_LABELS[spec.writePolicy] : NOT_SET}</Detail>
      <Detail label="When it cannot help">{spec.escalation ? ESCALATION_LABELS[spec.escalation] : NOT_SET}</Detail>
    </VStack>
  );
}

function Capabilities({ids}: {ids: readonly string[] | undefined}) {
  const {groups, unknownCount} = groupCapabilities(ids);
  if (groups.length === 0 && unknownCount === 0) {
    return <Text type="supporting">The builder adds capabilities once it knows the job.</Text>;
  }
  return (
    <VStack gap={4}>
      {groups.map((group) => (
        <VStack key={group.key} gap={1}>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Text type="label" weight="semibold">
              {group.title}
            </Text>
            <StatusBadge label={group.badge} tone={group.tone} />
          </HStack>
          <Text type="supporting">{group.description}</Text>
          <List density="compact" edge="flush">
            {group.items.map((item) => (
              <ListItem key={item.id} label={<Text type="body">{item.description}</Text>} description={<Text type="code">{item.id}</Text>} />
            ))}
          </List>
        </VStack>
      ))}
      {unknownCount > 0 ? (
        <Text type="supporting">
          {unknownCount === 1
            ? 'The draft named one capability that does not exist. It is left out.'
            : `The draft named ${unknownCount} capabilities that do not exist. They are left out.`}
        </Text>
      ) : null}
    </VStack>
  );
}

function StopLines({lines}: {lines: StopLine[]}) {
  return (
    <List density="compact" edge="flush" listStyle="disc">
      {lines.map((line) => (
        <ListItem
          key={line.key}
          label={
            <Text type="body">
              {line.label}{' '}
              {line.link ? (
                <Link href={line.link.href} type="inherit">
                  {line.link.label}
                </Link>
              ) : null}
            </Text>
          }
        />
      ))}
    </List>
  );
}

function ProposedChangeRow({businessId, approvalId, bundleType}: {businessId: string; approvalId: string; bundleType: string}) {
  const approval = useApproval(businessId, approvalId);
  const state = approval.data?.state;
  const view = state ? statusView('approval', state) : null;
  return (
    <Banner
      status="warning"
      title={`${bundleLabel(bundleType)} waits for your decision`}
      description="Nothing changes until you approve it in Approvals."
      collapsible={false}
      endContent={<Button label="Review in Approvals" variant="primary" size="sm" href={`/approvals?id=${encodeURIComponent(approvalId)}`} />}>
      {view ? <StatusBadge label={view.label} tone={view.tone} /> : null}
    </Banner>
  );
}

export function SpecPanel({businessId}: {businessId: string}) {
  const thread = useBuilderThreadContext();
  const router = useRouter();
  const createAgent = useCreateAgent(businessId);
  const session = thread.session;
  const spec = session?.draftSpec ?? {};
  const missing = session?.missingFields ?? [];
  const {notes} = thread;
  const progress = session?.progress ?? notes.progress;
  const gate = continueState({
    draftSpec: spec,
    missingFields: missing,
    stopConditions: notes.stopConditions,
    progress,
    hasOwnerTurn: thread.hasOwnerTurn,
  });
  const existingAgentId = session?.agentId;
  const stops = groupStopConditions(notes.stopConditions);

  const onContinue = async () => {
    if (!session || !gate.canContinue || createAgent.isPending) return;
    try {
      const agent = await createAgent.mutateAsync({builderSessionId: session.id});
      router.push(`/agents/${encodeURIComponent(agent.id)}/preview`);
    } catch {
      // The error shows below the button.
    }
  };

  const createError = createAgent.error;

  return (
    <Card>
      <VStack gap={5}>
        <VStack gap={1}>
          <Heading level={2}>Agent draft</Heading>
          <Text type="supporting">This draft updates after each answer. Nothing is published from here.</Text>
        </VStack>

        <VStack gap={2}>
          {progress && progress.required > 0 ? (
            <ProgressBar
              label="Details confirmed"
              value={Math.min(progress.answered, progress.required)}
              max={progress.required}
              hasValueLabel
              formatValueLabel={(value, max) => `${value} of ${max} details confirmed`}
              variant="neutral"
            />
          ) : (
            <Text type="supporting">Progress shows after your first answer.</Text>
          )}
          {missing.length > 0 ? (
            <VStack gap={1}>
              <Text type="label" weight="semibold">
                Still open
              </Text>
              <List density="compact" edge="flush" listStyle="disc">
                {missing.map((key) => (
                  <ListItem key={key} label={<Text type="body">{missingFieldQuestion(key)}</Text>} />
                ))}
              </List>
            </VStack>
          ) : null}
        </VStack>

        {stops.blocking.length > 0 ? (
          <Banner status="error" title="This draft is blocked" description="Resolve these before you continue." collapsible={false}>
            <StopLines lines={stops.blocking} />
          </Banner>
        ) : null}

        {stops.beforePublish.length > 0 ? (
          <Banner
            status="warning"
            title="Needed before you publish"
            description="You can create the draft now. Publishing stays off until these are done."
            collapsible={false}>
            <StopLines lines={stops.beforePublish} />
          </Banner>
        ) : null}

        {notes.proposedChanges.map((change) => (
          <ProposedChangeRow key={change.approvalId} businessId={businessId} approvalId={change.approvalId} bundleType={change.bundleType} />
        ))}

        <Divider />
        <SpecDetails spec={spec} />

        <Divider />
        <VStack gap={3}>
          <SectionTitle title="What the agent can do" />
          <Capabilities ids={spec.capabilities} />
        </VStack>

        {notes.unsupportedRequests.length > 0 ? (
          <>
            <Divider />
            <VStack gap={2}>
              <SectionTitle title="Not available" />
              <Text type="supporting">You asked for these, but no capability covers them. The agent will not do them, and they are not in the draft.</Text>
              <List density="compact" edge="flush" hasDividers>
                {notes.unsupportedRequests.map((text) => (
                  <ListItem
                    key={text}
                    label={<Text type="body">{text}</Text>}
                    startContent={<Icon icon="warning" color="warning" />}
                    endContent={<StatusBadge label="Not available" tone="warning" />}
                  />
                ))}
              </List>
            </VStack>
          </>
        ) : null}

        <Divider />
        <VStack gap={3}>
          <HStack gap={2} wrap="wrap">
            <Button label="Upload a file" href="/knowledge" icon={<Icon icon="upload" />} />
            <Button label="View extracted facts" href="/knowledge" />
          </HStack>
          {existingAgentId ? (
            <VStack gap={1}>
              <Button label="Open the draft agent" variant="primary" href={`/agents/${encodeURIComponent(existingAgentId)}/preview`} />
              <Text type="supporting">This session already created a draft agent.</Text>
            </VStack>
          ) : (
            <VStack gap={1}>
              <HStack gap={2}>
                <Button
                  label="Continue"
                  variant="primary"
                  isDisabled={!gate.canContinue || !session}
                  isLoading={createAgent.isPending}
                  onClick={() => void onContinue()}
                />
              </HStack>
              {gate.reasons.length > 0 ? (
                <List density="compact" edge="flush" listStyle="disc" header={<Text type="supporting">Continue is off because:</Text>}>
                  {gate.reasons.map((reason) => (
                    <ListItem key={reason} label={<Text type="supporting">{reason}</Text>} />
                  ))}
                </List>
              ) : (
                <Text type="supporting">Continue creates a draft agent. You preview and test it before anything is published.</Text>
              )}
            </VStack>
          )}
          {createError ? (
            <Banner
              status="error"
              title="The draft agent was not created"
              description={
                createError.code === 'CAPABILITY_NOT_ALLOWED'
                  ? 'This spec asks for a capability that is not allowed.'
                  : errorText(createError)
              }
              endContent={createError.retryable ? <Button label="Try again" size="sm" onClick={() => void onContinue()} /> : undefined}>
              {createError.correlationId ? <Text type="supporting">Reference: {createError.correlationId}</Text> : null}
            </Banner>
          ) : null}
        </VStack>
      </VStack>
    </Card>
  );
}
