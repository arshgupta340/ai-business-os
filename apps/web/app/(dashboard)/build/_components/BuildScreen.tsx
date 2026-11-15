'use client';

import {useEffect} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Grid} from '@astryxdesign/core/Grid';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {EmptyState} from '@/components/EmptyState';
import {ErrorState} from '@/components/ErrorState';
import {LoadingState} from '@/components/LoadingState';
import {PageHeader} from '@/components/PageHeader';
import {isMockMode} from '@/lib/api';
import {errorText} from '@/lib/error-text';
import {useBusiness} from '@/lib/session';
import {BuilderThreadContext, useBuilderThread} from '../_hooks/useBuilderThread';
import {useBuilderSessionId} from '../_hooks/useBuilderSessionId';
import {forgetSession} from '../_lib/memory';
import {BuilderChat} from './BuilderChat';
import {SpecPanel} from './SpecPanel';

export function BuildScreen() {
  const {business, businessId} = useBusiness();
  const {sessionId, startNew, isCreating, createError} = useBuilderSessionId(businessId);
  const thread = useBuilderThread(businessId, sessionId);
  const timeZone = business?.timezone ?? 'UTC';
  const notFound = thread.loadError?.code === 'NOT_FOUND';

  // A session the server does not know is not resumed again.
  useEffect(() => {
    if (notFound && sessionId) forgetSession(sessionId);
  }, [notFound, sessionId]);

  let body;
  if (!businessId) {
    body = <EmptyState title="Choose a business" description="Choose a business in the top bar to build an agent for it." />;
  } else if (!sessionId && createError) {
    body = (
      <ErrorState
        title="The builder could not start"
        message={errorText(createError)}
        onRetry={createError.retryable ? () => void startNew() : undefined}
      />
    );
  } else if (!sessionId) {
    body = <LoadingState label="Starting a builder session" />;
  } else if (thread.isLoading) {
    body = <LoadingState label="Loading the builder session" />;
  } else if (notFound) {
    body = (
      <EmptyState
        title="This builder session was not found"
        description={
          isMockMode()
            ? 'Mock mode keeps sessions in memory, so a reload clears them. Start a new session to continue.'
            : 'It is not part of this business, or it no longer exists. Start a new session to continue.'
        }
        actions={<Button label="Start a new session" variant="primary" onClick={() => void startNew()} isLoading={isCreating} />}
      />
    );
  } else if (thread.loadError) {
    body = (
      <ErrorState
        title="The builder session did not load"
        message={errorText(thread.loadError)}
        onRetry={thread.loadError.retryable ? () => void thread.reload() : undefined}
      />
    );
  } else {
    body = (
      <Grid columns={{minWidth: 360, max: 2, repeat: 'fit'}} gap={6} align="start">
        <BuilderChat timeZone={timeZone} />
        <SpecPanel businessId={businessId} />
      </Grid>
    );
  }

  return (
    <BuilderThreadContext.Provider value={thread}>
      <VStack gap={6}>
        <PageHeader
          title="Build an Agent"
          description={
            business
              ? `Describe the job and answer a few questions. The draft for ${business.name} builds up on the right.`
              : 'Describe the job and answer a few questions.'
          }
          actions={
            <Button
              label="Start over"
              onClick={() => void startNew()}
              isLoading={isCreating && !!sessionId}
              isDisabled={!businessId || thread.isSending}
              tooltip="Starts a new session. The current one stays as it is."
            />
          }
        />
        {isMockMode() ? (
          <Banner
            status="info"
            title="Mock mode"
            description="The builder replies here are scripted examples. No live model is answering."
            collapsible={false}
          />
        ) : null}
        {body}
        {sessionId && !thread.isLoading && !thread.loadError ? (
          <Text type="supporting">Session {sessionId}</Text>
        ) : null}
      </VStack>
    </BuilderThreadContext.Provider>
  );
}
