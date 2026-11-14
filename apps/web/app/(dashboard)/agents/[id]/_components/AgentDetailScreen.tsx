'use client';

// Adapted from the Astryx page template "detail-page" (npm run astryx --
// build "... agent detail page with status, capabilities, recent calls ..."):
// a summary header with status and actions, the main column of cards and a
// side rail. The template's Layout frame, tabs and heroicons were left out:
// the dashboard shell gives the frame and the app uses Astryx only.

import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Grid} from '@astryxdesign/core/Grid';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {List, ListItem} from '@astryxdesign/core/List';
import {MetadataList, MetadataListItem} from '@astryxdesign/core/MetadataList';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {EmptyState} from '@/components/EmptyState';
import {LoadingState} from '@/components/LoadingState';
import {PageHeader} from '@/components/PageHeader';
import {StatusBadge} from '@/components/StatusBadge';
import {isApiError, useActivityFeed, useAgent, useCalls, useLiveAgent, type Agent} from '@/lib/api';
import {formatDateTime, formatRelative} from '@/lib/format';
import {useBusiness} from '@/lib/session';
import {statusView} from '@/lib/status';
import {SCOPE_LABELS, groupCapabilities} from '../../../build/_lib/spec';
import {callTitle, templateLabel, versionLabel} from '../../../overview/_components/overview-logic';
import {ErrorNotice} from '../../_components/ErrorNotice';
import {answersNumber, canOfferPause, shownSpec} from '../../_lib/agents-view';
import {ChangeAgentField} from './ChangeAgentField';
import {PauseControl} from './PauseControl';
import {PhoneNumberCard} from './PhoneNumberCard';

const RECENT_CALLS = 10;

function CapabilitiesCard({agent}: {agent: Agent}) {
  const {spec, source} = shownSpec(agent);
  const {groups, unknownCount} = groupCapabilities(spec.capabilities);
  const scopes = spec.knowledgeScopes ?? [];
  return (
    <Card>
      <VStack gap={4}>
        <VStack gap={1}>
          <Heading level={2}>What the agent can do</Heading>
          <Text type="supporting">
            {source === 'active'
              ? 'From the published version that callers get.'
              : 'From the draft. Nothing is published yet.'}
          </Text>
        </VStack>
        {groups.length === 0 ? <Text type="body">No capabilities yet.</Text> : null}
        {groups.map((group) => (
          <VStack key={group.key} gap={1}>
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Heading level={3}>{group.title}</Heading>
              <StatusBadge label={group.badge} tone={group.tone} />
            </HStack>
            <Text type="supporting">{group.description}</Text>
            <List edge="flush" density="compact">
              {group.items.map((item) => (
                <ListItem key={item.id} label={<Text type="body">{item.description}</Text>} description={item.id} />
              ))}
            </List>
          </VStack>
        ))}
        {unknownCount > 0 ? (
          <Text type="supporting">
            {unknownCount === 1 ? 'One capability is not in the registry and is not shown.' : `${unknownCount} capabilities are not in the registry and are not shown.`}
          </Text>
        ) : null}
        <VStack gap={1}>
          <Heading level={3}>What the agent knows</Heading>
          {scopes.length === 0 ? (
            <Text type="body">No knowledge scopes yet.</Text>
          ) : (
            <List edge="flush" density="compact" listStyle="disc">
              {scopes.map((scope) => (
                <ListItem key={scope} label={SCOPE_LABELS[scope] ?? scope} />
              ))}
            </List>
          )}
        </VStack>
      </VStack>
    </Card>
  );
}

