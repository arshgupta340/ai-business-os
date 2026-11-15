'use client';

import {useEffect, useRef, useState, type ReactNode} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Grid} from '@astryxdesign/core/Grid';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {Icon} from '@astryxdesign/core/Icon';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {LoadingState} from '@/components/LoadingState';
import {SandboxBadge} from '@/components/SandboxBadge';
import {StatusBadge} from '@/components/StatusBadge';
import {useApproval, useCatalog, useDecideApproval, useOrder, type ApprovalState, type CatalogItem, type Order} from '@/lib/api';
import {formatCountdown, formatMoney, formatTime, secondsUntil} from '@/lib/format';
import {statusView} from '@/lib/status';
import {actionSteps, decisionErrorView, effectiveState, typedApproval} from '../../approvals/_lib/approval-view';
import {useNow} from '../../approvals/_lib/useNow';
import {subjectDiffers} from '../../approvals/_components/ApprovalDecisionContent';
import {WAITING_POLL_MS} from './demo-machine';
import {DEMO_MENU, demoSizeName, type DemoMenu} from './demo-menu';

/** Order states after which nothing else happens on its own. */
const SETTLED_ORDER_STATES: readonly Order['status'][] = [
  'PAID_VERIFIED',
  'FULFILLMENT_READY',
  'REJECTED',
  'APPROVAL_EXPIRED',
  'CANCELLED',
  'UNAVAILABLE',
  'PAYMENT_FAILED',
  'RECOVERY_REQUIRED',
];

type QuoteLine = Order['quote']['lines'][number];

/**
 * The size of a quote line, for example "Large". In order: a `variationName`
 * the server may send on the line (not in the contract yet, so read with
 * care), the demo menu, the catalog, else nothing.
 */
export function lineSizeName(line: QuoteLine, menu: DemoMenu, catalog?: readonly CatalogItem[]): string | undefined {
  const sent = (line as {variationName?: unknown}).variationName;
  if (typeof sent === 'string' && sent.trim()) return sent.trim();
  const fromMenu = demoSizeName(menu, line.variationId);
  if (fromMenu) return fromMenu;
  for (const item of catalog ?? []) {
    const v = item.variations.find((x) => x.id === line.variationId);
    if (v && v.name.trim()) return v.name.trim();
  }
  return undefined;
}

/** "Large Pepperoni": the size next to the item name, unless the name already has it. */
export function lineTitle(line: QuoteLine, size: string | undefined): string {
  if (!size || /^regular$/i.test(size) || line.name.toLowerCase().includes(size.toLowerCase())) return line.name;
  return `${size} ${line.name}`;
}

/** "Mushrooms, Extra cheese", or nothing when the line has no toppings. */
export function toppingsText(line: QuoteLine): string | null {
  if (line.modifiers.length === 0) return null;
  return line.modifiers.map((m) => m.name).join(', ');
}

export type OrderCardProps = {
  businessId: string;
  approvalId: string;
  timeZone: string;
  onDecided: (approvalId: string, state: ApprovalState) => void;
  /** Tests pass a short interval. */
  pollMs?: number;
  menu?: DemoMenu;
};

