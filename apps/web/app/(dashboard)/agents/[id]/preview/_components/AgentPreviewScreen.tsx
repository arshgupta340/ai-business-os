'use client';

// Agent preview (PRD screen 4): what the agent is and may do, example calls
// on mock tools, a test console, a simulated call once it is live, and
// publish with confirmation. Everything follows the business selector: the
// agent is always read with the selected business, so an agent of another
// business shows as not found.

import {useEffect, useState} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Grid} from '@astryxdesign/core/Grid';
import {List, ListItem} from '@astryxdesign/core/List';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {EmptyState} from '@/components/EmptyState';
import {ErrorState} from '@/components/ErrorState';
import {LoadingState} from '@/components/LoadingState';
import {PageHeader} from '@/components/PageHeader';
import {
  isApiError,
  isMockMode,
  useAgent,
  useBuilderSession,
  useFacts,
  useLiveAgent,
  usePreviewAgent,
  type Agent,
  type PublishResponse,
} from '@/lib/api';
import {errorText} from '@/lib/error-text';
import {useBusiness} from '@/lib/session';
import {rememberedSession} from '../../../../build/_lib/memory';
import {blockingConflicts, draftProblems, simCallGate} from '../_lib/preview';
import {AgentDetails, Permissions} from './AgentSummary';
import {ExampleCalls} from './ExampleCalls';
import {PublishPanel, type LiveRoute} from './PublishPanel';
import {TestConsole} from './TestConsole';

/** The builder session that made this draft, when this browser still remembers it and the server confirms it. */
function useBuilderHref(businessId: string, agentId: string): string | null {
  const [sessionId, setSessionId] = useState<string | null>(null);
  useEffect(() => {
    setSessionId(rememberedSession(businessId));
  }, [businessId]);
  const session = useBuilderSession(businessId, sessionId);
  const {refetch} = session;
  // The builder may have cached this session before Continue linked it to the agent, so read it again once.
  useEffect(() => {
    if (sessionId) void refetch();
  }, [sessionId, refetch]);
  return session.data?.agentId === agentId ? `/build?session=${encodeURIComponent(session.data.id)}` : null;
}

/** Who answers the phone number now. The other agent is read with its own business, which the owner also owns (P-06). */
function useLiveRoute(agent: Agent): LiveRoute {
  const {businesses} = useBusiness();
  const live = useLiveAgent();
  const otherId = live.data?.agentId && live.data.agentId !== agent.id ? live.data.agentId : null;
  const other = useAgent(otherId ? live.data!.businessId : null, otherId);
  if (!live.data) return {answeredBy: agent.isLiveAgent ? 'this' : 'unknown'};
  const phoneNumber = live.data.phoneNumber;
  if (!live.data.agentId) return {phoneNumber, answeredBy: 'nobody'};
  if (live.data.agentId === agent.id) return {phoneNumber, answeredBy: 'this'};
  const bizName = businesses.find((b) => b.id === live.data!.businessId)?.name;
  // Another business is named. When both agents share a name, the other one is
  // told apart by its version, never by its raw ID.
  const otherName = other.data
    ? live.data.businessId !== agent.businessId && bizName
      ? `${other.data.name} (${bizName})`
      : other.data.name === agent.name
        ? `The other ${other.data.name}${other.data.activeVersion ? ` (version ${other.data.activeVersion.version})` : ''}`
        : other.data.name
    : undefined;
  return {phoneNumber, answeredBy: 'other', otherName};
}

function phoneLine(route: LiveRoute): string {
  const phone = route.phoneNumber ?? 'the phone number';
  switch (route.answeredBy) {
    case 'this':
      return `Answers ${phone} now.`;
    case 'other':
      return route.otherName ? `${route.otherName} answers ${phone} now.` : `Another agent answers ${phone} now.`;
    case 'nobody':
      return `No agent answers ${phone} now.`;
    default:
      return 'Phone route not loaded yet.';
  }
}

