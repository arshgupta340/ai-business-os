'use client';

// The tool trace of one agent turn: tool, capability, effect, what it was
// asked and what it returned. Mock rows say "mock" in the neutral tone. A mock
// approval is labelled as such and never links to the Approvals inbox.

import {Button} from '@astryxdesign/core/Button';
import {Code} from '@astryxdesign/core/Code';
import {CodeBlock} from '@astryxdesign/core/CodeBlock';
import {Collapsible} from '@astryxdesign/core/Collapsible';
import {HStack} from '@astryxdesign/core/HStack';
import {List, ListItem} from '@astryxdesign/core/List';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {SandboxBadge} from '@/components/SandboxBadge';
import {StatusBadge} from '@/components/StatusBadge';
import {
  approvalHref,
  EFFECT_LABELS,
  isMockApproval,
  prettyJson,
  summarizeInput,
  summarizeOutput,
  toolLabel,
  type ConsoleMode,
  type TraceEntry,
} from '../_lib/preview';

function TraceRow({entry, mode}: {entry: TraceEntry; mode: ConsoleMode}) {
  const result = summarizeOutput(entry.output);
  const link = approvalHref(mode, entry, result.approvalId);
  const mockApproval = result.approvalId && (entry.mocked || isMockApproval(result.approvalId) || mode === 'test');
  return (
    <ListItem
      align="start"
      label={
        <VStack gap={1}>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Text type="label" weight="semibold">
              {toolLabel(entry.tool)}
            </Text>
            <StatusBadge label={EFFECT_LABELS[entry.effect] ?? entry.effect} tone={entry.effect === 'propose' ? 'info' : 'neutral'} />
            {entry.mocked ? <StatusBadge label="Mock" tone="neutral" /> : <StatusBadge label="Real tool" tone="info" />}
          </HStack>
          <Text type="supporting">
            <Code>{entry.tool}</Code> uses <Code>{entry.capabilityId}</Code>
          </Text>
        </VStack>
      }
      description={
        <VStack gap={1}>
          <Text type="supporting">Asked: {summarizeInput(entry.input)}</Text>
          <Text type="supporting">Result: {result.ok === false ? result.text : result.text || 'Done'}</Text>
          {result.total ? (
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Text type="supporting">Total with tax: {result.total}</Text>
              <SandboxBadge />
            </HStack>
          ) : null}
          {result.proposalId ? (
            <Text type="supporting">
              Proposal <Code>{result.proposalId}</Code>
            </Text>
          ) : null}
          {result.approvalId && mockApproval ? (
            <VStack gap={1}>
              <HStack gap={2} vAlign="center" wrap="wrap">
                <Text type="supporting">
                  Mock approval <Code>{result.approvalId}</Code>
                </Text>
                <StatusBadge label="Mock approval" tone="neutral" />
              </HStack>
              <Text type="supporting">This approval is not stored. It does not appear in your Approvals inbox.</Text>
            </VStack>
          ) : null}
          {result.approvalId && link ? (
            <VStack gap={1}>
              <HStack gap={2} vAlign="center" wrap="wrap">
                <Text type="supporting">
                  Approval request <Code>{result.approvalId}</Code>
                </Text>
                <Button label="Review in Approvals" size="sm" variant="primary" href={link} />
              </HStack>
              <Text type="supporting">Nothing is written until you approve it.</Text>
            </VStack>
          ) : null}
          <Collapsible defaultIsOpen={false} trigger={<Text type="supporting">Show the raw input and result</Text>}>
            <VStack gap={2}>
              <CodeBlock code={prettyJson(entry.input)} language="json" title="Input" size="sm" width="100%" isWrapped maxHeight={200} />
              <CodeBlock code={prettyJson(entry.output)} language="json" title="Result" size="sm" width="100%" isWrapped maxHeight={240} />
            </VStack>
          </Collapsible>
        </VStack>
      }
      endContent={<Text type="supporting">{Math.round(entry.durationMs)} ms</Text>}
    />
  );
}

export function ToolTrace({trace, mode}: {trace: readonly TraceEntry[]; mode: ConsoleMode}) {
  if (trace.length === 0) {
    return <Text type="supporting">No tool was used in this turn.</Text>;
  }
  return (
    <VStack gap={1}>
      <Text type="label" color="secondary">
        Tool trace
      </Text>
      <List density="compact" edge="flush" hasDividers>
        {trace.map((entry, index) => (
          <TraceRow key={`${entry.tool}-${index}`} entry={entry} mode={mode} />
        ))}
      </List>
    </VStack>
  );
}
