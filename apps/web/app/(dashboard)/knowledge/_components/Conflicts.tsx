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
import {ApiErrorBanner} from './ApiErrorBanner';
import {ProposalNotice} from './ProposalNotice';
import {
  KIND_LABELS,
  describeValue,
  factKeyLabel,
  findVariation,
  isPriceConflict,
  sourceTypeLabel,
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
  const match = price ? findVariation(catalog, conflict.key) : undefined;
  const subject = match
    ? `${match.item.name}, ${match.variation.name}`
    : factKeyLabel(conflict.kind, conflict.key, uploadedFact?.value ?? uploaded?.value);
  const authorityName = authority ? sourceTypeLabel(authority.sourceType) : 'the current value';
  const keepLabel = price && authority?.sourceType === 'square' ? 'Keep the Square price' : 'Keep the current value';
  const busy = resolve.isPending || propose.isPending;

  const keep = () =>
    resolve.mutate(
      {conflictId: conflict.id},
      {
        onSuccess: ({conflict: answered}) => onResolved(answered),
        onError: (error) => {
          if (isApiError(error) && (error.code === 'INVALID_STATE' || error.code === 'NOT_FOUND')) onRefetch();
        },
      },
    );

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
              {price ? 'Menu price' : KIND_LABELS[conflict.kind]}, key {conflict.key}
            </Text>
          </VStack>
          <StatusBadge label={view.label} tone={view.tone} />
        </HStack>

        <Grid columns={{minWidth: 220, max: 2}} gap={3}>
          <CandidateCard
            title="In your uploaded file"
            kind={conflict.kind}
            value={uploaded?.value}
            source={`${uploaded ? sourceTypeLabel(uploaded.sourceType) : 'Uploaded file'}${
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
          <ProposalNotice approval={approval} />
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
        {resolve.error ? <ApiErrorBanner title="The conflict was not resolved" error={resolve.error} /> : null}
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
