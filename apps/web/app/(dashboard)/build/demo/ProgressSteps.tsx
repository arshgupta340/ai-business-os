'use client';

import {Card} from '@astryxdesign/core/Card';
import {Icon} from '@astryxdesign/core/Icon';
import {List, ListItem} from '@astryxdesign/core/List';
import {Spinner} from '@astryxdesign/core/Spinner';
import {Text} from '@astryxdesign/core/Text';
import {DEMO_STEPS} from './demo-steps';
import type {StepStatus} from './demo-machine';

function StepIcon({status}: {status: StepStatus}) {
  switch (status) {
    case 'running':
      return <Spinner size="xl" aria-label="Running" />;
    case 'done':
      // Not green: nothing here is a state a provider confirmed.
      return <Icon icon="check" color="accent" size="lg" label="Done" />;
    case 'pending':
      return <Icon icon="clock" color="disabled" size="lg" label="Not started" />;
  }
}

const STATUS_TEXT: Record<StepStatus, string> = {pending: 'Next', running: 'Working', done: 'Done'};

export function ProgressSteps({steps}: {steps: readonly StepStatus[]}) {
  return (
    <Card>
      <List hasDividers>
        {DEMO_STEPS.map((def, i) => {
          const status = steps[i] ?? 'pending';
          return (
            <ListItem
              key={def.id}
              startContent={<StepIcon status={status} />}
              label={
                <Text type="display-3" weight={status === 'running' ? 'semibold' : 'normal'} color={status === 'pending' ? 'disabled' : 'primary'}>
                  {def.label}
                </Text>
              }
              endContent={
                <Text type="large" color={status === 'pending' ? 'disabled' : 'secondary'}>
                  {STATUS_TEXT[status]}
                </Text>
              }
            />
          );
        })}
      </List>
    </Card>
  );
}
