'use client';

import {useEffect, useRef, useState} from 'react';
import {Badge} from '@astryxdesign/core/Badge';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {useMockControls, type MockControls} from '@/lib/api';
import {useBusiness} from '@/lib/session';

const PIZZA = 'biz_pizza_01';
const BARBER = 'biz_barber_01';

type Action = {businessId: string; run: (c: MockControls) => unknown; note: string; startsCall?: boolean};

/**
 * Mock tooling for rehearsals with NEXT_PUBLIC_MOCK=1. Renders nothing
 * outside mock mode. Each action changes only the in-memory mock data.
 */
export function MockControlsPanel({onStarted, onReset}: {onStarted: () => void; onReset: () => void}) {
  const controls = useMockControls();
  const {businessId, setBusinessId} = useBusiness();
  const [pending, setPending] = useState<Action | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const onStartedRef = useRef(onStarted);
  onStartedRef.current = onStarted;

  // Run an action once the business it belongs to is selected, so the feed listens to it.
  useEffect(() => {
    if (!controls || !pending || pending.businessId !== businessId) return;
    const action = pending;
    setPending(null);
    setNote(action.note);
    if (action.startsCall) onStartedRef.current();
    void Promise.resolve(action.run(controls)).catch(() => {
      // A scripted call that was dropped rejects its start promise. The timeline shows it.
    });
  }, [controls, pending, businessId]);

  if (!controls) return null;

  const queue = (action: Action) => {
    if (action.businessId !== businessId) setBusinessId(action.businessId);
    setPending(action);
  };

  return (
    <Card variant="yellow" padding={4}>
      <VStack gap={3}>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Heading level={2}>Mock controls</Heading>
          <Badge label="Mock tooling, not part of the product" variant="warning" />
        </HStack>
        <Text type="body">
          These buttons drive the scripted mock data. Nothing here calls a real phone line, Square or a message channel.
        </Text>
        <HStack gap={2} wrap="wrap">
          <Button
            label="Start pizza call"
            variant="primary"
            onClick={() => queue({businessId: PIZZA, run: (c) => c.startPizzaCall(), startsCall: true, note: 'Mock pizza call started.'})}
          />
          <Button
            label="Start booking call"
            onClick={() => queue({businessId: BARBER, run: (c) => c.startBookingCall(), startsCall: true, note: 'Mock booking call started for Demo Barbershop.'})}
          />
          <Button
            label="Start booking call, slot conflict"
            onClick={() =>
              queue({
                businessId: BARBER,
                run: (c) => c.startBookingCall({slotConflict: true}), startsCall: true,
                note: 'Mock booking call started. The slot will be taken after you approve.',
              })
            }
          />
        </HStack>
        <HStack gap={2} wrap="wrap">
          <Button
            label="Payment fails"
            onClick={() =>
              queue({
                businessId: PIZZA,
                run: (c) => c.simulatePaymentFailed(),
                note: 'The newest order waiting for payment fails now, or the next one does.',
              })
            }
          />
          <Button
            label="Sheets sync retries"
            onClick={() => queue({businessId: PIZZA, run: (c) => c.simulateSyncRetry(), note: 'The next Sheets report fails once, then succeeds.'})}
          />
          <Button
            label="Call is lost"
            onClick={() => queue({businessId: PIZZA, run: (c) => c.simulateCallLost(), startsCall: true, note: 'The call in progress drops, or a new one starts and drops.'})}
          />
          <Button
            label="Rejected webhook"
            onClick={() => queue({businessId: PIZZA, run: (c) => c.simulateRejectedWebhook(), note: 'A Square webhook with a bad signature was rejected.'})}
          />
          <Button
            label="Reset mock data"
            variant="ghost"
            onClick={() => queue({businessId: businessId ?? PIZZA, run: (c) => {
                  c.reset();
                  onReset();
                }, note: 'Mock data reset.'})}
          />
        </HStack>
        {note ? <Text type="supporting">{note}</Text> : null}
      </VStack>
    </Card>
  );
}
