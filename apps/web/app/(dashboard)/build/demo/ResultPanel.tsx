'use client';

import {DEMO_PHONE_NUMBER} from '@abos/contracts/fixtures';
import {Card} from '@astryxdesign/core/Card';
import {Grid} from '@astryxdesign/core/Grid';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {SandboxBadge} from '@/components/SandboxBadge';
import {getDemoPhoneNumber, isMockMode} from '@/lib/env';
import {formatMoney, formatPhone} from '@/lib/format';
import {groupByPrice, WOODSTOCKS_MENU, type PriceRow, type WoodstocksMenu} from './woodstocks-menu';

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
// The number card is as wide as the number (capped, so the long missing-number
// text cannot take the row); the menu takes the rest. The two stack on a narrow screen.
const NUMBER_COLUMN = {flex: '0 1 auto', minWidth: 0, maxWidth: '40rem'} as const;
const MENU_COLUMN = {flex: '1 1 32rem', minWidth: 0} as const;

/** One block per price row: the prices once, large, then the pizzas they apply to. */
function PriceBlock({row, menu, isOnly}: {row: PriceRow; menu: WoodstocksMenu; isOnly: boolean}) {
  return (
    <VStack gap={2}>
      <Grid columns={menu.sizes.length} gap={3}>
        {menu.sizes.map((size, i) => (
          <VStack key={size.key} gap={0}>
            <HStack gap={1} vAlign="end" wrap="wrap">
              <Text type="large" weight="semibold">
                {size.name}
              </Text>
              <Text type="supporting">{`${size.inches} inch`}</Text>
            </HStack>
            <Text type="display-2" weight="semibold" hasTabularNumbers>
              {formatMoney(row.priceMinor[i]!, menu.currency)}
            </Text>
          </VStack>
        ))}
      </Grid>
      <Text type="body" color="secondary">
        {isOnly ? 'Every pizza below, any size, same price' : 'These pizzas, any size'}
      </Text>
      <Grid columns={{minWidth: 150, max: 3}} columnGap={4} rowGap={1}>
        {row.names.map((name) => (
          <Text key={name} type="large" weight="normal">
            {name}
          </Text>
        ))}
      </Grid>
    </VStack>
  );
}

export function ResultPanel({phoneNumber, menu = WOODSTOCKS_MENU}: {phoneNumber: string | undefined; menu?: WoodstocksMenu}) {
  const rows = groupByPrice(menu.pizzas);
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
          {rows.map((row) => (
            <PriceBlock key={row.priceMinor.join('-')} row={row} menu={menu} isOnly={rows.length === 1} />
          ))}
        </VStack>
      </Card>
    </HStack>
  );
}
