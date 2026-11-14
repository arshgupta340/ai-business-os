'use client';

import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {SandboxBadge} from '@/components/SandboxBadge';
import {StatusBadge} from '@/components/StatusBadge';
import {formatDuration, type MetricView, type Percentile} from '../_lib/telemetry';

const PERCENTILE_LABEL: Record<Percentile, string> = {p50: 'Median (p50)', p95: 'p95'};

function Bar({view, percentile}: {view: MetricView; percentile: Percentile}) {
  const value = percentile === 'p50' ? view.p50Ms : view.p95Ms;
  const goal = view.goal && view.goal.percentile === percentile ? view.goal : undefined;
  return (
    <ProgressBar
      label={`${view.label}, ${PERCENTILE_LABEL[percentile]}`}
      value={value}
      max={view.scaleMaxMs}
      hasValueLabel
      formatValueLabel={(v) => `${PERCENTILE_LABEL[percentile]}: ${formatDuration(v)}`}
      isLabelHidden
      variant="accent"
      marks={goal ? [{value: goal.maxMs, label: `Goal ${formatDuration(goal.maxMs)}`}] : undefined}
    />
  );
}

/** One metric: name, what it measures, p50 and p95 as text and as bars, sample count and the PRD goal where one exists. */
export function MetricRow({view}: {view: MetricView}) {
  const check = view.goalCheck;
  return (
    <VStack gap={2}>
      <HStack gap={2} vAlign="center" wrap="wrap">
        <Heading level={3}>{view.label}</Heading>
        {view.name === 'webhook_delay' ? <SandboxBadge /> : null}
        {check ? (
          <StatusBadge
            label={check.isWithin ? `${check.percentile} within goal` : `${check.percentile} over goal`}
            tone={check.isWithin ? 'neutral' : 'warning'}
          />
        ) : null}
      </HStack>
      {view.description ? (
        <Text type="supporting">{view.description}</Text>
      ) : (
        <Text type="supporting">This screen does not have a description for this metric yet.</Text>
      )}

      {view.hasData ? (
        <VStack gap={2}>
          <Bar view={view} percentile="p50" />
          <Bar view={view} percentile="p95" />
          <Text type="body">{view.lowSampleNote ? `${view.countText} ${view.lowSampleNote}` : view.countText}</Text>
        </VStack>
      ) : (
        <Text type="body">No data yet. Nothing was measured in this window.</Text>
      )}

      {view.goal ? (
        <Text type="supporting">
          PRD goal: {view.goal.text} {view.goal.basis}
          {check
            ? ` Measured ${check.percentile} is ${formatDuration(check.measuredMs)}, ${
                check.isWithin ? 'within' : 'over'
              } the ${formatDuration(check.maxMs)} goal.`
            : ''}
        </Text>
      ) : null}
    </VStack>
  );
}
