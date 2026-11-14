'use client';

/**
 * Side-by-side comparison of two immutable versions. Read only: nothing here
 * edits a version. Every value is rendered as plain text.
 */

import {Card} from '@astryxdesign/core/Card';
import {Divider} from '@astryxdesign/core/Divider';
import {Grid} from '@astryxdesign/core/Grid';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {List, ListItem} from '@astryxdesign/core/List';
import {Selector} from '@astryxdesign/core/Selector';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {StatusBadge} from '@/components/StatusBadge';
import type {AgentVersion} from '@/lib/api';
import {formatDateTime} from '@/lib/format';
import {diffVersions, versionLabel, type CapabilityChange, type FieldDiff, type SnapshotDiff} from '../_lib/versions';

export type VersionCompareProps = {
  versions: AgentVersion[];
  activeVersionId?: string;
  leftId: string;
  rightId: string;
  onChange: (leftId: string, rightId: string) => void;
  timeZone: string;
};

const CHANGE_VIEW: Record<CapabilityChange, {label: string; tone: 'neutral' | 'info' | 'warning'}> = {
  added: {label: 'Added', tone: 'info'},
  removed: {label: 'Removed', tone: 'warning'},
  unchanged: {label: 'Same', tone: 'neutral'},
};

export function VersionCompare({versions, activeVersionId, leftId, rightId, onChange, timeZone}: VersionCompareProps) {
  const options = versions.map((v) => ({
    value: v.id,
    label: `${versionLabel(v)}${v.id === activeVersionId ? ' (active)' : ''}`,
  }));
  const left = versions.find((v) => v.id === leftId);
  const right = versions.find((v) => v.id === rightId);

  return (
    <Card>
      <VStack gap={4}>
        <VStack gap={1}>
          <Heading level={2}>Compare two versions</Heading>
          <Text type="supporting">The older version is always on the left. A field that did not change is shown once.</Text>
        </VStack>
        <Grid columns={{minWidth: 240, repeat: 'fit'}} gap={3}>
          <Selector label="First version" options={options} value={leftId} onChange={(v) => onChange(v, rightId)} />
          <Selector label="Second version" options={options} value={rightId} onChange={(v) => onChange(leftId, v)} />
        </Grid>
        {!left || !right ? (
          <Text type="supporting">Pick two versions to compare.</Text>
        ) : left.id === right.id ? (
          <Text type="supporting">Pick two different versions to see what changed.</Text>
        ) : (
          <DiffView a={left} b={right} timeZone={timeZone} />
        )}
      </VStack>
    </Card>
  );
}

function DiffView({a, b, timeZone}: {a: AgentVersion; b: AgentVersion; timeZone: string}) {
  const diff = diffVersions(a, b);
  const before = versionLabel(diff.before);
  const after = versionLabel(diff.after);
  const summary =
    diff.changeCount === 0
      ? `No changes in the agent setup between ${before} and ${after}.`
      : diff.changeCount === 1
        ? `One part changed from ${before} to ${after}.`
        : `${diff.changeCount} parts changed from ${before} to ${after}.`;

  return (
    <VStack gap={4}>
      <Text weight="semibold">{summary}</Text>

      <VStack gap={3}>
        {diff.fields.map((field) => (
          <FieldRow key={field.key} field={field} before={before} after={after} />
        ))}
      </VStack>

      <Divider />

      <VStack gap={3}>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Heading level={3}>Capabilities</Heading>
          {diff.capabilities.added + diff.capabilities.removed === 0 ? (
            <Text type="supporting">Same in both</Text>
          ) : (
            <Text type="supporting">{`${diff.capabilities.added} added, ${diff.capabilities.removed} removed in ${after}`}</Text>
          )}
        </HStack>
        {diff.capabilities.groups.map((group) => (
          <VStack key={group.key} gap={1}>
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Text type="label" weight="semibold">
                {group.title}
              </Text>
              <StatusBadge label={group.badge} tone={group.tone} />
            </HStack>
            <List density="compact" edge="flush">
              {group.items.map((item) => (
                <ListItem
                  key={item.id}
                  label={
                    <Text type="body" color={item.change === 'unchanged' ? 'secondary' : 'primary'}>
                      {item.description}
                    </Text>
                  }
                  description={<Text type="code">{item.id}</Text>}
                  endContent={
                    item.change === 'unchanged' ? (
                      <Text type="supporting">Same</Text>
                    ) : (
                      <StatusBadge label={CHANGE_VIEW[item.change].label} tone={CHANGE_VIEW[item.change].tone} />
                    )
                  }
                />
              ))}
            </List>
          </VStack>
        ))}
        {diff.capabilities.unknownCount > 0 ? (
          <Text type="supporting">
            {diff.capabilities.unknownCount === 1
              ? 'One capability is not in the registry. It is left out.'
              : `${diff.capabilities.unknownCount} capabilities are not in the registry. They are left out.`}
          </Text>
        ) : null}
      </VStack>

      <Divider />

      <SnapshotView snapshot={diff.snapshot} before={before} after={after} timeZone={timeZone} />
    </VStack>
  );
}

