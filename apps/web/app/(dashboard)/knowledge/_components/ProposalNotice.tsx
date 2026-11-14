'use client';

import {Button} from '@astryxdesign/core/Button';
import {HStack} from '@astryxdesign/core/HStack';
import {Text} from '@astryxdesign/core/Text';
import {StatusBadge} from '@/components/StatusBadge';
import type {ApprovalRequest} from '@/lib/api';
import {statusView} from '@/lib/status';

/**
 * Shown after facts/propose answered: the change is a fact_edit approval that
 * the owner confirms on the Approvals screen. Nothing is verified yet.
 */
export function ProposalNotice({approval}: {approval: Pick<ApprovalRequest, 'id' | 'state'>}) {
  const view = statusView('approval', approval.state);
  return (
    <HStack gap={2} vAlign="center" wrap="wrap">
      <StatusBadge label={view.label} tone={view.tone} />
      <Text type="supporting">Nothing changes until you confirm it.</Text>
      <Button
        label="Open the confirmation"
        variant="primary"
        size="sm"
        href={`/approvals?id=${encodeURIComponent(approval.id)}`}
      />
    </HStack>
  );
}
