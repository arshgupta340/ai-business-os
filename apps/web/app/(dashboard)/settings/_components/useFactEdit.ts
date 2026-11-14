'use client';

import {useEffect, useRef, useState} from 'react';
import {useApproval, useProposeFact, type ApprovalRequest, type BusinessFact, type FactKind, type JsonValue} from '@/lib/api';
import {effectiveState} from '../../approvals/_lib/approval-view';
import {useNow} from '../../approvals/_lib/useNow';
import {asFactEdit, editPhase, pendingEditFor, type EditPhase, type FactEditApproval} from '../_lib/settings-model';

/** How often the facts are read again while an approved change is being saved. */
const SAVING_REFETCH_MS = 1500;

export type FactEdit = {
  /** Where the newest change for this fact stands, or undefined when there is none to show. */
  phase?: EditPhase;
  approval?: FactEditApproval;
  isProposing: boolean;
  proposeError: unknown;
  /** Sends the value to facts/propose. On success the confirm dialog opens for the new approval. */
  propose: (value: unknown, onProposed?: () => void) => void;
  retryPropose: () => void;
  reopen: () => void;
  dismiss: () => void;
};

/**
 * The propose and confirm flow for one fact (kind and key). It never writes a
 * fact: it creates a fact_edit approval and opens the owner's confirm dialog.
 * The row keeps showing the verified fact from the server, so a new value
 * appears only after the approval is approved and the refetched fact says so.
 */
export function useFactEdit({
  businessId,
  kind,
  factKey,
  verified,
  pendingApprovals,
  openDialog,
  refetchFacts,
}: {
  businessId: string;
  kind: FactKind;
  factKey: string;
  verified?: BusinessFact;
  pendingApprovals: readonly ApprovalRequest[];
  openDialog: (approvalId: string) => void;
  refetchFacts: () => void;
}): FactEdit {
  const proposeMutation = useProposeFact(businessId);
  const [trackedId, setTrackedId] = useState<string>();
  const [dismissedId, setDismissedId] = useState<string>();
  const lastValue = useRef<unknown>(undefined);

  const serverPending = pendingEditFor(pendingApprovals, kind, factKey);
  const approvalId = trackedId ?? serverPending?.id;
  const query = useApproval(businessId, approvalId);
  const approval = asFactEdit(query.data);
  const now = useNow(approval?.state === 'PENDING');
  const phase = approval && approval.id !== dismissedId ? editPhase(effectiveState(approval, now), approval.payload, verified) : undefined;

  // An approved change is saved by a background step. fact.changed refetches the
  // facts when the live feed is connected; this also covers a feed that is not.
  const refetchRef = useRef(refetchFacts);
  refetchRef.current = refetchFacts;
  useEffect(() => {
    if (phase !== 'saving') return undefined;
    const timer = setInterval(() => refetchRef.current(), SAVING_REFETCH_MS);
    return () => clearInterval(timer);
  }, [phase]);

  const propose = (value: unknown, onProposed?: () => void) => {
    if (proposeMutation.isPending) return;
    lastValue.current = value;
    proposeMutation.mutate(
      // The edited value is plain JSON from the form (ProposeFactBody.value is a JsonValue).
      {kind, key: factKey, value: value as JsonValue},
      {
        onSuccess: ({approval: created}) => {
          setTrackedId(created.id);
          onProposed?.();
          openDialog(created.id);
        },
      },
    );
  };

  return {
    phase,
    approval,
    isProposing: proposeMutation.isPending,
    proposeError: proposeMutation.error,
    propose,
    retryPropose: () => {
      if (lastValue.current !== undefined) propose(lastValue.current);
    },
    reopen: () => {
      if (approvalId) openDialog(approvalId);
    },
    dismiss: () => setDismissedId(approvalId),
  };
}
