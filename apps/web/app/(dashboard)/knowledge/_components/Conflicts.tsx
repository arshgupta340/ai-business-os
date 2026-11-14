'use client';

import {useState} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Grid} from '@astryxdesign/core/Grid';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import {SandboxBadge} from '@/components/SandboxBadge';
import {StatusBadge} from '@/components/StatusBadge';
import {
  isApiError,
  useFile,
  useProposeFact,
  useResolveConflict,
  type ApprovalRequest,
  type BusinessFact,
  type CatalogItem,
  type FactConflict,
} from '@/lib/api';
import {formatMoney} from '@/lib/format';
import {conflictView} from '@/lib/status';
import {ApiErrorBanner, isResolveOnFactsList} from './ApiErrorBanner';
import {ProposalNotice} from './ProposalNotice';
import {factKeyLabel, factKindGroupLabel, factSourceLabel} from '@/lib/labels';
import {
  conflictVariationId,
  describeValue,
  findVariation,
  isPriceConflict,
  splitCandidates,
  summarizeConflicts,
} from './knowledge-model';

/** The banner at the top of the screen. It only reads the server's open conflicts. */
export function ConflictBanner({conflicts}: {conflicts: readonly FactConflict[]}) {
  const summary = summarizeConflicts(conflicts);
  if (summary.openCount === 0) return null;
  const count = summary.openCount === 1 ? '1 conflict is open' : `${summary.openCount} conflicts are open`;
  return (
    <Banner
      status={summary.blocksPublish ? 'error' : 'warning'}
      title={count}
      description={
        summary.blocksPublish
          ? `Publish is blocked while a required conflict is open. ${summary.requiredOpenCount} of them ${
              summary.requiredOpenCount === 1 ? 'is' : 'are'
            } required. Review them below.`
          : 'None of them is required, so they do not block publish. Review them below.'
      }
      container="card"
    />
  );
}

type CardProps = {
  businessId: string;
  conflict: FactConflict;
  facts: readonly BusinessFact[];
  catalog: readonly CatalogItem[] | undefined;
  onResolved: (conflict: FactConflict) => void;
  onRefetch: () => void;
};

