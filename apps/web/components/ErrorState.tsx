'use client';

import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';

export type ErrorStateProps = {
  /** Safe text for the owner, for example ApiError.message. */
  message: string;
  title?: string;
  /** When set, a retry button is shown. */
  onRetry?: () => void;
  retryLabel?: string;
};

/** An error with an actionable retry (docs/PRD.md section 5, UI states). */
export function ErrorState({
  message,
  title = 'Something went wrong',
  onRetry,
  retryLabel = 'Try again',
}: ErrorStateProps) {
  return (
    <Banner
      status="error"
      title={title}
      description={message}
      container="card"
      endContent={onRetry ? <Button label={retryLabel} onClick={() => onRetry()} /> : undefined}
    />
  );
}
