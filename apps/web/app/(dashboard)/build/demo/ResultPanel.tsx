'use client';

import {STAGE_PIZZA_SIZES, type StageShop} from '@abos/contracts/fixtures';
import {Card} from '@astryxdesign/core/Card';
import {Grid} from '@astryxdesign/core/Grid';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {SandboxBadge} from '@/components/SandboxBadge';
import {formatMoney, formatPhoneLocal} from '@/lib/format';
import {missingNumberText} from './stage-shop';

// Bigger than display-1, from the type scale tokens, so the number reads from the back of a room.
// It stays on one line, and shrinks with the window before it could overflow its card.
const NUMBER_STYLE = {fontSize: 'min(calc(var(--font-size-5xl) * 1.4), 4.2vw)', lineHeight: 1.1, whiteSpace: 'nowrap'} as const;
// Two cards of the same height. The number sits in the middle of its card, the menu takes the other half.
// The two stack on a narrow screen.
const NUMBER_COLUMN = {flex: '1 1 30rem', minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center'} as const;
const MENU_COLUMN = {flex: '1 1 32rem', minWidth: 0} as const;

/** "$15" for a whole-dollar price, else "$15.50". */
export function wholeDollars(amountMinor: number, currency = 'USD'): string {
  if (amountMinor % 100 !== 0) return formatMoney(amountMinor, currency);
  return new Intl.NumberFormat('en-US', {style: 'currency', currency, maximumFractionDigits: 0}).format(amountMinor / 100);
}

/** The pizza place: the three size prices once, large, then every pizza they apply to. */
function PizzaMenu({shop}: {shop: StageShop}) {
  return (
    <VStack gap={2}>
      <Grid columns={STAGE_PIZZA_SIZES.length} gap={3}>
        {STAGE_PIZZA_SIZES.map((size) => (
          <VStack key={size.code} gap={0}>
            <HStack gap={1} vAlign="end" wrap="wrap">
              <Text type="large" weight="semibold">
                {size.name}
              </Text>
              <Text type="supporting">{`${size.inches} inch`}</Text>
            </HStack>
            <Text type="display-2" weight="semibold" hasTabularNumbers>
              {wholeDollars(size.priceMinor)}
            </Text>
          </VStack>
        ))}
      </Grid>
      <Text type="body" color="secondary">
        Every pizza below, any size, same price
      </Text>
      <Grid columns={{minWidth: 150, max: 3}} columnGap={4} rowGap={1}>
        {shop.catalog
          .filter((item) => item.available)
          .map((item) => (
            <Text key={item.squareItemId} type="large" weight="normal">
              {item.name}
            </Text>
          ))}
      </Grid>
    </VStack>
  );
}

/** The barbershop and the salon: each service with its duration and price. */
function ServiceList({shop}: {shop: StageShop}) {
  return (
    <VStack gap={2}>
      {shop.services.map((service) => (
        <HStack key={service.id} gap={3} justify="between" vAlign="center">
          <VStack gap={0}>
            <Text type="display-3">{service.name}</Text>
            <Text type="large" weight="normal" color="secondary">{`${service.durationMinutes} minutes`}</Text>
          </VStack>
          <Text type="display-3" weight="semibold" hasTabularNumbers>
            {formatMoney(service.priceMinor, service.currency)}
          </Text>
        </HStack>
      ))}
    </VStack>
  );
}

export function ResultPanel({shop, phoneNumber}: {shop: StageShop; phoneNumber: string | undefined}) {
  return (
    <HStack gap={4} wrap="wrap" vAlign="stretch">
      <Card variant="muted" style={NUMBER_COLUMN}>
        {phoneNumber ? (
          <VStack gap={3} hAlign="center">
            <Text type="display-3" weight="semibold">
              {shop.name}
            </Text>
            <Text type="display-3" color="secondary">
              {shop.callerAction}
            </Text>
            <Text type="display-1" weight="semibold" hasTabularNumbers style={NUMBER_STYLE} as="p">
              {formatPhoneLocal(phoneNumber)}
            </Text>
            <Text type="large" weight="normal" color="secondary">
              {shop.hoursText}
            </Text>
          </VStack>
        ) : (
          <VStack gap={2}>
            <Heading level={2}>No phone number to show</Heading>
            <Text type="large" weight="normal">
              {missingNumberText(shop.key)}
            </Text>
          </VStack>
        )}
      </Card>
      <Card style={MENU_COLUMN}>
        <VStack gap={3}>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Heading level={2}>{shop.infoTitle}</Heading>
            <SandboxBadge label="Sandbox prices" />
          </HStack>
          {shop.key === 'pizza' ? <PizzaMenu shop={shop} /> : <ServiceList shop={shop} />}
        </VStack>
      </Card>
    </HStack>
  );
}
