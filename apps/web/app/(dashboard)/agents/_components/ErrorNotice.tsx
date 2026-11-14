'use client';

import {useEffect} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Text} from '@astryxdesign/core/Text';
import {useBusiness} from '@/lib/session';
import {errorView, type ErrorContext} from '../_lib/agents-view';

/**
 * One error from an agents call. Shows the safe message, keeps the reference
 * ID behind the banner toggle, offers retry only when the error is retryable,
 * and handles UNAUTHENTICATED and FORBIDDEN_BUSINESS (data map rule 9).
 */
export function ErrorNotice({
  error,
  context,
  onRetry,
  title,
}: {
  error: unknown;
  context: ErrorContext;
  onRetry?: () => void;
  /** Names what did not load, for example "Could not load your agents". Replaces the generic title only. */
  title?: string;
}) {
  const base = errorView(error, context);
  const view = title && base.title === errorView(null, context).title ? {...base, title} : base;
  const {businesses, businessId, setBusinessId} = useBusiness();
  const first = businesses[0]?.id;

  // FORBIDDEN_BUSINESS: put the selector back on the first owned business.
  useEffect(() => {
    if (view.forbidden && first && first !== businessId) setBusinessId(first);
  }, [view.forbidden, first, businessId, setBusinessId]);

  let action;
  if (view.needsSignIn) action = <Button label="Sign in" href="/sign-in" />;
  else if (view.canRetry && onRetry) action = <Button label="Try again" onClick={() => onRetry()} />;

  return (
    <Banner status="error" title={view.title} description={view.message} endContent={action}>
      {view.correlationId ? <Text type="supporting">{`Reference ID: ${view.correlationId}`}</Text> : null}
    </Banner>
  );
}
