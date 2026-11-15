'use client';

/**
 * The Approve flow the two finale cards share (OrderCard for the pizza place,
 * BookingCard for the barbershop and the salon): one decision per click, the
 * stored payload hash, an "Approving" hold so the room sees the step, and the
 * green "Approved" block only after the server has confirmed the decision.
 */

import {useEffect, useRef, useState, type ReactNode} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {HStack} from '@astryxdesign/core/HStack';
import {Icon} from '@astryxdesign/core/Icon';
import {Spinner} from '@astryxdesign/core/Spinner';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {useDecideApproval, type ApprovalRequest, type ApprovalState} from '@/lib/api';
import {statusView} from '@/lib/status';
import {decisionErrorView, effectiveState} from '../../approvals/_lib/approval-view';
import {useNow} from '../../approvals/_lib/useNow';

/**
 * The block that takes the place of the Approve button once the server has
 * confirmed the decision, so the room sees the button turn green. Green is
 * allowed here because the decision is confirmed (see StatusBadge). The
 * keyframes are in app/globals.css.
 */
const APPROVED_STYLE = {
  backgroundColor: 'var(--color-success)',
  borderColor: 'var(--color-success)',
  color: 'var(--color-on-success)',
  animation: 'abos-approved-in var(--duration-medium) var(--ease-entrance) both',
} as const;

/** The words that differ between an order and a booking. */
export type DecisionWording = {
  noun: 'order' | 'booking';
  /** "Approving the order" */
  approving: string;
  /** "The shop accepted this order" */
  accepted: string;
  /** Said when the request expired before the click. */
  expired: string;
};

export const ORDER_WORDING: DecisionWording = {
  noun: 'order',
  approving: 'Approving the order',
  accepted: 'The shop accepted this order',
  expired: 'This order expired before it was approved, so nothing was charged.',
};

export const BOOKING_WORDING: DecisionWording = {
  noun: 'booking',
  approving: 'Approving the booking',
  accepted: 'The shop accepted this booking',
  expired: 'This booking expired before it was approved, so nothing was booked.',
};

export type ApproveFlowOptions = {
  businessId: string;
  approval: ApprovalRequest | undefined;
  approveHoldMs: number;
  onDecided: (approvalId: string, state: ApprovalState) => void;
  /** True once the card has loaded its order or booking and found it matches the request. */
  subjectReady: boolean;
};

export function useApproveFlow({businessId, approval, approveHoldMs, onDecided, subjectReady}: ApproveFlowOptions) {
  const decide = useDecideApproval(businessId);
  const now = useNow(approval?.state === 'PENDING' && !decide.data);
  const inFlight = useRef(false);
  // After the click, "Approving" shows for at least approveHoldMs, so the room sees the step.
  // The result is never shown early: it shows once the server has answered and the hold is over.
  const [holding, setHolding] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
    },
    [],
  );
  // The hash on screen when the request appeared. A refetch with another hash locks Approve.
  const [seenHash, setSeenHash] = useState<string | null>(null);
  useEffect(() => {
    if (approval && seenHash === null) setSeenHash(approval.payloadHash);
  }, [approval, seenHash]);

  const confirmed = decide.data?.approval;
  const confirmedState = confirmed?.state;
  const decidedOrDone = !!confirmedState || (approval !== undefined && approval.state !== 'PENDING');
  const state: ApprovalState | null = approval ? effectiveState(approval, now) : null;
  const shownState: ApprovalState | null = confirmedState ?? state;
  const payloadChanged = !!approval && seenHash !== null && seenHash !== approval.payloadHash;
  const errorView = decide.error ? decisionErrorView(decide.error) : null;
  const lockedByError = errorView !== null && errorView.next !== 'retry';
  const canApprove = state === 'PENDING' && !confirmed && !decide.isPending && !payloadChanged && !lockedByError && subjectReady;

  const approve = () => {
    if (!approval || !canApprove || inFlight.current) return;
    inFlight.current = true;
    if (approveHoldMs > 0) {
      setHolding(true);
      if (holdTimer.current) clearTimeout(holdTimer.current);
      holdTimer.current = setTimeout(() => setHolding(false), approveHoldMs);
    }
    decide.mutate(
      // Always the stored hash of the request shown, never recomputed. The hook keeps one Idempotency-Key per approval, decision and hash.
      {approvalId: approval.id, decision: 'approve', payloadHash: approval.payloadHash},
      {
        onSuccess: (res) => onDecided(res.approval.id, res.approval.state),
        onSettled: () => {
          inFlight.current = false;
        },
      },
    );
  };

  const working = decide.isPending || holding;
  return {
    now,
    state,
    shownState,
    confirmed: !!confirmed,
    decidedOrDone,
    payloadChanged,
    errorView,
    canApprove,
    approve,
    working,
    isDecidePending: decide.isPending,
    showNewVersion: () => {
      if (approval) setSeenHash(approval.payloadHash);
    },
  };
}

export type ApproveFlow = ReturnType<typeof useApproveFlow>;

/** The warning or error under the button, if any. `mismatch` turns Approve off and points to Approvals. */
export function decisionNotice(flow: ApproveFlow, wording: DecisionWording, approvalId: string, mismatch: boolean): ReactNode {
  const {errorView} = flow;
  if (errorView) {
    return (
      <Banner
        status={errorView.status}
        title={errorView.title}
        description={errorView.message}
        endContent={errorView.next === 'retry' ? <Button label="Try again" onClick={flow.approve} isDisabled={flow.isDecidePending} /> : undefined}
      />
    );
  }
  if (flow.state === 'EXPIRED' && !flow.confirmed) return <Banner status="warning" title={wording.expired} />;
  if (flow.payloadChanged) {
    return (
      <Banner
        status="warning"
        title={`This ${wording.noun} changed after it appeared, so it was not approved.`}
        endContent={<Button label="Show the new version" onClick={flow.showNewVersion} />}
      />
    );
  }
  if (mismatch) {
    return (
      <Banner
        status="error"
        title={`This ${wording.noun} does not match its request, so Approve is off.`}
        endContent={<Button label="Open in Approvals" href={`/approvals?id=${encodeURIComponent(approvalId)}`} />}
      />
    );
  }
  return null;
}

export function Decision({
  flow,
  wording,
  notice,
}: {
  flow: ApproveFlow;
  wording: DecisionWording;
  notice: ReactNode;
}) {
  const shownState = flow.shownState ?? 'PENDING';
  // The decision is on its way, or it came back sooner than the room could see.
  if (flow.working) {
    return (
      <Card variant="muted" padding={5} role="status">
        <HStack gap={3} vAlign="center" justify="center">
          <Spinner size="xl" aria-label="Approving" />
          <Text type="display-2" weight="semibold">
            {wording.approving}
          </Text>
        </HStack>
      </Card>
    );
  }
  // "Approved" only from the server's answer to this decision or a stored decision it reports.
  if (shownState === 'APPROVED') {
    return (
      <Card padding={5} style={APPROVED_STYLE} role="status">
        <VStack gap={1} hAlign="center">
          <HStack gap={3} vAlign="center" justify="center">
            <Icon icon="success" size="lg" />
            <Text type="display-1" weight="semibold" color="inherit">
              Approved
            </Text>
          </HStack>
          <Text type="large" weight="normal" color="inherit">
            {wording.accepted}
          </Text>
        </VStack>
      </Card>
    );
  }
  if (flow.confirmed || shownState !== 'PENDING') {
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
      <Button label="Approve" variant="primary" size="lg" width="100%" onClick={flow.approve} isDisabled={!flow.canApprove} />
      {notice}
    </VStack>
  );
}
