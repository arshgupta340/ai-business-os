'use client';

import {DEMO_PHONE_NUMBER} from '@abos/contracts/fixtures';
import {Card} from '@astryxdesign/core/Card';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {SandboxBadge} from '@/components/SandboxBadge';
import {getDemoPhoneNumber, isMockMode} from '@/lib/env';
import {formatPhone} from '@/lib/format';
import {DEMO_MENU, sizesLine, toppingsLine, type DemoMenu} from './demo-menu';

/**
 * The number the panel shows: NEXT_PUBLIC_DEMO_PHONE_NUMBER, fixed before the
 * demo. In mock mode with no value, the shared fixture number, so rehearsal
 * works. Otherwise undefined: the panel never invents a number.
 */
export function demoPhoneNumber(): string | undefined {
  return getDemoPhoneNumber() ?? (isMockMode() ? DEMO_PHONE_NUMBER : undefined);
}

export const MISSING_NUMBER_TEXT = 'The demo phone number is not set. Set NEXT_PUBLIC_DEMO_PHONE_NUMBER and build the app again.';

// Bigger than display-1, from the type scale tokens, so the number reads from the back of a room.
const NUMBER_STYLE = {fontSize: 'calc(var(--font-size-5xl) * 1.4)', lineHeight: 1.1} as const;
// The number takes the wider share of the row; the two stack on a narrow screen.
const NUMBER_COLUMN = {flex: '3 1 36rem', minWidth: 0} as const;
const MENU_COLUMN = {flex: '2 1 20rem', minWidth: 0} as const;

export function ResultPanel({phoneNumber, menu = DEMO_MENU}: {phoneNumber: string | undefined; menu?: DemoMenu}) {
  return (
    <HStack gap={4} wrap="wrap" vAlign="stretch">
      <Card variant="muted" style={NUMBER_COLUMN}>
        {phoneNumber ? (
          <VStack gap={2}>
            <Text type="label" color="secondary">
              Phone number
            </Text>
            <Text type="display-1" weight="semibold" hasTabularNumbers textWrap="balance" style={NUMBER_STYLE} as="p">
              {formatPhone(phoneNumber)}
            </Text>
            <Text type="display-3">Call this number to order</Text>
          </VStack>
        ) : (
          <VStack gap={2}>
            <Heading level={2}>No phone number to show</Heading>
            <Text type="large" weight="normal">
              {MISSING_NUMBER_TEXT}
            </Text>
          </VStack>
        )}
      </Card>
      <Card style={MENU_COLUMN}>
        <VStack gap={3}>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Heading level={2}>Menu</Heading>
            <SandboxBadge label="Sandbox prices" />
          </HStack>
          {menu.items.map((item) => (
            <VStack key={item.id} gap={0.5}>
              <Text type="display-3" weight="semibold">
                {item.name}
              </Text>
              <Text type="large" weight="normal" hasTabularNumbers>
                {sizesLine(item)}
              </Text>
            </VStack>
          ))}
          {menu.toppingLists.map((list) => (
            <VStack key={list.id} gap={0.5}>
              <Text type="large" weight="semibold">
                {list.name}
              </Text>
              <Text type="large" weight="normal" hasTabularNumbers>
                {toppingsLine(list)}
              </Text>
            </VStack>
          ))}
        </VStack>
      </Card>
    </HStack>
  );
}
