'use client';

// The text console for one agent, in two modes that are never mixed up:
// - "Test with mock tools" (POST /api/agents/:id/test): mock tools only. It
//   can never cause a write, and any approval in it is an apv_mock_ ID that is
//   not stored.
// - "Simulated call" (POST /api/agents/:id/sim-call): the published agent with
//   the real read and propose tools. A proposal creates a real approval
//   request that still waits for the owner.
// Adapted from the same Astryx chat pieces as the builder chat. Every message
// renders as plain text: caller and agent text is data, never markup.

import {useState} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {ChatComposer, ChatLayout, ChatMessage, ChatMessageBubble, ChatMessageList, ChatMessageMetadata} from '@astryxdesign/core/Chat';
import {Code} from '@astryxdesign/core/Code';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {StatusBadge} from '@/components/StatusBadge';
import {isApiError, useAgentConversation, type AgentSpec, type ApiError, type ConversationTurn} from '@/lib/api';
import {errorText} from '@/lib/error-text';
import {guardrailLabel, providerLabel} from '@/lib/labels';
import {activityHref, CONFIRM_REPLY, startersFor, type ConsoleMode, type SimCallGate} from '../_lib/preview';
import {ToolTrace} from './ToolTrace';

const MODE_LABELS: Record<ConsoleMode, string> = {
  test: 'Test with mock tools',
  'sim-call': 'Simulated call',
};

function AgentTurn({turn, mode, agentName}: {turn: ConversationTurn; mode: ConsoleMode; agentName: string}) {
  const guardrail = turn.response?.guardrail;
  return (
    <ChatMessage sender="assistant" name={agentName}>
      {guardrail ? (
        <ChatMessageBubble variant="ghost" width="100%">
          <Banner
            status="warning"
            title="The agent refused this request"
            description={guardrailLabel(guardrail.rule)}
            collapsible={false}
            endContent={<StatusBadge label="Refused" tone="warning" />}>
            <Text type="supporting">
              Rule <Code>{guardrail.rule}</Code>
            </Text>
          </Banner>
        </ChatMessageBubble>
      ) : null}
      <ChatMessageBubble>{turn.text}</ChatMessageBubble>
      <ChatMessageBubble variant="ghost" width="100%">
        <ToolTrace trace={turn.response?.toolTrace ?? []} mode={mode} />
      </ChatMessageBubble>
    </ChatMessage>
  );
}

function OwnerTurn({text, status}: {text: string; status?: 'sending' | 'error'}) {
  return (
    <ChatMessage sender="user" name="You, as the caller">
      <ChatMessageBubble metadata={status ? <ChatMessageMetadata status={status} /> : undefined}>{text}</ChatMessageBubble>
    </ChatMessage>
  );
}

function errorCopy(error: ApiError | Error, mode: ConsoleMode): {title: string; description: string} {
  if (!isApiError(error)) return {title: 'Your message was not sent', description: errorText(error)};
  if (error.code === 'INVALID_STATE' && mode === 'sim-call') {
    return {
      title: 'A simulated call is not possible now',
      description: 'A simulated call needs a published, live agent, and a call that has not ended.',
    };
  }
  if (error.code === 'INTEGRATION_UNAVAILABLE') {
    const provider = typeof error.details?.provider === 'string' ? providerLabel(error.details.provider) : 'A provider';
    return {
      title: 'The agent is not available right now',
      description: `${provider} is not responding.`,
    };
  }
  if (error.code === 'NOT_FOUND') {
    return {
      title: 'This conversation was not found',
      description: 'Start a new one with Reset conversation.',
    };
  }
  return {title: 'Your message was not sent', description: errorText(error)};
}

type Failed = {text: string; error: ApiError | Error; isEnd: boolean};

