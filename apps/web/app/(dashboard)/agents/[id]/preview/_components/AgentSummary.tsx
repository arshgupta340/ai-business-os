'use client';

// What the agent is and what it may do. The capability grouping and its
// wording come from the builder's spec panel helpers (build/_lib/spec.ts), so
// both screens describe permissions the same way.

import type {ReactNode} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Card} from '@astryxdesign/core/Card';
import {Code} from '@astryxdesign/core/Code';
import {Divider} from '@astryxdesign/core/Divider';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {List, ListItem} from '@astryxdesign/core/List';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {StatusBadge} from '@/components/StatusBadge';
import type {AgentSpec, PreviewResponse} from '@/lib/api';
import {
  CHANNEL_LABELS,
  ESCALATION_LABELS,
  groupCapabilities,
  SCOPE_LABELS,
  TEMPLATE_LABELS,
  WRITE_POLICY_LABELS,
} from '../../../../build/_lib/spec';

const NOT_SET = 'Not set';

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

export function AgentDetails({spec, phoneLine}: {spec: Partial<AgentSpec>; phoneLine: string}) {
  const scopes = (spec.knowledgeScopes ?? []).map((s) => SCOPE_LABELS[s] ?? s);
  return (
    <Card>
      <VStack gap={3}>
        <Heading level={2}>The agent</Heading>
        <Detail label="Name">{spec.name || NOT_SET}</Detail>
        <Detail label="Goal">{spec.goal || NOT_SET}</Detail>
        <Detail label="Template">{spec.template ? TEMPLATE_LABELS[spec.template] : NOT_SET}</Detail>
        <Detail label="Channel">{spec.channel ? `${CHANNEL_LABELS[spec.channel]}. ${phoneLine}` : NOT_SET}</Detail>
        {spec.greeting ? <Detail label="Greeting">{spec.greeting}</Detail> : null}
        <Detail label="Knowledge it can use">{scopes.length ? scopes.join(', ') : NOT_SET}</Detail>
        <Detail label="Actions">{spec.writePolicy ? WRITE_POLICY_LABELS[spec.writePolicy] : NOT_SET}</Detail>
        <Detail label="When it cannot help">{spec.escalation ? ESCALATION_LABELS[spec.escalation] : NOT_SET}</Detail>
      </VStack>
    </Card>
  );
}

/**
 * The permission summary. It shows the server's answer from the preview
 * (permissions.readOnly, proposes, approvalRequired) once it is there, and
 * the draft's capability list until then.
 */
export function Permissions({
  draftCapabilities,
  permissions,
}: {
  draftCapabilities: readonly string[] | undefined;
  permissions: PreviewResponse['permissions'] | undefined;
}) {
  const ids = permissions ? [...permissions.readOnly, ...permissions.proposes, ...permissions.approvalRequired] : draftCapabilities;
  const {groups, unknownCount} = groupCapabilities(ids);
  return (
    <Card>
      <VStack gap={4}>
        <VStack gap={1}>
          <Heading level={2}>What the agent can do</Heading>
          <Text type="supporting">
            {permissions
              ? 'From the server check of this draft. The agent itself only reads and proposes.'
              : 'From the draft. The server check is still loading.'}
          </Text>
        </VStack>
        {groups.length === 0 && unknownCount === 0 ? <Text type="supporting">This draft has no capabilities.</Text> : null}
        {groups.map((group, index) => (
          <VStack key={group.key} gap={1}>
            {index > 0 ? <Divider /> : null}
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Text type="label" weight="semibold">
                {group.title}
              </Text>
              <StatusBadge label={group.badge} tone={group.tone} />
            </HStack>
            <Text type="supporting">{group.description}</Text>
            <List density="compact" edge="flush">
              {group.items.map((item) => (
                <ListItem key={item.id} label={<Text type="body">{item.description}</Text>} description={<Code>{item.id}</Code>} />
              ))}
            </List>
          </VStack>
        ))}
        {unknownCount > 0 ? (
          <Banner
            status="error"
            title="The draft names a capability that does not exist"
            description={
              unknownCount === 1
                ? 'One capability is left out. The server refuses to publish it.'
                : `${unknownCount} capabilities are left out. The server refuses to publish them.`
            }
            collapsible={false}
          />
        ) : null}
      </VStack>
    </Card>
  );
}
