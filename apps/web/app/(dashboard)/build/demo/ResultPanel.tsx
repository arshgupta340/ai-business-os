'use client';

import type {CSSProperties} from 'react';
import {STAGE_PIZZA_SIZES, type StageShop} from '@abos/contracts/fixtures';
import {Card} from '@astryxdesign/core/Card';
import {Heading} from '@astryxdesign/core/Heading';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {Phone} from 'lucide-react';
import {SandboxBadge} from '@/components/SandboxBadge';
import {formatMoney, formatPhoneLocal} from '@/lib/format';
import {missingNumberText} from './stage-shop';

/** "$15" for a whole-dollar price, else "$15.50". */
export function wholeDollars(amountMinor: number, currency = 'USD'): string {
  if (amountMinor % 100 !== 0) return formatMoney(amountMinor, currency);
  return new Intl.NumberFormat('en-US', {style: 'currency', currency, maximumFractionDigits: 0}).format(amountMinor / 100);
}

// Two turns of the ten digits: each digit of the number rolls down one full turn and stops on its own.
const DIGIT_STRIP = '01234567890123456789'.split('');

/**
 * The phone number, as large as its card allows, each digit rolling into place
 * (`.abos-number` in app/globals.css). The rolling digits are decoration: the
 * number itself is one plain line of text for screen readers and for copying.
 */
function RollingNumber({text}: {text: string}) {
  const chars = [...text];
  // The position of each digit among the digits, for the stagger.
  const digitIndex = chars.map((c, i) => chars.slice(0, i).filter((x) => /\d/.test(x)).length);
  return (
    <>
      <p className="abos-sr">{text}</p>
      <div className="abos-number" aria-hidden>
        {chars.map((c, i) => {
          if (c === ' ') return <span key={i} className="abos-gap" />;
          if (!/\d/.test(c)) return <span key={i}>{c}</span>;
          return (
            <span key={i} className="abos-digit">
              <i style={{'--d': c, '--i': digitIndex[i]} as CSSProperties}>
                {DIGIT_STRIP.map((d, j) => (
                  <b key={j}>{d}</b>
                ))}
              </i>
            </span>
          );
        })}
      </div>
    </>
  );
}

/** The pizza place: the three size prices once, then every pizza they apply to. */
function PizzaMenu({shop}: {shop: StageShop}) {
  return (
    <>
      <div className="abos-sizes">
        {STAGE_PIZZA_SIZES.map((size) => (
          <div key={size.code}>
            <span className="abos-size-name">{size.name}</span>
            <span className="abos-size-note">{`${size.inches} inch`}</span>
            <span className="abos-price">{wholeDollars(size.priceMinor)}</span>
          </div>
        ))}
      </div>
      <div className="abos-items-block">
        <span className="abos-menu-note">Every pizza below, any size, same price</span>
        <div className="abos-items">
          {shop.catalog
            .filter((item) => item.available)
            .map((item) => (
              <span key={item.squareItemId}>{item.name}</span>
            ))}
        </div>
      </div>
    </>
  );
}

/** The barbershop and the salon: each service with its duration and price. */
function ServiceList({shop}: {shop: StageShop}) {
  return (
    <div className="abos-services">
      {shop.services.map((service) => (
        <div key={service.id}>
          <span className="abos-service-name">{service.name}</span>
          <span className="abos-size-note">{`${service.durationMinutes} minutes`}</span>
          <span className="abos-price">{formatMoney(service.priceMinor, service.currency)}</span>
        </div>
      ))}
    </div>
  );
}

export type ResultPanelProps = {
  shop: StageShop;
  phoneNumber: string | undefined;
  /**
   * True once the order or booking is on screen: the number and the shop
   * shrink to one strip, so the card below takes the screen.
   */
  isCompact?: boolean;
};

export function ResultPanel({shop, phoneNumber, isCompact = false}: ResultPanelProps) {
  if (!phoneNumber) {
    return (
      <Card variant="muted">
        <VStack gap={2}>
          <Heading level={2}>No phone number to show</Heading>
          <Text type="large" weight="normal">
            {missingNumberText(shop.key)}
          </Text>
        </VStack>
      </Card>
    );
  }

  if (isCompact) {
    return (
      <div className="abos-strip">
        <span className="abos-phone-badge">
          <Phone aria-hidden />
        </span>
        <span className="abos-strip-name">{shop.name}</span>
        <p className="abos-strip-number">{formatPhoneLocal(phoneNumber)}</p>
        <span className="abos-hero-hours">{shop.hoursText}</span>
      </div>
    );
  }

  return (
    <VStack gap={4}>
      <div className="abos-hero">
        <div className="abos-hero-inner">
          <div className="abos-hero-top">
            <span className="abos-phone-badge" data-live="">
              <Phone aria-hidden />
            </span>
            <div>
              <div className="abos-hero-name">{shop.name}</div>
              <div className="abos-hero-action">{shop.callerAction}</div>
            </div>
            <span className="abos-hero-hours">{shop.hoursText}</span>
          </div>
          <RollingNumber text={formatPhoneLocal(phoneNumber)} />
        </div>
      </div>
      <Card>
        <div className="abos-menu">
          <div className="abos-menu-head">
            <Heading level={2}>{shop.infoTitle}</Heading>
            <SandboxBadge label="Sandbox prices" />
          </div>
          {shop.key === 'pizza' ? <PizzaMenu shop={shop} /> : <ServiceList shop={shop} />}
        </div>
      </Card>
    </VStack>
  );
}
