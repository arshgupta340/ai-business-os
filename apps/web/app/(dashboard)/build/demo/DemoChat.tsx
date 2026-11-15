'use client';

// Adapted from the Astryx "ai-chat-landing" template and the
// "ChatComposerFullFeatured" block: one composer with a suggestion, and an
// attachment drawer that shows the file name. Heroicons and the model menus
// were removed. The message is plain text: pasted menus are data, never markup.

import {useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {
  ChatComposer,
  ChatComposerDrawer,
  ChatLayout,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
} from '@astryxdesign/core/Chat';
import {FileInput} from '@astryxdesign/core/FileInput';
import {Text} from '@astryxdesign/core/Text';
import {Token} from '@astryxdesign/core/Token';
import {VStack} from '@astryxdesign/core/VStack';
import {DEMO_PROMPT} from './demo-machine';

export type DemoChatProps = {
  /** The message the presenter sent. Absent while composing. It is shown here only: it is not sent to the builder and the file is not uploaded. */
  message: {text: string; fileName?: string} | null;
  onSend: (text: string, fileName?: string) => void;
};

export function DemoChat({message, onSend}: DemoChatProps) {
  const [draft, setDraft] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const submit = (text: string) => {
    if (!text.trim()) return;
    onSend(text, file?.name);
  };

  return (
    <Card padding={0} height="min(40rem, 62dvh)" minHeight="22rem" style={{overflow: 'hidden', display: 'flex', flexDirection: 'column'}}>
      <ChatLayout
        density="balanced"
        style={{flex: 1, minHeight: 0}}
        composer={
          message ? undefined : (
            <ChatComposer
              value={draft}
              onChange={setDraft}
              onSubmit={submit}
              placeholder="Paste the menu and the questions and answers, then send"
              drawer={
                file ? (
                  <ChatComposerDrawer count={1}>
                    <Token label={file.name} onRemove={() => setFile(null)} />
                  </ChatComposerDrawer>
                ) : undefined
              }
              footerActions={
                <FileInput
                  label="Attach the menu file"
                  isLabelHidden
                  value={file}
                  onChange={(files) => setFile(Array.isArray(files) ? (files[0] ?? null) : files)}
                  accept=".pdf,.txt,.csv,.md,.png,.jpg,.jpeg"
                  placeholder="Attach a file"
                />
              }
            />
          )
        }>
        <ChatMessageList>
          {message ? (
            <>
              <ChatMessage sender="user" name="You">
                <ChatMessageBubble>
                  <Text type="large" weight="normal" maxLines={8} hasTruncateTooltip={false}>
                    {message.text}
                  </Text>
                </ChatMessageBubble>
                {message.fileName ? (
                  <ChatMessageBubble variant="ghost">
                    <Token label={message.fileName} />
                  </ChatMessageBubble>
                ) : null}
              </ChatMessage>
            </>
          ) : (
            <ChatMessage sender="assistant" name={null}>
              <ChatMessageBubble variant="ghost" width="100%">
                <VStack gap={2}>
                  <Text type="large">Paste the menu and the questions and answers, or attach a file, then send.</Text>
                  <Button label="Use the suggested prompt" onClick={() => setDraft((d) => (d.trim() ? `${DEMO_PROMPT}\n\n${d}` : DEMO_PROMPT))} />
                </VStack>
              </ChatMessageBubble>
            </ChatMessage>
          )}
        </ChatMessageList>
      </ChatLayout>
    </Card>
  );
}
