'use client';

import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {isApiError} from '@/lib/api';
import {useBusiness} from '@/lib/session';
import {ApiErrorBanner} from '../../knowledge/_components/ApiErrorBanner';

/**
 * The error of a call on this screen, with the next step the screen data map
 * gives for its code (rule 9). Retry is offered only when the error allows it.
 * The API client does not pass on Retry-After, so RATE_LIMITED shows the
 * server message and a retry button.
 */
export function RequestError({error, title, onRetry}: {error: unknown; title: string; onRetry?: () => void}) {
  const {businesses, businessId, setBusinessId} = useBusiness();
  if (isApiError(error) && error.code === 'UNAUTHENTICATED') {
    return (
      <Banner
        status="error"
        title={title}
        description="Your sign-in has ended. Sign in again, then try once more."
        endContent={<Button label="Sign in" href="/sign-in" />}
      />
    );
  }
  if (isApiError(error) && error.code === 'FORBIDDEN_BUSINESS') {
    const other = businesses.find((b) => b.id !== businessId);
    return (
      <Banner
        status="error"
        title={title}
        description="You do not have access to this business."
        endContent={other ? <Button label={`Switch to ${other.name}`} onClick={() => setBusinessId(other.id)} /> : undefined}
      />
    );
  }
  return <ApiErrorBanner title={title} error={error} onRetry={onRetry} />;
}
