'use client';

import {Banner} from '@astryxdesign/core/Banner';
import {Card} from '@astryxdesign/core/Card';
import {HStack} from '@astryxdesign/core/HStack';
import {Link} from '@astryxdesign/core/Link';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import type {Order, OrderCheckout} from '@/lib/api';
import {formatTime} from '@/lib/format';
import {statusView} from '@/lib/status';
import {SandboxBadge} from '@/components/SandboxBadge';
import {StatusBadge} from '@/components/StatusBadge';
import type {MessageView} from './journey';
import {QrCode} from './QrCode';
import {bannerStatus, Panel} from './ui';

/** What to tell the owner about the payment link message. Never says sent unless the dispatch says so. */
export function messageCopy(message: MessageView | undefined, qrOnly: boolean, paid = false): {title: string; description: string; tone: 'info' | 'warning' | 'danger' | 'success' | 'neutral'} {
  if (!message || message.status === 'NOT_STARTED') {
    return qrOnly
      ? {title: 'No message will be sent', description: 'This business uses QR only. Show the customer the QR code.', tone: 'info'}
      : {title: 'Message not sent yet', description: 'The link goes out after the checkout step.', tone: 'info'};
  }
  if (message.status === 'SKIPPED') {
    return {
      title: 'No message was sent',
      description: qrOnly
        ? 'The message channel is QR only. Show the customer the QR code.'
        : 'No message was dispatched for this order. Show the customer the QR code.',
      tone: statusView('execution', 'SKIPPED').tone,
    };
  }
  const view = statusView('messageDispatch', message.status);
  const via = message.channel ? ` (${message.channel})` : '';
  switch (message.status) {
    case 'QUEUED':
      return {title: `${view.label}${via}`, description: 'The message is waiting to go out. It has not been sent yet.', tone: view.tone};
    case 'SENT':
      return {
        title: `${view.label}${via}`,
        description: paid
          ? 'The channel accepted the message.'
          : 'The channel accepted the message. Delivery to the phone is not confirmed yet. The link is not paid yet.',
        tone: view.tone,
      };
    case 'DELIVERED':
      return {
        title: `${view.label}${via}`,
        description: paid ? 'The channel confirmed delivery.' : 'The channel confirmed delivery. The link is not paid until Square verifies it.',
        tone: view.tone,
      };
    case 'FAILED':
      return {title: 'Message failed', description: 'The customer did not get the link by message. Show them the QR code.', tone: view.tone};
    case 'UNKNOWN':
      return {
        title: 'Delivery unknown',
        description: 'The channel did not confirm the message. It is not resent automatically. Show the customer the QR code.',
        tone: view.tone,
      };
  }
}

export function CheckoutPanel({
  order,
  checkout,
  message,
  qrOnly,
  paid,
  timeZone,
}: {
  order: Order;
  checkout: OrderCheckout | undefined;
  message: MessageView | undefined;
  qrOnly: boolean;
  /** Server-verified payment (journey.paidVerified). */
  paid: boolean;
  timeZone: string;
}) {
  const url = checkout?.checkoutUrl ?? order.checkoutUrl;
  const qrText = checkout?.qrText ?? url;
  const ready = checkout ? checkout.ready : !!url;
  const linkView = statusView('order', ready && ['APPROVED', 'CREATING_CHECKOUT'].includes(order.status) ? 'PAYMENT_LINK_READY' : order.status);
  const copy = messageCopy(message, qrOnly, paid);
  const pointToQr = copy.description.includes('QR code');

  return (
    <Panel title="Checkout link">
      <HStack gap={2} vAlign="center" wrap="wrap">
        <StatusBadge label={linkView.label} tone={linkView.tone} />
        <SandboxBadge label="Square sandbox" />
      </HStack>
      {!ready || !url ? (
        <Text type="body" color="secondary">
          The link appears here once Square creates it.
        </Text>
      ) : (
        <HStack gap={6} wrap="wrap" vAlign="start">
          {paid ? null : (
          <VStack gap={2} hAlign="center">
            <Card padding={3} variant="default" elevation="low">
              {qrText ? <QrCode text={qrText} label="QR code for the Square sandbox checkout link" size={280} /> : null}
            </Card>
            <HStack gap={2} vAlign="center">
              <SandboxBadge />
              <Text type="supporting">Sandbox test payment only</Text>
            </HStack>
          </VStack>
          )}
          <VStack gap={3} style={{flex: '1 1 0', minWidth: 'min(100%, 16rem)'}}>
            <VStack gap={1}>
              <Text type="label">Payment link (Square sandbox)</Text>
              <Link href={url} isExternalLink type="large">
                {url}
              </Link>
              {order.squareOrderId ? (
                <Text type="supporting">Square order {order.squareOrderId} (sandbox)</Text>
              ) : null}
            </VStack>
            <Banner
              status={bannerStatus(copy.tone === 'success' ? 'info' : copy.tone)}
              title={copy.title}
              description={
                checkout?.message?.sentAt && message?.status !== 'FAILED'
                  ? `${copy.description} Accepted at ${formatTime(checkout.message.sentAt, timeZone)}.`
                  : copy.description
              }
              collapsible={false}
            />
            {paid ? (
              <Text type="body">Square verified the payment, so the QR code is hidden.</Text>
            ) : pointToQr ? (
              <Text type="large">Hold the QR code up to the customer&apos;s phone camera.</Text>
            ) : (
              <Text type="supporting">The QR code is a backup if the message does not arrive.</Text>
            )}
          </VStack>
        </HStack>
      )}
    </Panel>
  );
}