function FieldRow({field, before, after}: {field: FieldDiff; before: string; after: string}) {
  if (!field.changed) {
    return (
      <VStack gap={0.5}>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Text type="label" color="secondary">
            {field.label}
          </Text>
          <Text type="supporting">Same in both</Text>
        </HStack>
        <Text type="supporting">{field.after}</Text>
      </VStack>
    );
  }
  return (
    <VStack gap={1}>
      <HStack gap={2} vAlign="center" wrap="wrap">
        <Text type="label" weight="semibold">
          {field.label}
        </Text>
        <StatusBadge label="Changed" tone="info" />
      </HStack>
      <Grid columns={{minWidth: 240, repeat: 'fit'}} gap={2}>
        <Card variant="muted" padding={3}>
          <VStack gap={0.5}>
            <Text type="label" color="secondary">
              {before}
            </Text>
            <Text>{field.before}</Text>
          </VStack>
        </Card>
        <Card variant="muted" padding={3}>
          <VStack gap={0.5}>
            <Text type="label" color="secondary">
              {after}
            </Text>
            <Text>{field.after}</Text>
          </VStack>
        </Card>
      </Grid>
    </VStack>
  );
}

const FACT_CHANGE: Record<'added' | 'removed' | 'changed', string> = {
  added: 'Added',
  removed: 'Removed',
  changed: 'New fact version',
};

function SnapshotView({snapshot, before, after, timeZone}: {snapshot: SnapshotDiff; before: string; after: string; timeZone: string}) {
  const changedFacts = snapshot.facts.filter((f) => f.change !== 'unchanged');
  const time = (iso?: string) => (iso ? formatDateTime(iso, timeZone) : 'Not recorded');
  return (
    <VStack gap={2}>
      <Heading level={3}>Knowledge snapshot</Heading>
      <Text type="supporting">The facts and catalog sync each version was published with.</Text>
      {snapshot.catalogChanged ? (
        <Grid columns={{minWidth: 240, repeat: 'fit'}} gap={2}>
          <Card variant="muted" padding={3}>
            <VStack gap={0.5}>
              <Text type="label" color="secondary">{`${before}, catalog synced`}</Text>
              <Text>{time(snapshot.catalogBefore)}</Text>
            </VStack>
          </Card>
          <Card variant="muted" padding={3}>
            <VStack gap={0.5}>
              <Text type="label" color="secondary">{`${after}, catalog synced`}</Text>
              <Text>{time(snapshot.catalogAfter)}</Text>
            </VStack>
          </Card>
        </Grid>
      ) : (
        <Text type="supporting">{`Catalog synced: ${time(snapshot.catalogAfter)}, same in both`}</Text>
      )}
      {changedFacts.length === 0 ? (
        <Text type="supporting">
          {snapshot.facts.length === 0
            ? 'No facts are recorded in either snapshot.'
            : `${snapshot.facts.length === 1 ? 'One fact' : `${snapshot.facts.length} facts`}, same versions in both.`}
        </Text>
      ) : (
        <List density="compact" edge="flush">
          {changedFacts.map((fact) => (
            <ListItem
              key={fact.id}
              label={<Text type="code">{fact.id}</Text>}
              description={
                <Text type="supporting">
                  {`${before}: ${fact.before !== undefined ? `fact version ${fact.before}` : 'not included'}. ${after}: ${
                    fact.after !== undefined ? `fact version ${fact.after}` : 'not included'
                  }.`}
                </Text>
              }
              endContent={<StatusBadge label={FACT_CHANGE[fact.change as 'added' | 'removed' | 'changed']} tone="neutral" />}
            />
          ))}
        </List>
      )}
    </VStack>
  );
}
