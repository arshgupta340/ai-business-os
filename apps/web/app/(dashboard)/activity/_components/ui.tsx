'use client';

import {useEffect, useState, type ReactNode} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Card} from '@astryxdesign/core/Card';
import {Heading} from '@astryxdesign/core/Heading';
import {Step, Stepper} from '@astryxdesign/core/Stepper';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {isApiError} from '@/lib/api';
import type {Tone} from '@/lib/status';
import {ErrorState} from '@/components/ErrorState';
import type {Journey, Notice} from './journey';

/**
 * Component variants for a tone that statusView already chose. These only
 * translate a tone into each component's prop name, like StatusBadge does.
 */
const STEP_STATUS = {success: 'success', warning: 'warning', danger: 'error', info: 'accent', neutral: undefined} as const;
const BANNER_STATUS = {success: 'success', warning: 'warning', danger: 'error', info: 'info', neutral: 'info'} as const;

export function bannerStatus(tone: Tone) {
  return BANNER_STATUS[tone];
}

/** Current time, ticking once a second. For countdowns. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** The five step indicator for one call. Only a tone of success shows green. */
export function JourneyStepper({journey, density = 'balanced'}: {journey: Journey; density?: 'compact' | 'balanced' | 'spacious'}) {
  return (
    <Stepper
      activeStep={Math.min(journey.activeStep, journey.steps.length)}
      label="Progress of this call"
      density={density}
      horizontalOptions={{minimumStepWidth: 96, collapsedVariant: 'withLabel'}}>
      {journey.steps.map((step, i) => {
        const failed = step.view?.tone === 'danger';
        return (
          <Step
            key={step.key}
            step={i}
            label={step.label}
            description={step.view ? step.view.label : 'Not reached'}
            status={step.view ? STEP_STATUS[step.view.tone] : undefined}
            indicator={failed ? 'number' : 'auto'}
          />
        );
      })}
    </Stepper>
  );
}

/** One notice: a Banner for info, warning and danger; a muted card for neutral (closed, nothing charged). */
export function NoticeView({notice}: {notice: Notice}) {
  if (notice.tone === 'neutral') {
    return (
      <Card variant="muted">
        <VStack gap={1}>
          <Heading level={4}>{notice.title}</Heading>
          <Text type="body">{notice.description}</Text>
        </VStack>
      </Card>
    );
  }
  return <Banner status={bannerStatus(notice.tone)} title={notice.title} description={notice.description} collapsible={false} />;
}

/** A titled block inside the call detail. */
export function Panel({title, actions, children}: {title: string; actions?: ReactNode; children: ReactNode}) {
  return (
    <Card>
      <VStack gap={3}>
        {actions ? (
          <VStack gap={2}>
            <Heading level={3}>{title}</Heading>
            {actions}
          </VStack>
        ) : (
          <Heading level={3}>{title}</Heading>
        )}
        {children}
      </VStack>
    </Card>
  );
}

/** ApiError message with its correlation ID, and a retry only when the error says it is retryable. */
export function QueryError({error, onRetry, title}: {error: unknown; onRetry?: () => void; title?: string}) {
  const api = isApiError(error) ? error : null;
  const message = api ? api.message : 'Could not load this data.';
  const withId = api?.correlationId ? `${message} Reference: ${api.correlationId}` : message;
  return <ErrorState title={title} message={withId} onRetry={api && !api.retryable ? undefined : onRetry} />;
}
