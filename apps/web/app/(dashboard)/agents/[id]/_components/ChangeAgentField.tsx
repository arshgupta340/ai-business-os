'use client';

import {useRef, useState} from 'react';
import {useRouter} from 'next/navigation';
import {useQueryClient} from '@tanstack/react-query';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {Text} from '@astryxdesign/core/Text';
import {TextArea} from '@astryxdesign/core/TextArea';
import {VStack} from '@astryxdesign/core/VStack';
import {api, queryKeys, useCreateBuilderSession, type Agent} from '@/lib/api';
import {rememberSession, writeNotes} from '../../../build/_lib/memory';
import {EMPTY_NOTES, mergeTurn} from '../../../build/_lib/spec';
import {ErrorNotice} from '../../_components/ErrorNotice';

/**
 * The change instruction field (PRD screen 5, FLOWS D1). It starts a builder
 * session for this agent (`agentId` on create), sends the owner's text as the
 * first message, keeps that turn's notes where the builder reads them (so a
 * proposed fact change shows its confirm step there), and opens
 * /build?session=<id>. Nothing changes here: any fact edit still waits for the
 * owner's confirmation in the builder.
 */
export function ChangeAgentField({businessId, agent}: {businessId: string; agent: Agent}) {
  const router = useRouter();
  const qc = useQueryClient();
  const create = useCreateBuilderSession(businessId);
  const [text, setText] = useState('');
  const [isSending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // A session made by a failed attempt is reused on retry, so a retry does not start a second one.
  const sessionRef = useRef<string | null>(null);
  const busy = useRef(false);

  const submit = async () => {
    const value = text.trim();
    if (!value || busy.current) return;
    busy.current = true;
    setSending(true);
    setError(null);
    try {
      let sessionId = sessionRef.current;
      if (!sessionId) {
        const session = await create.mutateAsync({agentId: agent.id});
        sessionId = session.id;
        sessionRef.current = sessionId;
        rememberSession(businessId, sessionId);
      }
      const turn = await api.sendBuilderMessage(businessId, sessionId, {text: value, inputMode: 'text'});
      writeNotes(sessionId, mergeTurn(EMPTY_NOTES, turn));
      await qc.invalidateQueries({queryKey: queryKeys.builderSession(businessId, sessionId)});
      router.push(`/build?session=${encodeURIComponent(sessionId)}`);
    } catch (err) {
      setError(err);
      busy.current = false;
      setSending(false);
    }
  };

  return (
    <Card>
      <VStack gap={3}>
        <VStack gap={1}>
          <Heading level={2}>Change this agent</Heading>
          <Text type="supporting">
            Say what should change, for example: we close at 11 pm on Fridays now. The builder opens with your message. Nothing changes until you confirm it there.
          </Text>
        </VStack>
        <TextArea
          label="What should change"
          value={text}
          onChange={(v) => setText(v)}
          rows={3}
          maxLength={2000}
          isDisabled={isSending}
        />
        <HStack gap={2} hAlign="end">
          <Button
            label="Open in the builder"
            variant="primary"
            onClick={() => void submit()}
            isLoading={isSending}
            isDisabled={isSending || text.trim().length === 0}
          />
        </HStack>
        {error ? <ErrorNotice error={error} context="change" onRetry={() => void submit()} /> : null}
      </VStack>
    </Card>
  );
}