function Conversation({
  businessId,
  agentId,
  agentName,
  template,
  mode,
}: {
  businessId: string;
  agentId: string;
  agentName: string;
  template: AgentSpec['template'] | undefined;
  mode: ConsoleMode;
}) {
  const convo = useAgentConversation(businessId, agentId, mode);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<Failed | null>(null);
  const [ended, setEnded] = useState(false);
  const isSim = mode === 'sim-call';

  const run = async (text: string, isEnd = false) => {
    if (convo.isPending || pending !== null) return;
    setFailed(null);
    setPending(isEnd ? null : text);
    try {
      if (isEnd) {
        await convo.end();
        setEnded(true);
      } else {
        await convo.send(text);
      }
    } catch (error) {
      setFailed({text, error: error as ApiError, isEnd});
    } finally {
      setPending(null);
    }
  };

  const submit = (text: string) => {
    if (!text.trim() || convo.isPending || ended) return;
    setDraft('');
    void run(text);
  };

  const reset = () => {
    convo.reset();
    setFailed(null);
    setEnded(false);
    setDraft('');
  };

  const busy = convo.isPending || pending !== null;
  // Starters not sent yet, plus a confirmation once the agent has answered.
  const sent = new Set(convo.turns.filter((t) => t.role === 'owner').map((t) => t.text));
  const starters = [...startersFor(template).filter((s) => !sent.has(s)), ...(convo.turns.length > 0 ? [CONFIRM_REPLY] : [])];
  const copy = failed ? errorCopy(failed.error, mode) : null;
  const canRetry = failed && (!isApiError(failed.error) || failed.error.retryable);

  return (
    <VStack gap={3}>
      {isSim ? (
        <Banner
          status="warning"
          title="Simulated call with the real read and propose tools"
          description="This runs the published version. A proposal here creates a real approval request in your Approvals inbox. Nothing is written until you approve it."
          collapsible={false}
        />
      ) : (
        <Banner
          status="info"
          title="Test with mock tools"
          description="Nothing here reaches Square, a customer, the calendar or the sheet. Any approval shown is a mock approval and does not appear in your Approvals inbox."
          collapsible={false}
        />
      )}

      <HStack gap={2} vAlign="center" justify="between" wrap="wrap">
        <HStack gap={2} vAlign="center" wrap="wrap">
          <StatusBadge label={isSim ? 'Simulated call' : 'Test, mock tools'} tone={isSim ? 'info' : 'neutral'} />
          {isSim && convo.sessionId ? (
            <>
              <Text type="supporting">
                Call <Code>{convo.sessionId}</Code>
              </Text>
              {ended ? <StatusBadge label="Call ended" tone="neutral" /> : null}
              <Button label="See this call in Activity" size="sm" variant="ghost" href={activityHref(convo.sessionId)} />
            </>
          ) : null}
          {!isSim && convo.sessionId ? (
            <Text type="supporting">
              Test session <Code>{convo.sessionId}</Code>
            </Text>
          ) : null}
        </HStack>
        <HStack gap={2} wrap="wrap">
          {isSim && convo.sessionId && !ended ? (
            <Button label="End call" size="sm" isDisabled={busy} onClick={() => void run('', true)} />
          ) : null}
          <Button label={isSim ? 'Start a new call' : 'Reset conversation'} size="sm" isDisabled={busy} onClick={reset} />
        </HStack>
      </HStack>

      <Card padding={0} height="min(640px, 70dvh)" minHeight={420} style={{overflow: 'hidden', display: 'flex', flexDirection: 'column'}}>
        <ChatLayout
          density="compact"
          style={{flex: 1, minHeight: 0}}
          composer={
            <ChatComposer
              value={draft}
              onChange={setDraft}
              onSubmit={submit}
              isDisabled={busy || ended}
              placeholder={
                ended ? 'The call ended. Start a new call to go on.' : busy ? 'Waiting for the agent' : 'Type what a caller would say'
              }
            />
          }>
          <ChatMessageList>
            {convo.turns.length === 0 && pending === null ? (
              <ChatMessage sender="assistant" name={null}>
                <ChatMessageBubble variant="ghost" width="100%">
                  <Text type="supporting">
                    {isSim
                      ? 'You play the caller. The first message starts the simulated call.'
                      : 'You play the caller. The agent answers with mock tools, and each answer shows the tools it used.'}
                  </Text>
                </ChatMessageBubble>
              </ChatMessage>
            ) : null}
            {convo.turns.map((turn, index) =>
              turn.role === 'owner' ? (
                <OwnerTurn key={index} text={turn.text || '(hung up)'} />
              ) : (
                <AgentTurn key={index} turn={turn} mode={mode} agentName={agentName} />
              ),
            )}
            {pending !== null ? <OwnerTurn text={pending} status="sending" /> : null}
            {failed && copy ? (
              <>
                {failed.text ? <OwnerTurn text={failed.text} status="error" /> : null}
                <ChatMessage sender="assistant" name={null}>
                  <ChatMessageBubble variant="ghost" width="100%">
                    <Banner
                      status="error"
                      title={copy.title}
                      description={copy.description}
                      collapsible={false}
                      endContent={
                        canRetry ? <Button label="Try again" size="sm" onClick={() => void run(failed.text, failed.isEnd)} /> : undefined
                      }>
                      {isApiError(failed.error) && failed.error.correlationId ? (
                        <Text type="supporting">Reference: {failed.error.correlationId}</Text>
                      ) : null}
                    </Banner>
                  </ChatMessageBubble>
                </ChatMessage>
              </>
            ) : null}
            {!busy && !ended ? (
              <ChatMessage sender="assistant" name={null}>
                <ChatMessageBubble variant="ghost" width="100%">
                  <VStack gap={2}>
                    <Text type="supporting">{convo.turns.length === 0 ? 'Try one of these' : 'Quick answer'}</Text>
                    <HStack gap={2} wrap="wrap">
                      {starters.map((text) => (
                        <Button key={text} label={text} size="sm" onClick={() => submit(text)} />
                      ))}
                    </HStack>
                  </VStack>
                </ChatMessageBubble>
              </ChatMessage>
            ) : null}
          </ChatMessageList>
        </ChatLayout>
      </Card>
    </VStack>
  );
}

