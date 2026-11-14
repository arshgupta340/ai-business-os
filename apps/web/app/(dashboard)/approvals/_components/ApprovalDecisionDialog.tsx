'use client';

/**
 * The decision dialog for one approval request. Reusable: it takes an
 * approval ID and a business ID, loads what it needs and reports the outcome
 * through callbacks. It does not depend on the Approvals inbox page.
 *
 * Safety rules it keeps (AGENTS.md):
 * - It shows the hashed payload and sends the stored payloadHash unchanged.
 * - If the payload changes while it is open, the buttons lock until the owner
 *   has seen the new details.
 * - Both buttons are disabled while a decision is in flight, and a second fast
 *   press is ignored. useDecideApproval keeps the Idempotency-Key stable.
 * - "Approved" is shown only from the state the server returns, in the info tone.
 */

import {Dialog} from '@astryxdesign/core/Dialog';
import {ApprovalDecisionContent, type ApprovalDecisionContentProps} from './ApprovalDecisionContent';

export type ApprovalDecisionDialogProps = ApprovalDecisionContentProps & {
  isOpen: boolean;
};

export function ApprovalDecisionDialog({isOpen, onClose, ...rest}: ApprovalDecisionDialogProps) {
  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      width={680}
      maxHeight="90dvh"
      purpose="form">
      {isOpen ? <ApprovalDecisionContent onClose={onClose} {...rest} /> : null}
    </Dialog>
  );
}

export type {ApprovalDecisionContentProps, DecisionOutcome} from './ApprovalDecisionContent';
