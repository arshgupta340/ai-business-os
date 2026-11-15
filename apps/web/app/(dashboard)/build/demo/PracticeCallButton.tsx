'use client';

import {useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {HStack} from '@astryxdesign/core/HStack';
import {Text} from '@astryxdesign/core/Text';
import {useMockControls} from '@/lib/api';

/**
 * Mock mode only. Starts the scripted pizza call so the finale can be
 * rehearsed without a phone. DemoScreen loads this file only when
 * NEXT_PUBLIC_MOCK=1, so it is not in a real-mode build.
 */
export default function PracticeCallButton() {
  const controls = useMockControls();
  const [note, setNote] = useState<string | null>(null);
  if (!controls) return null;
  const start = async () => {
    setNote('Practice call running in the mock. The order appears here when it ends.');
    try {
      await controls.startPizzaCall();
    } catch {
      setNote('The practice call did not finish. Try again.');
    }
  };
  return (
    <HStack gap={3} vAlign="center" wrap="wrap">
      <Button label="Start a practice call" clickAction={start} />
      <Text type="supporting">{note ?? 'Mock controls: no phone is called.'}</Text>
    </HStack>
  );
}
