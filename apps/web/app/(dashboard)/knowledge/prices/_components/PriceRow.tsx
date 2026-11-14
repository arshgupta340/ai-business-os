'use client';

import {Button} from '@astryxdesign/core/Button';
import {HStack} from '@astryxdesign/core/HStack';
import {ListItem} from '@astryxdesign/core/List';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {SandboxBadge} from '@/components/SandboxBadge';
import {StatusBadge} from '@/components/StatusBadge';
import {useApproval, type ActivityEvent} from '@/lib/api';
import {formatMoney} from '@/lib/format';
import {conflictView} from '@/lib/status';
import {minorToInput} from '../_lib/price-input';
import {canProposeAgain, failureText, phaseBadge, pricePhase, type PriceConflictView, type PricePhase} from '../_lib/price-row';
import type {PriceEditorTarget} from './PriceEditorDialog';

type Props = {
  businessId: string;
  itemName: string;
  variation: {id: string; name: string; priceMinor: number; currency: 'USD'};
  approvalId?: string;
  events: readonly ActivityEvent[];
  conflict: PriceConflictView | null;
  isCatalogFetching: boolean;
  onChange: (target: PriceEditorTarget) => void;
  onReview: (approvalId: string) => void;
  onRefreshCatalog: () => void;
};

export function PriceRow({
  businessId,
  itemName,
  variation,
  approvalId,
  events,
  conflict,
  isCatalogFetching,
  onChange,
  onReview,
  onRefreshCatalog,
}: Props) {
  const approval = useApproval(businessId, approvalId);
  const phase = pricePhase({
    approval: approval.data,
    isApprovalLoading: approval.isPending && !!approvalId,
    events,
    catalogPriceMinor: variation.priceMinor,
  });
  const badge = phaseBadge(phase);
  const target: PriceEditorTarget = {
    itemName,
    variationId: variation.id,
    variationName: variation.name,
    currentPriceMinor: variation.priceMinor,
    currency: variation.currency,
  };
  // The cached price is the price in Square unless Square took a new one the cache does not show yet.
  const priceLabel =
    phase.kind === 'sync_failed' || phase.kind === 'awaiting_catalog' ? 'Last synced price' : 'Current price in Square';

  return (
    <ListItem
      itemKey={variation.id}
      align="start"
      label={<Text weight="semibold">{variation.name}</Text>}
      description={
        <VStack gap={2}>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Text type="supporting">{priceLabel}:</Text>
            <Text weight="semibold" hasTabularNumbers>
              {formatMoney(variation.priceMinor, variation.currency)}
            </Text>
            <SandboxBadge />
            {badge ? <StatusBadge label={badge.label} tone={badge.tone} /> : null}
          </HStack>
          <PhaseNote phase={phase} onRefreshCatalog={onRefreshCatalog} isCatalogFetching={isCatalogFetching} />
          {approval.error ? <Text type="supporting">The status of this change could not be loaded. Reload the page to check it.</Text> : null}
          {conflict ? <ConflictNote conflict={conflict} phase={phase} /> : null}
          <HStack gap={2} wrap="wrap">
            {phase.kind === 'pending' && approvalId ? (
              <Button label="Review and confirm" variant="primary" size="sm" onClick={() => onReview(approvalId)} />
            ) : null}
            {canProposeAgain(phase) ? (
              <Button label="Change price" size="sm" onClick={() => onChange(target)} />
            ) : null}
            {canProposeAgain(phase) && conflict?.uploadedPriceMinor !== undefined && conflict.uploadedPriceMinor !== variation.priceMinor ? (
              <Button
                label="Use the uploaded price"
                size="sm"
                variant="secondary"
                onClick={() => onChange({...target, initialValue: minorToInput(conflict.uploadedPriceMinor!)})}
              />
            ) : null}
          </HStack>
        </VStack>
      }
    />
  );
}

function PhaseNote({phase, onRefreshCatalog, isCatalogFetching}: {phase: PricePhase; onRefreshCatalog: () => void; isCatalogFetching: boolean}) {
  switch (phase.kind) {
    case 'pending':
      return (
        <Text type="supporting">
          You proposed {formatMoney(phase.payload.newPriceMinor, phase.payload.currency)} (sandbox). Nothing changes in Square until you
          confirm.
        </Text>
      );
    case 'updating':
      return (
        <Text type="supporting">
          New price {formatMoney(phase.payload.newPriceMinor, phase.payload.currency)} (sandbox) is being sent to Square. The price above
          stays until the catalog shows the change.
        </Text>
      );
    case 'awaiting_catalog':
      return (
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Text type="supporting">
            Square accepted {formatMoney(phase.payload.newPriceMinor, phase.payload.currency)} (sandbox). Waiting for the catalog here to
            show it.
          </Text>
          <Button label="Refresh the catalog" size="sm" variant="secondary" onClick={onRefreshCatalog} isLoading={isCatalogFetching} />
        </HStack>
      );
    case 'verified':
      return <Text type="supporting">The catalog from Square now shows this price.</Text>;
    case 'square_failed':
    case 'sync_failed':
      return <Text type="supporting">{failureText(phase)}</Text>;
    case 'rejected':
      return (
        <Text type="supporting">
          You rejected {formatMoney(phase.payload.newPriceMinor, phase.payload.currency)} (sandbox). The price is unchanged.
        </Text>
      );
    case 'expired':
      return (
        <Text type="supporting">
          The request for {formatMoney(phase.payload.newPriceMinor, phase.payload.currency)} (sandbox) expired before you confirmed it.
          The price is unchanged.
        </Text>
      );
    default:
      return null;
  }
}

function ConflictNote({conflict, phase}: {conflict: PriceConflictView; phase: PricePhase}) {
  const view = conflictView('open', true);
  return (
    <VStack gap={1}>
      <HStack gap={2} vAlign="center" wrap="wrap">
        <StatusBadge label={view.label} tone={view.tone} />
        {conflict.uploadedPriceMinor !== undefined ? (
          <>
            <Text type="supporting">Your uploaded menu says</Text>
            <Text hasTabularNumbers>{formatMoney(conflict.uploadedPriceMinor)}</Text>
            <SandboxBadge />
          </>
        ) : (
          <Text type="supporting">Your uploaded menu has a different price.</Text>
        )}
      </HStack>
      {phase.kind === 'verified' ? (
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Text type="supporting">The conflict with your uploaded menu is still open. Resolve it on Business Knowledge.</Text>
          <Button label="Open Business Knowledge" size="sm" variant="secondary" href="/knowledge" />
        </HStack>
      ) : (
        <Text type="supporting">To prefer the uploaded price, change the price here. Square keeps its price until you confirm.</Text>
      )}
    </VStack>
  );
}
