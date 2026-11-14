'use client';

/**
 * Version history for one agent: every published version, newest first, a
 * side-by-side compare of any two, and a confirmed rollback to an earlier one.
 * Versions are immutable. The active version comes from the agent read, so it
 * changes only after the server has answered and the agent is refetched.
 */

import {useState, type ReactNode} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {List, ListItem} from '@astryxdesign/core/List';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {EmptyState} from '@/components/EmptyState';
import {ErrorState} from '@/components/ErrorState';
import {LoadingState} from '@/components/LoadingState';
import {PageHeader} from '@/components/PageHeader';
import {StatusBadge} from '@/components/StatusBadge';
import {
  isApiError,
  useActivity,
  useActivityFeed,
  useAgent,
  useAgentVersions,
  type Agent,
  type AgentVersion,
  type PublishResponse,
  type ActivityEventType,
} from '@/lib/api';
import {formatDateTime} from '@/lib/format';
import {useBusiness} from '@/lib/session';
import {statusView} from '@/lib/status';
import {canRollBack, defaultPair, rollbackMarks, versionLabel, type RollbackMark} from '../_lib/versions';
import {RollbackDialog} from './RollbackDialog';
import {VersionCompare} from './VersionCompare';

const VERSIONS_QUERY = {limit: 200} as const;
const ACTIVITY_QUERY = {types: ['agent.published'] as ActivityEventType[], limit: 200};

export function VersionsScreen({agentId}: {agentId: string}) {
  const {businessId, business} = useBusiness();
  const timeZone = business?.timezone ?? 'UTC';
  const agentHref = `/agents/${encodeURIComponent(agentId)}`;

  // Each agent.published or live_agent.changed event refetches the agent, versions and activity.
  useActivityFeed(businessId);
  const agent = useAgent(businessId, agentId);
  const versions = useAgentVersions(businessId, agentId, VERSIONS_QUERY);
  const activity = useActivity(businessId, ACTIVITY_QUERY);

  const back = <Button label="Back to the agent" href={agentHref} variant="ghost" />;

  if (agent.isPending || (agent.data && versions.isPending)) {
    return (
      <VStack gap={6}>
        <PageHeader title="Version history" actions={back} />
        <LoadingState label="Loading the versions" />
      </VStack>
    );
  }

  const failed = agent.error ?? versions.error;
  if (failed || !agent.data) {
    if (isApiError(failed) && failed.code === 'NOT_FOUND') {
      return (
        <VStack gap={6}>
          <PageHeader title="Version history" />
          <EmptyState
            title="Not found in this business"
            description="This agent does not exist in the selected business. It may belong to another business."
            actions={<Button label="Back to My Agents" href="/agents" />}
          />
        </VStack>
      );
    }
    const retryable = !isApiError(failed) || failed.retryable;
    return (
      <VStack gap={6}>
        <PageHeader title="Version history" actions={back} />
        <ErrorState
          title="Could not load the versions"
          message={`${failed?.message ?? 'The versions could not be loaded.'}${
            isApiError(failed) && failed.correlationId ? ` Reference: ${failed.correlationId}` : ''
          }`}
          onRetry={
            retryable
              ? () => {
                  void agent.refetch();
                  void versions.refetch();
                }
              : undefined
          }
        />
      </VStack>
    );
  }

  return (
    <LoadedVersions
      businessId={businessId ?? agent.data.businessId}
      agent={agent.data}
      versions={versions.data?.items ?? []}
      marks={rollbackMarks(activity.data?.items ?? [], agentId)}
      timeZone={timeZone}
      back={back}
      reload={() => {
        void agent.refetch();
        void versions.refetch();
        void activity.refetch();
      }}
    />
  );
}

type LoadedProps = {
  businessId: string;
  agent: Agent;
  versions: AgentVersion[];
  marks: Map<string, RollbackMark>;
  timeZone: string;
  back: ReactNode;
  reload: () => void;
};

