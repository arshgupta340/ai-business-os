'use client';

// The illustrative example calls from POST /api/agents/:id/preview. They run
// on mock tools and are examples, never real calls.

import {Card} from '@astryxdesign/core/Card';
import {Divider} from '@astryxdesign/core/Divider';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {List, ListItem} from '@astryxdesign/core/List';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {StatusBadge} from '@/components/StatusBadge';
import type {PreviewResponse} from '@/lib/api';
import {scenarioLabel} from '../_lib/preview';
import {ToolTrace} from './ToolTrace';

export function ExampleCalls({examples}: {examples: PreviewResponse['examples']}) {
  return (
    <Card>
      <VStack gap={4}>
        <VStack gap={1}>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Heading level={2}>Example calls</Heading>
            <StatusBadge label="Example call, mock tools" tone="neutral" />
          </HStack>
          <Text type="supporting">
            Illustrative calls the server ran on mock tools. They are examples, not real calls. Nothing was sent or stored.
          </Text>
        </VStack>
        {examples.length === 0 ? <Text type="supporting">The server returned no example calls for this draft.</Text> : null}
        {examples.map((example, index) => (
          <VStack key={`${example.scenario}-${index}`} gap={2}>
            {index > 0 ? <Divider /> : null}
            <Heading level={3}>{scenarioLabel(example.scenario)}</Heading>
            <List density="compact" edge="flush">
              {example.transcript.map((line, i) => (
                <ListItem
                  key={i}
                  align="start"
                  startContent={
                    <Text type="label" color="secondary">
                      {line.role === 'caller' ? 'Caller' : 'Agent'}
                    </Text>
                  }
                  label={<Text type="body">{line.text}</Text>}
                />
              ))}
            </List>
            <ToolTrace trace={example.toolTrace} mode="test" />
          </VStack>
        ))}
      </VStack>
    </Card>
  );
}
