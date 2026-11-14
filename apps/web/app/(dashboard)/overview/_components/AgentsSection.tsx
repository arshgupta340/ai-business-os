'use client';

import {Button} from '@astryxdesign/core/Button';
import {ClickableCard} from '@astryxdesign/core/ClickableCard';
import {Grid} from '@astryxdesign/core/Grid';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {EmptyState} from '@/components/EmptyState';
import {LoadingState} from '@/components/LoadingState';
import {StatusBadge} from '@/components/StatusBadge';
import {useAgents, useLiveAgent, type Agent, type LiveAgent} from '@/lib/api';
import {lastFour} from '@/lib/format';
import {useBusiness} from '@/lib/session';
import {statusView} from '@/lib/status';
import {BlockError} from './BlockError';
import {sortAgents, templateLabel, versionLabel} from './overview-logic';

function AgentCard({agent, liveAgent}: {agent: Agent; liveAgent?: LiveAgent}) {
  const state = statusView('agent', agent.state);
  const answering = agent.isLiveAgent;
  const numberEnd = answering && liveAgent?.phoneNumber ? lastFour(liveAgent.phoneNumber) : undefined;
  return (
    <ClickableCard href={`/agents/${agent.id}`} label={`Open ${agent.name}`}>
      <VStack gap={2}>
        <HStack gap={2} justify="between" vAlign="start">
          <Heading level={3} maxLines={2}>
            {agent.name}
          </Heading>
          <StatusBadge label={state.label} tone={state.tone} />
        </HStack>
        <Text type="supporting">
          {templateLabel(agent.template)}, {versionLabel(agent)}
        </Text>
        {answering ? (
          <Text type="body">
            {numberEnd ? `Answers the phone number ending ${numberEnd}` : 'Answers the phone number'}
          </Text>
        ) : (
          <Text type="supporting">Does not answer the phone number</Text>
        )}
        {answering && agent.state === 'paused' ? (
          <Text type="body">This agent is paused. Callers hear a closed message.</Text>
        ) : null}
      </VStack>
    </ClickableCard>
  );
}

/** One line about who answers the shared number when no agent of this business does. */
function NumberNote({agents, liveAgent}: {agents: Agent[]; liveAgent?: LiveAgent}) {
  const {businesses, businessId} = useBusiness();
  if (!liveAgent || agents.some((a) => a.isLiveAgent)) return null;
  if (!liveAgent.agentId) {
    return <StatusBadge label="No agent is answering the phone number" tone="neutral" />;
  }
  if (liveAgent.businessId !== businessId) {
    const other = businesses.find((b) => b.id === liveAgent.businessId)?.name ?? 'another business';
    return (
      <Text type="supporting">
        The phone number is answered by an agent of {other}, not by an agent of this business.
      </Text>
    );
  }
  return null;
}

export function AgentsSection({businessId}: {businessId: string}) {
  const agents = useAgents(businessId);
  const liveAgent = useLiveAgent();

  let body;
  if (agents.isPending) {
    body = <LoadingState label="Loading agents" />;
  } else if (!agents.data) {
    // No data at all: the first load failed. A failed refetch keeps the old data and the page header says so.
    body = <BlockError title="Could not load agents" error={agents.error} onRetry={() => void agents.refetch()} />;
  } else if (agents.data.items.length === 0) {
    body = (
      <EmptyState
        title="No agents yet"
        description="Build an agent by describing your business in a conversation."
        headingLevel={3}
        actions={<Button label="Build an agent" variant="primary" href="/build" />}
      />
    );
  } else {
    const sorted = sortAgents(agents.data.items);
    body = (
      <VStack gap={3}>
        <NumberNote agents={sorted} liveAgent={liveAgent.data} />
        <Grid columns={{minWidth: 260, max: 3}} gap={4}>
          {sorted.map((agent) => (
            <AgentCard key={agent.id} agent={agent} liveAgent={liveAgent.data} />
          ))}
        </Grid>
      </VStack>
    );
  }

  return (
    <VStack gap={3}>
      <Heading level={2}>Agents</Heading>
      {body}
    </VStack>
  );
}
