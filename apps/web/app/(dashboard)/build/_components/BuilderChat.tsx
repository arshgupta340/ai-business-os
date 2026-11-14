'use client';

// Adapted from the Astryx "ai-chat" page template and the "ChatLayoutPanelChat"
// block: ChatLayout in a fixed-height container, ChatMessageList for turns and
// ChatComposer docked at the bottom. Heroicons, Markdown and the artifact panel
// were removed. Every message renders as plain text: owner text and builder
// text are data, never markup.

import {useState} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {
  ChatComposer,
  ChatLayout,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatMessageMetadata,
} from '@astryxdesign/core/Chat';
import {HStack} from '@astryxdesign/core/HStack';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import type {BuilderMessage} from '@/lib/api';
import {formatTime} from '@/lib/format';
import {useBuilderThreadContext, type PendingTurn} from '../_hooks/useBuilderThread';
import {builderSendErrorView, EXAMPLE_PROMPTS} from '../_lib/spec';
import {VoiceControl} from '../voice/VoiceControl';

function MessageTime({iso, timeZone}: {iso: string; timeZone: string}) {
  let label = '';
  try {
    label = formatTime(iso, timeZone);
  } catch {
    label = '';
  }
  return label ? <>{label}</> : null;
}

function Turn({message, timeZone}: {message: BuilderMessage; timeZone: string}) {
  const isOwner = message.role === 'owner';
  return (
    <ChatMessage sender={isOwner ? 'user' : 'assistant'} name={isOwner ? 'You' : 'Builder'}>
      <ChatMessageBubble
        metadata={
          <ChatMessageMetadata
            timestamp={<MessageTime iso={message.createdAt} timeZone={timeZone} />}
            footer={
              message.inputMode === 'voice' ? (
                <Text type="supporting">Spoken</Text>
              ) : !isOwner && message.evidenceRefs?.length ? (
                <Button label="See the facts this used" href="/knowledge" variant="ghost" size="sm" />
              ) : undefined
            }
          />
        }>
        {message.text}
      </ChatMessageBubble>
    </ChatMessage>
  );
}

function PendingOwnerTurn({pending, onRetry, onEdit}: {pending: PendingTurn; onRetry: () => void; onEdit: () => void}) {
  const failed = pending.status === 'failed' ? pending : null;
  const view = failed ? builderSendErrorView(failed.error) : null;
  return (
    <ChatMessage sender="user" name="You">
      <ChatMessageBubble metadata={<ChatMessageMetadata status={failed ? 'error' : 'sending'} />}>{pending.text}</ChatMessageBubble>
      {failed && view ? (
        <ChatMessageBubble variant="ghost" width="100%">
          <Banner
            status={view.tone}
            title={view.title}
            description={view.description}
            endContent={
              <HStack gap={2} wrap="wrap">
                {view.canRetry ? <Button label="Try again" variant="primary" size="sm" onClick={onRetry} /> : null}
                <Button label="Edit message" size="sm" onClick={onEdit} />
              </HStack>
            }>
            {failed.error.correlationId ? <Text type="supporting">Reference: {failed.error.correlationId}</Text> : null}
          </Banner>
        </ChatMessageBubble>
      ) : null}
    </ChatMessage>
  );
}

function PromptButtons({title, prompts, onPick, isDisabled}: {title: string; prompts: readonly string[]; onPick: (text: string) => void; isDisabled: boolean}) {
  if (prompts.length === 0) return null;
  return (
    <ChatMessage sender="assistant" name={null}>
      <ChatMessageBubble variant="ghost" width="100%">
        <VStack gap={2}>
          <Text type="supporting">{title}</Text>
          <HStack gap={2} wrap="wrap">
            {prompts.map((prompt) => (
              <Button key={prompt} label={prompt} size="sm" onClick={() => onPick(prompt)} isDisabled={isDisabled} />
            ))}
          </HStack>
        </VStack>
      </ChatMessageBubble>
    </ChatMessage>
  );
}

export function BuilderChat({timeZone}: {timeZone: string}) {
  const thread = useBuilderThreadContext();
  const [draft, setDraft] = useState('');
  const {messages, pending, isSending, hasOwnerTurn, notes} = thread;
  const isBlockedByFailure = pending?.status === 'failed';

  const submit = (text: string) => {
    if (!text.trim() || isSending) return;
    // The text moves into the pending bubble. A failed send keeps it there with a retry.
    setDraft('');
    void thread.send(text, 'text');
  };

  const showExamples = !hasOwnerTurn && !pending;
  const showSuggestions = hasOwnerTurn && !pending && notes.suggestions.length > 0;

  return (
    <Card padding={0} height="min(720px, 75dvh)" minHeight={480} style={{overflow: 'hidden', display: 'flex', flexDirection: 'column'}}>
      <ChatLayout
        density="compact"
        style={{flex: 1, minHeight: 0}}
        composer={
          <ChatComposer
            value={draft}
            onChange={setDraft}
            onSubmit={submit}
            isDisabled={isSending || isBlockedByFailure || !thread.session}
            placeholder={isSending ? 'Waiting for the builder' : 'Describe what the agent should do'}
            sendActions={<VoiceControl />}
          />
        }>
        <ChatMessageList>
          {messages.map((message) => (
            <Turn key={message.id} message={message} timeZone={timeZone} />
          ))}
          {showExamples ? <PromptButtons title="Try one of these" prompts={EXAMPLE_PROMPTS} onPick={submit} isDisabled={isSending} /> : null}
          {pending ? (
            <PendingOwnerTurn
              pending={pending}
              onRetry={() => void thread.retry()}
              onEdit={() => setDraft(thread.takeFailedText())}
            />
          ) : null}
          {showSuggestions ? <PromptButtons title="Quick answers" prompts={notes.suggestions} onPick={submit} isDisabled={isSending} /> : null}
        </ChatMessageList>
      </ChatLayout>
    </Card>
  );
}