function RecentCallsCard({businessId, agentId, timeZone}: {businessId: string; agentId: string; timeZone: string}) {
  const calls = useCalls(businessId, {agentId, limit: RECENT_CALLS});
  let body;
  if (calls.isPending) body = <LoadingState label="Loading calls" />;
  else if (calls.error) body = <ErrorNotice error={calls.error} context="load" onRetry={() => void calls.refetch()} />;
  else if (calls.data.items.length === 0) body = <Text type="body">No calls for this agent yet.</Text>;
  else {
    body = (
      <List hasDividers edge="outset">
        {calls.data.items.slice(0, RECENT_CALLS).map((call) => {
          const status = statusView('call', call.status);
          return (
            <ListItem
              key={call.id}
              href={`/activity?call=${encodeURIComponent(call.id)}`}
              label={callTitle(call)}
              description={formatDateTime(call.startedAt, timeZone)}
              endContent={<StatusBadge label={status.label} tone={status.tone} />}
            />
          );
        })}
      </List>
    );
  }
  return (
    <Card>
      <VStack gap={3}>
        <Heading level={2}>Last calls</Heading>
        {body}
      </VStack>
    </Card>
  );
}

export function AgentDetailScreen({agentId}: {agentId: string}) {
  const {business, businessId} = useBusiness();
  useActivityFeed(businessId);
  const agent = useAgent(businessId, agentId);
  const liveAgent = useLiveAgent();

  if (!business || !businessId) {
    return <EmptyState title="No business selected" description="Pick a business in the top bar." headingLevel={1} />;
  }

  if (agent.isPending) return <LoadingState label="Loading the agent" />;

  if (agent.error) {
    if (isApiError(agent.error) && agent.error.code === 'NOT_FOUND') {
      return (
        <EmptyState
          title="Agent not found"
          description="Not found in this business. It may belong to another business."
          headingLevel={1}
          actions={<Button label="Back to My Agents" href="/agents" />}
        />
      );
    }
    return (
      <VStack gap={6}>
        <PageHeader title="Agent" />
        <ErrorNotice error={agent.error} context="load" onRetry={() => void agent.refetch()} />
      </VStack>
    );
  }

  const data = agent.data;
  const state = statusView('agent', data.state);
  const answers = answersNumber(data, liveAgent.data);
  const timeZone = business.timezone;
  const base = `/agents/${encodeURIComponent(data.id)}`;

  return (
    <VStack gap={6}>
      <PageHeader
        title={data.name}
        description={`${templateLabel(data.template)}, ${business.name}`}
        actions={
          <>
            <Button label="Preview and test" href={`${base}/preview`} />
            <Button label="Version history" href={`${base}/versions`} variant="ghost" />
          </>
        }
      />

      <Card>
        <VStack gap={3}>
          <HStack gap={2} vAlign="center" wrap="wrap" justify="between">
            <HStack gap={2} vAlign="center" wrap="wrap">
              <StatusBadge label={state.label} tone={state.tone} />
              <Text type="body">{versionLabel(data)}</Text>
            </HStack>
            {canOfferPause(data) ? <PauseControl businessId={businessId} agent={data} answersNumber={answers} /> : null}
          </HStack>
          {data.state === 'draft' ? (
            <Text type="supporting">This agent is a draft. Preview and test it, then publish it from Preview and test.</Text>
          ) : null}
          {data.state === 'paused' ? (
            <Text type="supporting">This agent takes no new calls. To take calls again, publish it from Preview and test.</Text>
          ) : null}
          {data.state === 'live' ? (
            <Text type="supporting">To try it with the real read and propose tools, run a simulated call from Preview and test.</Text>
          ) : null}
          <MetadataList columns="multi">
            {data.activeVersion ? (
              <MetadataListItem label="Published">{formatDateTime(data.activeVersion.publishedAt, timeZone)}</MetadataListItem>
            ) : null}
            <MetadataListItem label="Last updated">{formatRelative(data.updatedAt, timeZone)}</MetadataListItem>
          </MetadataList>
        </VStack>
      </Card>

      <Grid columns={{minWidth: 320, max: 2}} gap={4}>
        <VStack gap={4}>
          <CapabilitiesCard agent={data} />
          <ChangeAgentField key={`${businessId}:${data.id}`} businessId={businessId} agent={data} />
        </VStack>
        <VStack gap={4}>
          <PhoneNumberCard businessId={businessId} agent={data} timeZone={timeZone} />
          <RecentCallsCard businessId={businessId} agentId={data.id} timeZone={timeZone} />
        </VStack>
      </Grid>
    </VStack>
  );
}
