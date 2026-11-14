'use client';

import {useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {useMockControls} from '@/lib/api';
import type {BusinessFlow} from './overview-logic';

/**
 * Mock mode only. Starts a scripted call so the overview counts can be seen
 * changing live. Every action changes only the in-memory mock data.
 */
export function MockControlsPanel({flow}: {flow: BusinessFlow}) {
  const controls = useMockControls();
  const [note, setNote] = useState<string | null>(null);
  if (!controls) return null;

  return (
    <Card variant="muted">
      <VStack gap={2}>
        <Heading level={2}>Mock controls</Heading>
        <Text type="supporting">These buttons change only the mock data in this browser tab. Nothing is real.</Text>
        <HStack gap={2} wrap="wrap">
          {flow !== 'bookings' ? (
            <Button
              label="Start a mock pizza call"
              clickAction={async () => {
                setNote('Mock pizza call in progress.');
                await controls.startPizzaCall();
                setNote('Mock pizza call proposed an order. It is waiting for your approval.');
              }}
            />
          ) : null}
          {flow !== 'orders' ? (
            <Button
              label="Start a mock booking call"
              clickAction={async () => {
                setNote('Mock booking call in progress.');
                await controls.startBookingCall();
                setNote('Mock booking call proposed a time. It is waiting for your approval.');
              }}
            />
          ) : null}
        </HStack>
        {note ? <Text type="supporting">{note}</Text> : null}
      </VStack>
    </Card>
  );
}
