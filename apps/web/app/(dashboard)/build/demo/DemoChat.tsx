'use client';

// Adapted from the Astryx "ai-chat-landing" template and the
// "ChatComposerFullFeatured" block: one composer with a suggestion, and an
// attachment drawer that shows one token per attached file. Heroicons and the model menus
// were removed. The message is plain text: pasted menus are data, never markup.
// Above the composer, a picker of the three stage shops: the judge picks one,
// and its two file names are attached as if the PDFs had been picked.

import {useState} from 'react';
import {stageShops, type StageShop, type StageShopKey} from '@abos/contracts/fixtures';
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
import {ClickableCard} from '@astryxdesign/core/ClickableCard';
import {FileInput} from '@astryxdesign/core/FileInput';
import {Grid} from '@astryxdesign/core/Grid';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {Text} from '@astryxdesign/core/Text';
import {Token} from '@astryxdesign/core/Token';
import {VStack} from '@astryxdesign/core/VStack';
import {NO_SHOP_TEXT, shopForFileNames} from './stage-shop';

export type DemoChatProps = {
  /** The message the presenter sent. Absent while composing. It is shown here only: it is not sent to the builder and no file is uploaded. */
  message: {text: string; fileNames: string[]} | null;
  /** Called only when an attached file selects a stage shop. */
  onSend: (text: string, fileNames: string[], shopKey: StageShopKey) => void;
  /** One plain line under the suggestion, for example when the shop is not one of the owner's businesses. */
  error?: string | null;
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

/**
 * The two files of a shop, as if they had been attached. They are empty
 * stand-ins: on stage nothing is uploaded, only the names show and select the shop.
 */
export function shopFiles(shop: StageShop): File[] {
  return [shop.files.info, shop.files.faq].map((name) => new File([], name, {type: 'application/pdf'}));
}

export function DemoChat({message, onSend, error}: DemoChatProps) {
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const shop = shopForFileNames(files.map((f) => f.name));

  const submit = (text: string) => {
    if (!text.trim() || !shop) return;
    onSend(text, files.map((f) => f.name), shop.key);
  };

  return (
    <Card padding={0} height="min(48rem, 72dvh)" minHeight="22rem" style={{overflow: 'hidden', display: 'flex', flexDirection: 'column'}}>
      <ChatLayout
        density="balanced"
        style={{flex: 1, minHeight: 0}}
        composer={
          message ? undefined : (
            <ChatComposer
              value={draft}
              onChange={setDraft}
              onSubmit={submit}
              placeholder="Attach the shop's two files, then send"
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
                  label="Attach the shop's files"
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
                <VStack gap={3}>
                  <ShopPicker selected={shop?.key ?? null} onPick={(picked) => setFiles(shopFiles(picked))} />
                  <Text type="large">Attach the shop&apos;s two files, then send.</Text>
                  <HStack gap={3} vAlign="center" wrap="wrap">
                    <Button
                      label="Use the suggested prompt"
                      isDisabled={!shop}
                      onClick={() => {
                        if (!shop) return;
                        setDraft((d) => (d.trim() ? `${shop.prompt}\n\n${d}` : shop.prompt));
                      }}
                    />
                    {shop ? null : <Text type="supporting">{NO_SHOP_TEXT}</Text>}
                  </HStack>
                  {error ? <Text type="supporting">{error}</Text> : null}
                </VStack>
              </ChatMessageBubble>
            </ChatMessage>
          )}
        </ChatMessageList>
      </ChatLayout>
    </Card>
  );
}

/** The judge's choice: three shops, each with its kind and one line. Picking one replaces the attached files. */
export function ShopPicker({selected, onPick}: {selected: StageShopKey | null; onPick: (shop: StageShop) => void}) {
  return (
    <VStack gap={2}>
      <Heading level={2}>Pick a business</Heading>
      <Grid columns={{minWidth: 180, max: 3}} gap={3}>
        {stageShops.map((s) => (
          <ClickableCard key={s.key} label={s.kindLabel} onClick={() => onPick(s)} variant={selected === s.key ? 'blue' : 'default'}>
            <VStack gap={1}>
              <Text type="large" weight="semibold">
                {s.kindLabel}
              </Text>
              <Text type="body" color="secondary">
                {s.blurb}
              </Text>
            </VStack>
          </ClickableCard>
        ))}
      </Grid>
    </VStack>
  );
}
