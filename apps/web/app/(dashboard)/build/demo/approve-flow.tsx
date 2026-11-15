'use client';

/**
 * The Approve flow the two finale cards share (OrderCard for the pizza place,
 * BookingCard for the barbershop and the salon): one decision per click, the
 * stored payload hash, an "Approving" hold so the room sees the step, and the
 * green "Approved" block only after the server has confirmed the decision.
 */

import {useEffect, useRef, useState, type CSSProperties, type ReactNode} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {useDecideApproval, type ApprovalRequest, type ApprovalState} from '@/lib/api';
import {statusView} from '@/lib/status';
import {decisionErrorView, effectiveState} from '../../approvals/_lib/approval-view';
import {useNow} from '../../approvals/_lib/useNow';
import {APPROVE_HOLD_MS} from './demo-machine';

/**
 * Approve, "Approving" and "Approved" share one slot of a fixed height
 * (`.abos-decision` in app/globals.css), so nothing on the card moves between
 * them. The slot fills while the decision is on its way, then turns green.
 * Green is allowed there because the decision is confirmed (see StatusBadge).
 */
const HOLD_STYLE = {'--abos-hold': `${APPROVE_HOLD_MS}ms`} as CSSProperties;

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
      <div className="abos-decision" style={HOLD_STYLE}>
        <div className="abos-approving" role="status">
          <span className="abos-spinner" role="img" aria-label="Approving" />
          <span>{wording.approving}</span>
        </div>
      </div>
    );
  }
  // "Approved" only from the server's answer to this decision or a stored decision it reports.
  if (shownState === 'APPROVED') {
    return (
      <div className="abos-decision">
        <div className="abos-approved" role="status">
          <svg className="abos-approved-check" viewBox="0 0 24 24" aria-hidden>
            <circle cx="12" cy="12" r="10" />
            <path d="m7.4 12.4 3 3 6.2-6.6" />
          </svg>
          <span>
            <span className="abos-approved-title">Approved</span>
            <span className="abos-approved-note">{wording.accepted}</span>
          </span>
        </div>
      </div>
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
      <div className="abos-decision">
        {/* A plain button, so it can fill the slot. aria-disabled, as the Astryx Button does: the click is ignored in flow.approve. */}
        <button type="button" className="abos-approve" onClick={flow.approve} aria-disabled={flow.canApprove ? undefined : true}>
          Approve
        </button>
      </div>
      {notice}
    </VStack>
  );
}
