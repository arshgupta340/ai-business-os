'use client';

import {ClickableCard} from '@astryxdesign/core/ClickableCard';
import {HStack} from '@astryxdesign/core/HStack';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import type {Agent} from '@/lib/api';
import {formatMoney, formatRelative} from '@/lib/format';
import {statusView} from '@/lib/status';
import {SandboxBadge} from '@/components/SandboxBadge';
import {StatusBadge} from '@/components/StatusBadge';
import {callTitle} from './CallDetail';
import type {Journey} from './journey';

/** One card per call: what it is, where it stands, and the total. */
export function CallList({
  journeys,
  selectedId,
  onSelect,
  agents,
  timeZone,
}: {
  journeys: Journey[];
  selectedId: string | null;
  onSelect: (callId: string) => void;
  agents: Agent[] | undefined;
  timeZone: string;
}) {
  return (
    <VStack gap={2}>
      {journeys.map((j) => {
        const selected = j.callId === selectedId;
        const step = j.steps[Math.min(j.activeStep, j.steps.length - 1)];
        return (
          <ClickableCard
            key={j.callId}
            label={`${callTitle(j, agents)}, ${j.headline.label}`}
            onClick={() => onSelect(j.callId)}
            variant={selected ? 'blue' : 'default'}
            elevation={selected ? 'med' : 'none'}
            padding={4}>
            <VStack gap={2}>
              <HStack justify="between" vAlign="center" gap={2}>
                <Text type="label" maxLines={1}>
                  {callTitle(j, agents)}
                </Text>
                <Text type="supporting">{j.startedAt ? formatRelative(j.startedAt, timeZone) : ''}</Text>
              </HStack>
              <Text type="large">{j.headline.label}</Text>
              <HStack gap={2} vAlign="center" wrap="wrap" justify="between">
                <HStack gap={2} vAlign="center" wrap="wrap">
                  <StatusBadge
                    label={j.activeStep >= j.steps.length ? `All ${j.steps.length} steps done` : `Step ${j.activeStep + 1} of ${j.steps.length}`}
                    tone={step.view?.tone ?? 'neutral'}
                  />
                  {j.approval?.state === 'PENDING' ? <StatusBadge label="Needs you" tone={statusView('approval', 'PENDING').tone} /> : null}
                </HStack>
                {j.order ? (
                  <HStack gap={1} vAlign="center">
                    <Text type="label">{formatMoney(j.order.totalMinor, j.order.currency)}</Text>
                    <SandboxBadge />
                  </HStack>
                ) : j.booking ? (
                  <Text type="label">{j.booking.serviceName}</Text>
                ) : null}
              </HStack>
            </VStack>
          </ClickableCard>
        );
      })}
    </VStack>
  );
}
