'use client';

// Adapted from the Astryx "ai-chat-landing" template and the
// "ChatComposerFullFeatured" block: one composer with a suggestion, and an
// attachment drawer that shows one token per attached file. Heroicons and the model menus
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
import {HStack} from '@astryxdesign/core/HStack';
import {Text} from '@astryxdesign/core/Text';
import {Token} from '@astryxdesign/core/Token';
import {VStack} from '@astryxdesign/core/VStack';
import {DEMO_PROMPT} from './demo-machine';

export type DemoChatProps = {
  /** The message the presenter sent. Absent while composing. It is shown here only: it is not sent to the builder and no file is uploaded. */
  message: {text: string; fileNames: string[]} | null;
  onSend: (text: string, fileNames: string[]) => void;
};

/**
 * Adds a new pick to the files already attached. A second pick adds to the
 * list instead of replacing it, and a file whose name is already there is skipped.
 */
export function addFiles(current: readonly File[], picked: File | File[] | null): File[] {
  const next = [...current];
  const names = new Set(current.map((f) => f.name));
  for (const file of picked === null ? [] : Array.isArray(picked) ? picked : [picked]) {
    if (names.has(file.name)) continue;
    names.add(file.name);
    next.push(file);
  }
  return next;
}

export function DemoChat({message, onSend}: DemoChatProps) {
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<File[]>([]);

  const submit = (text: string) => {
    if (!text.trim()) return;
    onSend(text, files.map((f) => f.name));
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
                files.length ? (
                  <ChatComposerDrawer count={files.length}>
                    {files.map((f) => (
                      <Token key={f.name} label={f.name} onRemove={() => setFiles((list) => list.filter((x) => x.name !== f.name))} />
                    ))}
                  </ChatComposerDrawer>
                ) : undefined
              }
              footerActions={
                <FileInput
                  label="Attach the menu and FAQ files"
                  isLabelHidden
                  isMultiple
                  // The tokens above list the files, so the field always reads "Attach files".
                  // FileInput passes only the new pick, which is added to the list.
                  value={[]}
                  onChange={(picked) => setFiles((list) => addFiles(list, picked))}
                  accept=".pdf,.txt,.csv,.md,.png,.jpg,.jpeg"
                  placeholder="Attach files"
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
                {message.fileNames.length ? (
                  <ChatMessageBubble variant="ghost">
                    <HStack gap={2} wrap="wrap">
                      {message.fileNames.map((name) => (
                        <Token key={name} label={name} />
                      ))}
                    </HStack>
                  </ChatMessageBubble>
                ) : null}
              </ChatMessage>
            </>
          ) : (
            <ChatMessage sender="assistant" name={null}>
              <ChatMessageBubble variant="ghost" width="100%">
                <VStack gap={2}>
                  <Text type="large">Paste the menu and the questions and answers, or attach files, then send.</Text>
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