function LoadedVersions({businessId, agent, versions, marks, timeZone, back, reload}: LoadedProps) {
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  const byId = new Map(sorted.map((v) => [v.id, v]));
  const active = agent.activeVersionId ? byId.get(agent.activeVersionId) : undefined;
  const agentView = statusView('agent', agent.state);

  const initial = defaultPair(sorted, agent.activeVersionId);
  const [pair, setPair] = useState<[string, string] | null>(initial);
  const shownPair = pair && byId.has(pair[0]) && byId.has(pair[1]) ? pair : initial;

  const [targetId, setTargetId] = useState<string | null>(null);
  const target = targetId ? (byId.get(targetId) ?? null) : null;
  // The server answer of the last rollback. Shown only after the server confirmed it.
  const [result, setResult] = useState<PublishResponse | null>(null);

  const onRolledBack = (res: PublishResponse) => {
    setTargetId(null);
    setResult(res);
    reload();
  };

  const header = (
    <PageHeader
      title="Version history"
      description={agent.name}
      actions={
        <>
          <StatusBadge label={agentView.label} tone={agentView.tone} />
          {back}
        </>
      }
    />
  );

  if (sorted.length === 0) {
    return (
      <VStack gap={6}>
        {header}
        <EmptyState
          title="This agent has not been published yet"
          description="A version is saved each time you publish. Publish this draft to start its history."
          actions={<Button label="Back to the agent" href={`/agents/${encodeURIComponent(agent.id)}`} />}
        />
      </VStack>
    );
  }

  const fromLabel = (id: string) => {
    const v = byId.get(id);
    return v ? `v${v.version}` : 'an earlier version';
  };

  return (
    <VStack gap={6}>
      {header}

      {result ? (
        <Banner
          status="info"
          title={`Version ${result.version.version} is the active version again`}
          description="The server confirmed the rollback. No version was created or deleted. Calls already in progress finish on the version they started with."
          isDismissable
          onDismiss={() => setResult(null)}
        />
      ) : null}

      <Card>
        <VStack gap={3}>
          <VStack gap={1}>
            <Heading level={2}>Versions</Heading>
            <Text type="supporting">Each publish saves a version. A version is never edited or deleted.</Text>
          </VStack>
          <List hasDividers edge="flush">
            {sorted.map((v) => {
              const isActive = v.id === agent.activeVersionId;
              const mark = marks.get(v.id);
              return (
                <ListItem
                  key={v.id}
                  label={
                    <HStack gap={2} vAlign="center" wrap="wrap">
                      <Text weight="semibold">{versionLabel(v)}</Text>
                      {isActive ? <StatusBadge label="Active" tone="info" /> : null}
                      {mark ? <StatusBadge label={`Rolled back from ${fromLabel(mark.fromVersionId)}`} tone="neutral" /> : null}
                    </HStack>
                  }
                  description={
                    <VStack gap={0.5}>
                      <Text type="supporting">{`Published ${formatDateTime(v.publishedAt, timeZone)} by ${v.createdBy}`}</Text>
                      {mark ? (
                        <Text type="supporting">{`Made active again ${formatDateTime(mark.occurredAt, timeZone)}`}</Text>
                      ) : null}
                    </VStack>
                  }
                  endContent={
                    canRollBack(agent, v) ? (
                      <Button label="Roll back to this version" size="sm" onClick={() => setTargetId(v.id)} />
                    ) : undefined
                  }
                />
              );
            })}
          </List>
        </VStack>
      </Card>

      {shownPair ? (
        <VersionCompare
          versions={sorted}
          activeVersionId={agent.activeVersionId}
          leftId={shownPair[0]}
          rightId={shownPair[1]}
          onChange={(l, r) => setPair([l, r])}
          timeZone={timeZone}
        />
      ) : (
        <Card>
          <VStack gap={1}>
            <Heading level={2}>Compare two versions</Heading>
            <Text type="supporting">There is only one version, so there is nothing to compare yet.</Text>
          </VStack>
        </Card>
      )}

      <RollbackDialog
        isOpen={target !== null}
        businessId={businessId}
        agent={agent}
        target={target}
        active={active}
        onClose={() => setTargetId(null)}
        onRolledBack={onRolledBack}
        onReload={reload}
      />
    </VStack>
  );
}
