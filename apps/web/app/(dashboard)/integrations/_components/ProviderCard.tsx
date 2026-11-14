'use client';

import {Card} from '@astryxdesign/core/Card';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {SandboxBadge} from '@/components/SandboxBadge';
import {StatusBadge} from '@/components/StatusBadge';
import {PROVIDER_LABELS} from '@/components/shell/ConnectionHealth';
import type {IntegrationHealthEntry, IntegrationProvider} from '@/lib/api';
import {formatDateTime, formatRelative} from '@/lib/format';
import {statusView} from '@/lib/status';
import {PROVIDER_PURPOSE, channelText, consequenceFor} from '../_lib/integrations-view';

export function ProviderCard({
  provider,
  entry,
  timeZone,
}: {
  provider: IntegrationProvider;
  entry: IntegrationHealthEntry;
  timeZone: string;
}) {
  // Green only when the stored server check says connected: statusView maps
  // connected to success and nothing else.
  const view = statusView('integration', entry.state);
  const consequence = consequenceFor(provider, entry.state);

  return (
    <Card>
      <VStack gap={2}>
        <HStack gap={2} justify="between" vAlign="center" wrap="wrap">
          <Heading level={3}>
            {PROVIDER_LABELS[provider]}
          </Heading>
          <HStack gap={2} vAlign="center">
            {/* Square always runs in sandbox; the label shows even when environment is missing. */}
            {provider === 'square' ? <SandboxBadge /> : null}
            <StatusBadge label={view.label} tone={view.tone} />
          </HStack>
        </HStack>
        <Text type="body">{PROVIDER_PURPOSE[provider]}</Text>
        {provider === 'square' ? <Text type="body">Sandbox only. No real money moves.</Text> : null}
        {provider === 'message_channel' ? <Text type="body">{channelText(entry.channel)}</Text> : null}
        {entry.detail ? <Text type="supporting">Server note: {entry.detail}</Text> : null}
        {consequence ? (
          <VStack gap={1}>
            <Text type="label">What you will notice</Text>
            <Text type="body">{consequence.notice}</Text>
            <Text type="label">What to do</Text>
            <Text type="body">{consequence.action}</Text>
          </VStack>
        ) : null}
        <Text type="supporting">
          Checked {formatRelative(entry.lastCheckedAt, timeZone)} ({formatDateTime(entry.lastCheckedAt, timeZone)})
        </Text>
      </VStack>
    </Card>
  );
}
