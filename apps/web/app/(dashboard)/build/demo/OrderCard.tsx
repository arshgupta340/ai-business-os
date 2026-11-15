'use client';

import {useEffect} from 'react';
import {Card} from '@astryxdesign/core/Card';
import {Heading} from '@astryxdesign/core/Heading';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {LoadingState} from '@/components/LoadingState';
import {SandboxBadge} from '@/components/SandboxBadge';
import {StatusBadge} from '@/components/StatusBadge';
import {useApproval, useCatalog, useOrder, type ApprovalState, type CatalogItem, type Order} from '@/lib/api';
import {formatCountdown, formatMoney, formatTime, secondsUntil} from '@/lib/format';
import {statusView} from '@/lib/status';
import {actionSteps, typedApproval} from '../../approvals/_lib/approval-view';
import {subjectDiffers} from '../../approvals/_components/ApprovalDecisionContent';
import {Decision, decisionNotice, ORDER_WORDING, useApproveFlow} from './approve-flow';
import {APPROVE_HOLD_MS, WAITING_POLL_MS} from './demo-machine';

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

/** A `variationName` the server may send on the line (not in the contract yet, so read with care). */
function sentSizeName(line: QuoteLine): string | undefined {
  const sent = (line as {variationName?: unknown}).variationName;
  return typeof sent === 'string' && sent.trim() ? sent.trim() : undefined;
}

/**
 * The size of a quote line, for example "Large". In order: a `variationName`
 * on the line, else the business catalog from the API (looked up by
 * `variationId`), else nothing.
 */
export function lineSizeName(line: QuoteLine, catalog?: readonly CatalogItem[]): string | undefined {
  const sent = sentSizeName(line);
  if (sent) return sent;
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

export type FinaleCardProps = {
  businessId: string;
  approvalId: string;
  timeZone: string;
  onDecided: (approvalId: string, state: ApprovalState) => void;
  /** Tests pass a short interval. */
  pollMs?: number;
  /** The least time "Approving" shows after the click. Tests pass 0. */
  approveHoldMs?: number;
};

export function OrderCard({businessId, approvalId, timeZone, onDecided, pollMs = WAITING_POLL_MS, approveHoldMs = APPROVE_HOLD_MS}: FinaleCardProps) {
  const query = useApproval(businessId, approvalId);
  const approval = query.data;
  const t = approval ? typedApproval(approval) : null;
  const orderId = t?.bundleType === 'order_bundle' ? approval!.subjectId : null;
  const order = useOrder(businessId, orderId);

  // Sizes the line does not name come from the catalog. Only read when needed.
  const needsCatalog = !!order.data && order.data.quote.lines.some((l) => sentSizeName(l) === undefined);
  const catalog = useCatalog(needsCatalog ? businessId : null);

  const mismatch = !!t && (subjectDiffers(t, order.data, undefined) || actionSteps(t).some((s) => s.isUnknown));
  const flow = useApproveFlow({businessId, approval, approveHoldMs, onDecided, subjectReady: !!order.data && !mismatch});

  // Besides the live updates, read the request and the order again every few
  // seconds: until the decision, then until the order settles.
  const {decidedOrDone} = flow;
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
  // While "Approving" shows, the badge keeps saying what it said before the click.
  const approvalView = statusView('approval', flow.working ? 'PENDING' : (flow.shownState ?? 'PENDING'));
  const orderView = order.data ? statusView('order', order.data.status) : null;

  // Green on the badge only once the server has answered this decision, the same rule as the Approved block.
  const isApproved = flow.confirmed && flow.shownState === 'APPROVED' && !flow.working;

  return (
    <div className="abos-arrive">
      <Card elevation="low">
        <div className="abos-card">
          <div>
            <div className="abos-card-head">
              <Heading level={2}>New order</Heading>
              <StatusBadge label={approvalView.label} tone={isApproved ? 'success' : approvalView.tone} />
              {flow.state === 'PENDING' && !flow.confirmed && !flow.working ? (
                <span className="abos-card-expires">{`Expires in ${formatCountdown(secondsUntil(approval.expiresAt, flow.now))}`}</span>
              ) : null}
            </div>
            {order.data ? (
              <>
                <div className="abos-who">{order.data.contact.name}</div>
                <div className="abos-when">{`Pickup at ${formatTime(payload.pickupAt, timeZone)}`}</div>
                <div className="abos-lines">
                  {order.data.quote.lines.map((line, i) => {
                    const toppings = toppingsText(line);
                    const title = lineTitle(line, lineSizeName(line, catalog.data?.items));
                    return (
                      <div key={`${line.variationId}-${i}`} className="abos-line">
                        <div>
                          <div>{`${line.quantity} x ${title}`}</div>
                          {toppings ? <div className="abos-line-note">{`Toppings: ${toppings}`}</div> : null}
                        </div>
                        <span className="abos-line-side">{formatMoney(line.lineTotalMinor, order.data!.quote.currency)}</span>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <LoadingState label="Loading the order lines" />
            )}
            {unreachable ? <Text type="supporting">The server could not be reached. Still trying.</Text> : null}
          </div>

          <div className="abos-card-side">
            <div>
              <div className="abos-total-label">
                <span>Total</span>
                <SandboxBadge />
              </div>
              <div className="abos-total">{formatMoney(payload.totalMinor, payload.currency)}</div>
            </div>

            <Decision flow={flow} wording={ORDER_WORDING} notice={decisionNotice(flow, ORDER_WORDING, approval.id, mismatch)} />

            {/* The row keeps its height before there is anything to say, so the card does not move. */}
            <div className="abos-now">
              {flow.confirmed && orderView && !flow.working ? (
                <>
                  <span>Now:</span>
                  <StatusBadge label={orderView.label} tone={orderView.tone} />
                </>
              ) : null}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
