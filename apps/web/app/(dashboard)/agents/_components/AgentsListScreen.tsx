'use client';

// Adapted from the Astryx block "ListItemWithMetadata" (npm run astryx --
// build "list of phone agents with status badges ..."): one row per agent in
// a List inside a Card, the state badge at the end of the row. The dashboard
// shell already gives the page frame.

import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {List, ListItem} from '@astryxdesign/core/List';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {EmptyState} from '@/components/EmptyState';
import {LoadingState} from '@/components/LoadingState';
import {PageHeader} from '@/components/PageHeader';
import {RefreshFailedNotice} from '@/components/RefreshFailedNotice';
import {StatusBadge} from '@/components/StatusBadge';
import {useActivityFeed, useAgents, useLiveAgent, type Agent, type LiveAgent} from '@/lib/api';
import {useDemoHidesAgents} from '@/lib/demo-stage';
import {formatRelative} from '@/lib/format';
import {useBusiness} from '@/lib/session';
import {statusView} from '@/lib/status';
import {agentTemplateLabel} from '@/lib/labels';
import {sortAgents, versionLabel} from '../../overview/_components/overview-logic';
import {answersNumber, numberOwner, numberOwnerSentence} from '../_lib/agents-view';
import {ErrorNotice} from './ErrorNotice';

function AgentRow({agent, liveAgent, timeZone}: {agent: Agent; liveAgent?: LiveAgent; timeZone: string}) {
  const state = statusView('agent', agent.state);
  const answers = answersNumber(agent, liveAgent);
  const phoneLine = answers
    ? agent.state === 'paused'
      ? 'Answers the phone number, but is paused. Callers hear a closed message.'
      : 'Answers the phone number'
    : 'Does not answer the phone number';
  return (
    <ListItem
      href={`/agents/${encodeURIComponent(agent.id)}`}
      label={agent.name}
      align="first-line"
      description={
        <VStack gap={0.5}>
          <Text type="supporting">
            {agentTemplateLabel(agent.template)}, {versionLabel(agent)}
          </Text>
          <Text type="supporting">{phoneLine}</Text>
          <Text type="supporting">{`Updated ${formatRelative(agent.updatedAt, timeZone)}`}</Text>
        </VStack>
      }
      endContent={<StatusBadge label={state.label} tone={state.tone} />}
    />
  );
}

export function AgentsListScreen() {
  const {business, businessId, businesses} = useBusiness();
  // Each agent or live agent event refetches the queries below.
  useActivityFeed(businessId);
  const agents = useAgents(businessId);
  const liveAgent = useLiveAgent();
  // The scripted demo shows no agent until its build step has reached the phone number.
  const hidden = useDemoHidesAgents();

  if (!business || !businessId) {
    return <EmptyState title="No business selected" description="Pick a business in the top bar." headingLevel={1} />;
  }

  const buildAction = <Button label="Build an agent" variant="primary" href="/build" />;

  let body;
  if (agents.isPending) {
    body = <LoadingState label="Loading agents" />;
  } else if (!agents.data) {
    // The first load failed. A failed refetch keeps the list and the line under the header says so.
    body = <ErrorNotice error={agents.error} context="load" title="Could not load your agents" onRetry={() => void agents.refetch()} />;
  } else if (hidden || agents.data.items.length === 0) {
    body = (
      <EmptyState
        title="No agents yet"
        description="Build an agent by describing your business in a conversation."
        actions={<Button label="Build an agent" variant="primary" href="/build" />}
      />
    );
  } else {
    const sorted = sortAgents(agents.data.items);
    const owner = liveAgent.data ? numberOwner(liveAgent.data, businessId, sorted, businesses) : null;
    body = (
      <VStack gap={3}>
        {owner ? <Text type="body">{numberOwnerSentence(owner)}</Text> : null}
        {liveAgent.error && !liveAgent.data ? <ErrorNotice error={liveAgent.error} context="load" title="Could not check which agent answers the phone" onRetry={() => void liveAgent.refetch()} /> : null}
        <Card padding={2}>
          <List hasDividers edge="outset" header={<Text type="label">{`${sorted.length} ${sorted.length === 1 ? 'agent' : 'agents'}`}</Text>}>
            {sorted.map((agent) => (
              <AgentRow key={agent.id} agent={agent} liveAgent={liveAgent.data} timeZone={business.timezone} />
            ))}
          </List>
        </Card>
      </VStack>
    );
  }

  return (
    <VStack gap={6}>
      <PageHeader title="My Agents" description={business.name} actions={buildAction} />
      <RefreshFailedNotice businessId={businessId} />
      {body}
    </VStack>
  );
}