function Ready({businessId, agent, timeZone}: {businessId: string; agent: Agent; timeZone: string}) {
  const preview = usePreviewAgent(businessId, agent.id);
  const facts = useFacts(businessId);
  const route = useLiveRoute(agent);
  const builderHref = useBuilderHref(businessId, agent.id);
  const [published, setPublished] = useState<PublishResponse | null>(null);
  const {mutate: runPreview} = preview;

  // The preview is a POST with no side effects (mock tools only). Run it once per agent.
  useEffect(() => {
    runPreview();
  }, [runPreview, agent.id]);

  const spec = agent.draftSpec;
  const problems = draftProblems(spec);
  const blocking = blockingConflicts(facts.data?.conflicts);
  const gate = simCallGate(agent.state, agent.activeVersionId);

  return (
    <VStack gap={6}>
      <PageHeader
        title={`Preview: ${agent.name}`}
        description="Check what the agent does, test it with mock tools, then publish it."
        actions={
          <>
            {builderHref ? <Button label="Back to the builder" href={builderHref} /> : null}
            <Button label="Agent details" href={`/agents/${encodeURIComponent(agent.id)}`} />
          </>
        }
      />
      {isMockMode() ? (
        <Banner
          status="info"
          title="Mock mode"
          description="The agent replies here are scripted examples. No live model is answering."
          collapsible={false}
        />
      ) : null}

      {agent.state === 'paused' ? (
        <Banner
          status="warning"
          title="This agent is paused"
          description="It does not take calls. If it is the agent on the phone number, callers hear a short closed message. Publish it to take it live again."
          collapsible={false}
        />
      ) : null}

      {problems.length > 0 ? (
        <Banner
          status="warning"
          title="This draft is not complete"
          description="The server checks the draft again when you publish."
          collapsible={false}
          endContent={<Button label={builderHref ? 'Back to the builder' : 'Open the builder'} size="sm" href={builderHref ?? '/build'} />}>
          <List density="compact" edge="flush" listStyle="disc">
            {problems.map((p) => (
              <ListItem key={p} label={<Text type="body">{p}</Text>} />
            ))}
          </List>
        </Banner>
      ) : null}

      <PublishPanel
        businessId={businessId}
        agent={agent}
        route={route}
        blockingConflictCount={blocking.length}
        builderHref={builderHref}
        timeZone={timeZone}
        published={published}
        onPublished={setPublished}
      />

      <Grid columns={{minWidth: 360, max: 2, repeat: 'fit'}} gap={6} align="start">
        <VStack gap={6}>
          <AgentDetails spec={spec} phoneLine={phoneLine(route)} />
          <Permissions draftCapabilities={spec.capabilities} permissions={preview.data?.permissions} />
          {preview.isPending ? <LoadingState label="Running the example calls on mock tools" /> : null}
          {preview.error ? (
            <ErrorState
              title={
                preview.error.code === 'CAPABILITY_NOT_ALLOWED'
                  ? 'The draft names a capability that is not allowed'
                  : 'The example calls did not run'
              }
              message={
                preview.error.code === 'CAPABILITY_NOT_ALLOWED'
                  ? 'A write tool cannot be given to the caller agent, and every capability must be in the registry. Change the draft in the builder.'
                  : errorText(preview.error)
              }
              onRetry={preview.error.retryable ? () => runPreview() : undefined}
            />
          ) : null}
          {preview.data ? <ExampleCalls examples={preview.data.examples} /> : null}
        </VStack>
        <TestConsole
          // A new publish changes what a simulated call runs, so it starts fresh.
          key={published?.version.id ?? agent.activeVersionId ?? 'draft'}
          businessId={businessId}
          agentId={agent.id}
          agentName={agent.name}
          template={spec.template ?? agent.template}
          simGate={gate}
        />
      </Grid>
    </VStack>
  );
}

export function AgentPreviewScreen({agentId}: {agentId: string}) {
  const {business, businessId} = useBusiness();
  const agent = useAgent(businessId, agentId);
  const timeZone = business?.timezone ?? 'UTC';

  if (!businessId) {
    return <EmptyState title="Choose a business" description="Pick a business in the top bar to see its agents." />;
  }
  if (agent.isPending) return <LoadingState label="Loading the agent" />;
  if (agent.error) {
    if (isApiError(agent.error) && (agent.error.code === 'NOT_FOUND' || agent.error.code === 'FORBIDDEN_BUSINESS')) {
      return (
        <EmptyState
          title="This agent was not found"
          description={
            business
              ? `It is not part of ${business.name}, or it no longer exists.${isMockMode() ? ' Mock mode keeps new agents in memory, so a reload clears them.' : ''}`
              : 'Not found in this business.'
          }
          actions={
            <>
              <Button label="See all agents" href="/agents" variant="primary" />
              <Button label="Build an agent" href="/build" />
            </>
          }
        />
      );
    }
    return (
      <ErrorState
        title="The agent did not load"
        message={errorText(agent.error)}
        onRetry={!isApiError(agent.error) || agent.error.retryable ? () => void agent.refetch() : undefined}
      />
    );
  }
  // Keyed by business and agent so no state from one carries over to another.
  return <Ready key={`${businessId}:${agent.data.id}`} businessId={businessId} agent={agent.data} timeZone={timeZone} />;
}
