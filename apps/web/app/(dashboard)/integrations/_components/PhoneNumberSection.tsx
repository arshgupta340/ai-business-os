'use client';

import {Card} from '@astryxdesign/core/Card';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {Link} from '@astryxdesign/core/Link';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {EmptyState} from '@/components/EmptyState';
import {LoadingState} from '@/components/LoadingState';
import {useAgent, useLiveAgent} from '@/lib/api';
import {formatRelative} from '@/lib/format';
import {useBusiness} from '@/lib/session';
import {SectionError} from './SectionError';

/**
 * The one phone number (SPEC P-06) and which agent answers it now. The number
 * is the business line, not a customer's, so it is shown in full.
 */
export function PhoneNumberSection({businessId, timeZone}: {businessId: string; timeZone: string}) {
  const {businesses} = useBusiness();
  const live = useLiveAgent();
  const agentId = live.data?.agentId;
  // The live agent can belong to the other business; read it from its own business.
  const agent = useAgent(live.data?.businessId, agentId);

  let body;
  if (live.isPending) {
    body = <LoadingState label="Loading the phone number" />;
  } else if (live.error) {
    body = <SectionError title="Could not load the phone number" error={live.error} onRetry={() => void live.refetch()} />;
  } else {
    const data = live.data;
    const otherBusiness =
      data.businessId !== businessId
        ? (businesses.find((b) => b.id === data.businessId)?.name ?? 'another business').replace(/\.$/, '')
        : null;
    body = (
      <VStack gap={2}>
        <Text type="large" weight="semibold">
          {data.phoneNumber}
        </Text>
        {agentId ? (
          <VStack gap={1}>
            <Text type="body">
              Answered now by{' '}
              <Link href={`/agents/${agentId}`}>{agent.data?.name ?? (agent.isPending ? 'the live agent' : agentId)}</Link>
              {otherBusiness ? `, an agent of ${otherBusiness}.` : '.'}
            </Text>
            {otherBusiness ? (
              <Text type="supporting">Calls to this number go to {otherBusiness}, not to the business selected above.</Text>
            ) : null}
            {data.updatedAt ? <Text type="supporting">Changed {formatRelative(data.updatedAt, timeZone)}.</Text> : null}
          </VStack>
        ) : (
          <EmptyState
            title="No agent answers this number now"
            description="Callers do not reach an agent. Make a published agent live on the Agents page."
            headingLevel={3}
          />
        )}
      </VStack>
    );
  }

  return (
    <Card>
      <VStack gap={3}>
        <HStack gap={2} justify="between" vAlign="center" wrap="wrap">
          <Heading level={2}>Phone number</Heading>
          <Link href="/agents" isStandalone>
            Choose the live agent
          </Link>
        </HStack>
        {body}
      </VStack>
    </Card>
  );
}
