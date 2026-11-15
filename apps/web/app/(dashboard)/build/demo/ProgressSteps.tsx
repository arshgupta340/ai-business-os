'use client';

import {Card} from '@astryxdesign/core/Card';
import {Check} from 'lucide-react';
import {DEMO_STEPS, type DemoStepDefinition} from './demo-steps';
import type {StepStatus} from './demo-machine';

const STATUS_TEXT: Record<StepStatus, string> = {pending: 'Next', running: 'Working', done: 'Done'};
const ICON_LABEL: Record<StepStatus, string> = {pending: 'Not started', running: 'Running', done: 'Done'};

/** The length of the progress ring's circle (radius 10), for its dash offset. */
const RING_LENGTH = 62.83;

/**
 * The build steps: a ring and a count for the whole run, then one row per
 * step. Styles are `.abos-step*` in app/globals.css.
 *
 * A finished step is blue, not green: nothing here is a state a provider confirmed.
 */
export function ProgressSteps({steps, definitions = DEMO_STEPS}: {steps: readonly StepStatus[]; definitions?: readonly DemoStepDefinition[]}) {
  const done = definitions.filter((_, i) => steps[i] === 'done').length;
  const share = definitions.length ? done / definitions.length : 0;
  return (
    <Card>
      <div className="abos-steps-head">
        <svg className="abos-ring" viewBox="0 0 26 26" aria-hidden>
          <circle className="abos-ring-track" cx="13" cy="13" r="10" />
          <circle className="abos-ring-fill" cx="13" cy="13" r="10" style={{strokeDashoffset: RING_LENGTH * (1 - share)}} />
        </svg>
        <span className="abos-steps-title">Building the agent</span>
        <span className="abos-steps-count">{`${done} of ${definitions.length}`}</span>
      </div>
      <ol className="abos-steps">
        {definitions.map((def, i) => {
          const status = steps[i] ?? 'pending';
          return (
            <li key={def.id} className="abos-step" data-status={status}>
              <span className="abos-step-icon" role="img" aria-label={ICON_LABEL[status]}>
                {status === 'done' ? <Check strokeWidth={3} aria-hidden /> : null}
              </span>
              <span>{def.label}</span>
              <span className="abos-step-status">{STATUS_TEXT[status]}</span>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