export function TestConsole({
  businessId,
  agentId,
  agentName,
  template,
  simGate,
}: {
  businessId: string;
  agentId: string;
  agentName: string;
  template: AgentSpec['template'] | undefined;
  simGate: SimCallGate;
}) {
  const [mode, setMode] = useState<ConsoleMode>('test');
  const active: ConsoleMode = mode === 'sim-call' && !simGate.isAllowed ? 'test' : mode;
  return (
    <Card>
      <VStack gap={4}>
        <VStack gap={1}>
          <Heading level={2}>Talk to the agent</Heading>
          <Text type="supporting">Type as a caller would. Pick how the agent runs.</Text>
        </VStack>
        <VStack gap={1}>
          <SegmentedControl label="How the agent runs" value={active} onChange={(v) => setMode(v as ConsoleMode)}>
            <SegmentedControlItem value="test" label={MODE_LABELS.test} />
            <SegmentedControlItem value="sim-call" label={MODE_LABELS['sim-call']} isDisabled={!simGate.isAllowed} />
          </SegmentedControl>
          {!simGate.isAllowed && simGate.reason ? <Text type="supporting">Simulated call is off: {simGate.reason}</Text> : null}
        </VStack>
        {/* Each mode keeps its own conversation. Both stay mounted so switching back keeps the turns. */}
        <VStack gap={0} style={{display: active === 'test' ? undefined : 'none'}}>
          <Conversation businessId={businessId} agentId={agentId} agentName={agentName} template={template} mode="test" />
        </VStack>
        {simGate.isAllowed ? (
          <VStack gap={0} style={{display: active === 'sim-call' ? undefined : 'none'}}>
            <Conversation businessId={businessId} agentId={agentId} agentName={agentName} template={template} mode="sim-call" />
          </VStack>
        ) : null}
      </VStack>
    </Card>
  );
}
