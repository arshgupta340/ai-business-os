'use client';

import {Card} from '@astryxdesign/core/Card';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {Link} from '@astryxdesign/core/Link';
import {List, ListItem} from '@astryxdesign/core/List';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {LoadingState} from '@/components/LoadingState';
import {SandboxBadge} from '@/components/SandboxBadge';
import {StatusBadge} from '@/components/StatusBadge';
import {HEALTH_PROVIDERS, summarizeHealth} from '@/components/shell/ConnectionHealth';
import {useIntegrationsHealth, type IntegrationHealthEntry, type IntegrationProvider} from '@/lib/api';
import {formatRelative} from '@/lib/format';
import {messageChannelLabel, providerLabel} from '@/lib/labels';
import {statusView} from '@/lib/status';
import {BlockError} from './BlockError';

/** The active channel, named as on the Integrations screen. QR only says that no message is sent. */
export function healthChannelText(channel: unknown): string {
  return channel === 'qr_only' ? 'QR code only, no message is sent' : messageChannelLabel(channel);
}

function describeEntry(provider: IntegrationProvider, entry: IntegrationHealthEntry, timeZone: string): string {
  const parts: string[] = [];
  // A server note may end with its own period; the parts are joined with one.
  if (entry.detail) parts.push(entry.detail.replace(/\.+$/, ''));
  if (provider === 'message_channel' && entry.channel) parts.push(healthChannelText(entry.channel));
  parts.push(`Checked ${formatRelative(entry.lastCheckedAt, timeZone)}`);
  return parts.join('. ');
}

export function HealthSection({businessId, timeZone}: {businessId: string; timeZone: string}) {
  const health = useIntegrationsHealth(businessId);

  let body;
  if (health.isPending) {
    body = <LoadingState label="Checking integrations" />;
  } else if (!health.data) {
    // No data at all: the first load failed. A failed refetch keeps the old data and the page header says so.
    body = (
      <BlockError title="Could not load integration health" error={health.error} onRetry={() => void health.refetch()} />
    );
  } else {
    const summary = summarizeHealth(health.data);
    body = (
      <VStack gap={2}>
        <Text type="supporting">{summary.detail}</Text>
        <List hasDividers edge="bleed" density="compact">
          {HEALTH_PROVIDERS.map((provider) => {
            const entry = health.data[provider];
            if (!entry) return null;
            const view = statusView('integration', entry.state);
            return (
              <ListItem
                key={provider}
                label={providerLabel(provider)}
                description={describeEntry(provider, entry, timeZone)}
                endContent={
                  <HStack gap={2} vAlign="center">
                    {/* Square always runs in sandbox; label it even when environment is missing. */}
                    {provider === 'square' ? <SandboxBadge /> : null}
                    <StatusBadge label={view.label} tone={view.tone} />
                  </HStack>
                }
              />
            );
          })}
        </List>
      </VStack>
    );
  }

  return (
    <Card>
      <VStack gap={3}>
        <HStack gap={2} justify="between" vAlign="center">
          <Heading level={2}>Integrations</Heading>
          <Link href="/integrations" isStandalone>
            Manage integrations
          </Link>
        </HStack>
        {body}
      </VStack>
    </Card>
  );
}