export function OrderCard({businessId, approvalId, timeZone, onDecided, pollMs = WAITING_POLL_MS, menu = DEMO_MENU}: OrderCardProps) {
  const query = useApproval(businessId, approvalId);
  const approval = query.data;
  const t = approval ? typedApproval(approval) : null;
  const orderId = t?.bundleType === 'order_bundle' ? approval!.subjectId : null;
  const order = useOrder(businessId, orderId);
  const decide = useDecideApproval(businessId);
  const now = useNow(approval?.state === 'PENDING' && !decide.data);
  const inFlight = useRef(false);
  // The hash on screen when the order appeared. A refetch with another hash locks Approve.
  const [seenHash, setSeenHash] = useState<string | null>(null);
  useEffect(() => {
    if (approval && seenHash === null) setSeenHash(approval.payloadHash);
  }, [approval, seenHash]);

  const confirmed = decide.data?.approval;
  const confirmedState = confirmed?.state;

  // Sizes the demo menu cannot name come from the catalog. Only read when needed.
  const needsCatalog = !!order.data && order.data.quote.lines.some((l) => lineSizeName(l, menu) === undefined);
  const catalog = useCatalog(needsCatalog ? businessId : null);

  // Besides the live updates, read the request and the order again every few
  // seconds: until the decision, then until the order settles.
  const decidedOrDone = !!confirmedState || (approval !== undefined && approval.state !== 'PENDING');
  const orderStatus = order.data?.status;
  const orderSettled = !!orderStatus && SETTLED_ORDER_STATES.includes(orderStatus);
  const refetchApproval = query.refetch;
  const refetchOrder = order.refetch;
  useEffect(() => {
    if (decidedOrDone && orderSettled) return undefined;
    const timer = setInterval(() => {
      if (!decidedOrDone) void refetchApproval({cancelRefetch: false});
      if (orderId) void refetchOrder({cancelRefetch: false});
    }, pollMs);
    return () => clearInterval(timer);
  }, [decidedOrDone, orderSettled, orderId, pollMs, refetchApproval, refetchOrder]);

  const unreachable = !!query.error || !!order.error;

  if (!approval || !t) {
    // Never an error page on stage: keep trying, with one small line.
    return (
      <Card variant="muted">
        <VStack gap={2}>
          <LoadingState label="Loading the new order" />
          {query.error ? <Text type="supporting">The server could not be reached. Still trying.</Text> : null}
        </VStack>
      </Card>
    );
  }
  if (t.bundleType !== 'order_bundle') return null;

  const payload = t.payload;
  const state = effectiveState(approval, now);
  const shownState: ApprovalState = confirmedState ?? state;
  const payloadChanged = seenHash !== null && seenHash !== approval.payloadHash;
  const mismatch = subjectDiffers(t, order.data, undefined);
  const unknownStep = actionSteps(t).some((s) => s.isUnknown);
  const errorView = decide.error ? decisionErrorView(decide.error) : null;
  const lockedByError = errorView !== null && errorView.next !== 'retry';
  const canApprove =
    state === 'PENDING' && !confirmed && !decide.isPending && !payloadChanged && !mismatch && !unknownStep && !lockedByError && !!order.data;

  const approve = () => {
    if (!canApprove || inFlight.current) return;
    inFlight.current = true;
    decide.mutate(
      // Always the stored hash of the order shown, never recomputed. The hook keeps one Idempotency-Key per approval, decision and hash.
      {approvalId: approval.id, decision: 'approve', payloadHash: approval.payloadHash},
      {
        onSuccess: (res) => onDecided(res.approval.id, res.approval.state),
        onSettled: () => {
          inFlight.current = false;
        },
      },
    );
  };

  const approvalView = statusView('approval', shownState);
  const orderView = order.data ? statusView('order', order.data.status) : null;

  return (
    <Card elevation="low">
      <Grid columns={{minWidth: 320, max: 2}} gap={5}>
        <VStack gap={3}>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Heading level={2}>New order</Heading>
            <StatusBadge label={approvalView.label} tone={approvalView.tone} />
            {state === 'PENDING' && !confirmed ? (
              <Text type="large" hasTabularNumbers color="secondary">
                {`Expires in ${formatCountdown(secondsUntil(approval.expiresAt, now))}`}
              </Text>
            ) : null}
          </HStack>
          {order.data ? (
            <>
              <VStack gap={0.5}>
                <Text type="display-3" weight="semibold">
                  {order.data.contact.name}
                </Text>
                <Text type="display-3">{`Pickup at ${formatTime(payload.pickupAt, timeZone)}`}</Text>
              </VStack>
              <VStack gap={2}>
                {order.data.quote.lines.map((line, i) => {
                  const toppings = toppingsText(line);
                  const title = lineTitle(line, lineSizeName(line, menu, catalog.data?.items));
                  return (
                    <HStack key={`${line.variationId}-${i}`} gap={3} justify="between" vAlign="start">
                      <VStack gap={0}>
                        <Text type="display-3">{`${line.quantity} x ${title}`}</Text>
                        <Text type="large" weight="normal" color="secondary">
                          {toppings ? `Toppings: ${toppings}` : 'No toppings'}
                        </Text>
                      </VStack>
                      <Text type="large" hasTabularNumbers>
                        {formatMoney(line.lineTotalMinor, order.data!.quote.currency)}
                      </Text>
                    </HStack>
                  );
                })}
              </VStack>
            </>
          ) : (
            <LoadingState label="Loading the order lines" />
          )}
          {unreachable ? <Text type="supporting">The server could not be reached. Still trying.</Text> : null}
        </VStack>

        <VStack gap={4} vAlign="center">
          <VStack gap={1}>
            <HStack gap={2} vAlign="center">
              <Text type="label" color="secondary">
                Total
              </Text>
              <SandboxBadge />
            </HStack>
            <Text type="display-1" weight="semibold" hasTabularNumbers>
              {formatMoney(payload.totalMinor, payload.currency)}
            </Text>
          </VStack>

          <Decision
            shownState={shownState}
            confirmed={!!confirmed}
            canApprove={canApprove}
            isPending={decide.isPending}
            onApprove={approve}
            notice={
              errorView ? (
                <Banner
                  status={errorView.status}
                  title={errorView.title}
                  description={errorView.message}
                  endContent={errorView.next === 'retry' ? <Button label="Try again" onClick={approve} isDisabled={decide.isPending} /> : undefined}
                />
              ) : state === 'EXPIRED' && !confirmed ? (
                <Banner status="warning" title="This order expired before it was approved, so nothing was charged." />
              ) : payloadChanged ? (
                <Banner
                  status="warning"
                  title="This order changed after it appeared, so it was not approved."
                  endContent={<Button label="Show the new version" onClick={() => setSeenHash(approval.payloadHash)} />}
                />
              ) : mismatch || unknownStep ? (
                <Banner
                  status="error"
                  title="This order does not match its request, so Approve is off."
                  endContent={<Button label="Open in Approvals" href={`/approvals?id=${encodeURIComponent(approval.id)}`} />}
                />
              ) : null
            }
          />

          {confirmed && orderView ? (
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Text type="large">Now:</Text>
              <StatusBadge label={orderView.label} tone={orderView.tone} />
            </HStack>
          ) : null}
        </VStack>
      </Grid>
    </Card>
  );
}

function Decision({
  shownState,
  confirmed,
  canApprove,
  isPending,
  onApprove,
  notice,
}: {
  shownState: ApprovalState;
  confirmed: boolean;
  canApprove: boolean;
  isPending: boolean;
  onApprove: () => void;
  notice: ReactNode;
}) {
  // "Approved" only from the server's answer to this decision or a stored decision it reports.
  if (shownState === 'APPROVED') {
    return (
      <HStack gap={3} vAlign="center">
        <Icon icon="success" color="success" size="lg" />
        <Text type="display-1" weight="semibold">
          Approved
        </Text>
      </HStack>
    );
  }
  if (confirmed || shownState !== 'PENDING') {
    const view = statusView('approval', shownState);
    return (
      <VStack gap={2}>
        <Text type="display-3" weight="semibold">
          {view.label}
        </Text>
        {notice}
      </VStack>
    );
  }
  return (
    <VStack gap={3}>
      <Button label="Approve" variant="primary" size="lg" width="100%" onClick={onApprove} isDisabled={!canApprove && !isPending} isLoading={isPending} />
      {notice}
    </VStack>
  );
}