/** Both candidates side by side, and the actions the documents allow for this kind of conflict. */
export function ConflictCard({businessId, conflict, facts, catalog, onResolved, onRefetch}: CardProps) {
  const resolve = useResolveConflict(businessId);
  const propose = useProposeFact(businessId);
  const [approval, setApproval] = useState<Pick<ApprovalRequest, 'id' | 'state'> | null>(null);
  const {uploaded, authority} = splitCandidates(conflict);
  const uploadedFact = uploaded?.factId ? facts.find((f) => f.id === uploaded.factId) : undefined;
  const file = useFile(businessId, uploadedFact?.fileId);
  const price = isPriceConflict(conflict);
  const view = conflictView(conflict.state, conflict.required);
  const match = price ? findVariation(catalog, conflictVariationId(conflict)) : undefined;
  const subject = match
    ? `${match.item.name}, ${match.variation.name}`
    : factKeyLabel(conflict.kind, conflict.key, uploadedFact?.value ?? uploaded?.value);
  const authorityName = authority ? factSourceLabel(authority.sourceType) : 'the current value';
  const keepLabel = price && authority?.sourceType === 'square' ? 'Keep the Square price' : 'Keep the current value';
  const busy = resolve.isPending || propose.isPending;

  // On a server whose resolve route cannot reach this conflict, the kept value
  // goes through facts/propose with resolvesConflictId instead: a fact_edit
  // approval that resolves the conflict only when the owner confirms it.
  const proposeKept = () => {
    if (!authority) return;
    propose.mutate(
      {resolvesConflictId: conflict.id, value: authority.value, reason: 'Kept the current value'},
      {
        onSuccess: ({approval: created}) => setApproval({id: created.id, state: created.state}),
        onError: (error) => {
          if (isApiError(error) && error.code === 'INVALID_STATE') onRefetch();
        },
      },
    );
  };

  const keep = () =>
    resolve.mutate(
      {conflictId: conflict.id},
      {
        onSuccess: ({conflict: answered}) => onResolved(answered),
        onError: (error) => {
          if (isResolveOnFactsList(error)) {
            // A price comes from Square and is never a fact edit, so only other kinds go through propose.
            if (!price) proposeKept();
            return;
          }
          if (isApiError(error) && (error.code === 'INVALID_STATE' || error.code === 'NOT_FOUND')) onRefetch();
        },
      },
    );
  const viaFactsList = isResolveOnFactsList(resolve.error);

  const useUploaded = () => {
    if (!uploaded) return;
    propose.mutate(
      {resolvesConflictId: conflict.id, value: uploaded.value, reason: 'Chose the uploaded value'},
      {
        onSuccess: ({approval: created}) => setApproval({id: created.id, state: created.state}),
        onError: (error) => {
          if (isApiError(error) && error.code === 'INVALID_STATE') onRefetch();
        },
      },
    );
  };

  return (
    <Card>
      <VStack gap={3}>
        <HStack gap={2} vAlign="center" justify="between" wrap="wrap">
          <VStack gap={0.5}>
            <Heading level={3}>{subject}</Heading>
            <Text type="supporting">
              {price ? 'Menu price' : factKindGroupLabel(conflict.kind)}, key {conflict.key}
            </Text>
          </VStack>
          <StatusBadge label={view.label} tone={view.tone} />
        </HStack>

        <Grid columns={{minWidth: 220, max: 2}} gap={3}>
          <CandidateCard
            title="In your uploaded file"
            kind={conflict.kind}
            value={uploaded?.value}
            source={`${uploaded ? factSourceLabel(uploaded.sourceType) : 'Uploaded file'}${
              file.data ? `: ${file.data.name}` : ''
            }${uploaded?.sourceRef ? `, reference ${uploaded.sourceRef}` : ''}`}
          />
          <CandidateCard
            title={price ? 'In Square (the price source)' : `Current value (${authorityName})`}
            kind={conflict.kind}
            value={authority?.value}
            source={`${authorityName}${authority?.sourceRef ? `, reference ${authority.sourceRef}` : ''}`}
            extra={match ? `Catalog price now: ${formatMoney(match.variation.priceMinor, match.variation.currency)}` : undefined}
          />
        </Grid>

        {approval ? (
          <VStack gap={1}>
            {viaFactsList ? (
              <Text type="body">
                A confirmation is waiting in Approvals. The conflict stays open until you confirm the change there.
              </Text>
            ) : null}
            <ProposalNotice approval={approval} />
          </VStack>
        ) : (
          <VStack gap={2}>
            <HStack gap={2} wrap="wrap">
              <Button label={keepLabel} variant="primary" isLoading={resolve.isPending} isDisabled={busy} onClick={keep} />
              {!price && uploaded ? (
                <Button
                  label="Use the uploaded value"
                  isLoading={propose.isPending}
                  isDisabled={busy}
                  onClick={useUploaded}
                />
              ) : null}
            </HStack>
            {price ? (
              <Text type="supporting">
                To use the uploaded price instead, change the price in Square, then run Sync from Square in the catalog
                below. A price is never changed from a file.
              </Text>
            ) : (
              <Text type="supporting">
                Keeping the current value needs no confirmation. Using the uploaded value creates a change that you
                confirm first.
              </Text>
            )}
          </VStack>
        )}
        {resolve.error && !viaFactsList ? <ApiErrorBanner title="The conflict was not resolved" error={resolve.error} /> : null}
        {viaFactsList && price ? (
          <VStack gap={1}>
            <ApiErrorBanner title="The conflict was not resolved" error={resolve.error} />
            <Text type="supporting">
              A price conflict cannot be resolved from this screen on this server yet. Nothing changed, and the Square price is
              still the one your agents use.
            </Text>
          </VStack>
        ) : null}
        {propose.error ? <ApiErrorBanner title="The change was not sent" error={propose.error} /> : null}
      </VStack>
    </Card>
  );
}

function CandidateCard({
  title,
  kind,
  value,
  source,
  extra,
}: {
  title: string;
  kind: FactConflict['kind'];
  value: unknown;
  source: string;
  extra?: string;
}) {
  const text = describeValue(kind, value);
  return (
    <Card variant="muted" padding={3}>
      <VStack gap={1}>
        <Text type="label">{title}</Text>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Text weight="semibold">{text.text}</Text>
          {text.hasMoney ? <SandboxBadge /> : null}
        </HStack>
        <Text type="supporting">Source: {source}</Text>
        {extra ? <Text type="supporting">{extra}</Text> : null}
      </VStack>
    </Card>
  );
}
