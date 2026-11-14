'use client';

import {Fragment, useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import {Divider} from '@astryxdesign/core/Divider';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/HStack';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {VStack} from '@astryxdesign/core/VStack';
import {SandboxBadge} from '@/components/SandboxBadge';
import {StatusBadge} from '@/components/StatusBadge';
import type {ApprovalRequest, BusinessFact} from '@/lib/api';
import {statusView} from '@/lib/status';
import {
  KIND_LABELS,
  describeValue,
  factKeyLabel,
  groupKnowledge,
  sourceTypeLabel,
  type KnowledgeKind,
  type KnowledgeRow,
} from '../../knowledge/_components/knowledge-model';
import {checkMinutesInput, policyShape, type PolicyShape} from '../_lib/settings-model';
import {EditNotice} from './EditNotice';
import {RequestError} from './RequestError';
import {useFactEdit} from './useFactEdit';

type Props = {
  businessId: string;
  facts: readonly BusinessFact[];
  pendingApprovals: readonly ApprovalRequest[];
  openDialog: (approvalId: string) => void;
  refetchFacts: () => void;
};

const OTHER_KINDS = ['policy', 'service', 'faq', 'contact'] as const satisfies readonly KnowledgeKind[];

/**
 * Policies, services, questions and contact facts. Only verified facts are
 * listed. A policy with a simple value (minutes, or allowed yes or no) can be
 * changed through the same propose and confirm flow. Everything else is read-only.
 */
export function OtherFactsSection(props: Props) {
  const groups = groupKnowledge(props.facts);
  const visible = OTHER_KINDS.filter((kind) => groups[kind].some((r) => r.verified));
  if (!visible.length) return <Text type="supporting">No other business facts yet.</Text>;
  return (
    <VStack gap={5}>
      {visible.map((kind) => (
        <VStack key={kind} gap={3}>
          <Heading level={3}>{KIND_LABELS[kind]}</Heading>
          {kind === 'service' ? <Text type="supporting">Service prices are sandbox payment data.</Text> : null}
          {kind !== 'policy' ? <Text type="supporting">Shown to read only. They cannot be changed on this page.</Text> : null}
          <VStack gap={3}>
            {groups[kind]
              .filter((r) => r.verified)
              .map((row, i) => (
                <Fragment key={row.key}>
                  {i > 0 ? <Divider /> : null}
                  {kind === 'policy' && policyShape(row.verified!.value) ? (
                    <PolicyRow {...props} row={row} />
                  ) : (
                    <FactLine kind={kind} fact={row.verified!} />
                  )}
                </Fragment>
              ))}
          </VStack>
        </VStack>
      ))}
    </VStack>
  );
}

function FactSummary({kind, fact}: {kind: KnowledgeKind; fact: BusinessFact}) {
  const value = describeValue(kind, fact.value);
  return (
    <VStack gap={0.5}>
      <Text weight="medium">{factKeyLabel(kind, fact.key, fact.value)}</Text>
      <HStack gap={1} vAlign="center" wrap="wrap">
        <Text>{value.text}</Text>
        {value.hasMoney ? <SandboxBadge /> : null}
      </HStack>
      <Text type="supporting">{`${sourceTypeLabel(fact.sourceType)}, version ${fact.version}`}</Text>
    </VStack>
  );
}

function FactLine({kind, fact}: {kind: KnowledgeKind; fact: BusinessFact}) {
  const status = statusView('fact', fact.status);
  return (
    <HStack gap={3} vAlign="center" justify="between" wrap="wrap">
      <FactSummary kind={kind} fact={fact} />
      <StatusBadge label={status.label} tone={status.tone} />
    </HStack>
  );
}

function PolicyRow({businessId, pendingApprovals, openDialog, refetchFacts, row}: Props & {row: KnowledgeRow}) {
  const fact = row.verified!;
  const edit = useFactEdit({businessId, kind: 'policy', factKey: row.key, verified: fact, pendingApprovals, openDialog, refetchFacts});
  const [editing, setEditing] = useState(false);
  const busy = edit.phase === 'waiting' || edit.phase === 'saving';
  const status = statusView('fact', fact.status);
  const label = factKeyLabel('policy', row.key, fact.value);
  const shape = policyShape(fact.value)!;

  return (
    <VStack gap={2}>
      <HStack gap={3} vAlign="center" justify="between" wrap="wrap">
        <FactSummary kind="policy" fact={fact} />
        <HStack gap={2} vAlign="center">
          <StatusBadge label={status.label} tone={status.tone} />
          {!editing ? (
            <Button
              label={`Edit ${label}`}
              size="sm"
              onClick={() => setEditing(true)}
              isDisabled={busy || edit.isProposing}
            />
          ) : null}
        </HStack>
      </HStack>
      <EditNotice edit={edit} describe={(v) => describeValue('policy', v).text} subject={label} />
      {editing ? (
        <PolicyEditor
          label={label}
          shape={shape}
          isSending={edit.isProposing}
          onCancel={() => setEditing(false)}
          onSubmit={(value) => edit.propose(value, () => setEditing(false))}
        />
      ) : null}
      {edit.proposeError ? (
        <RequestError title="The change was not sent" error={edit.proposeError} onRetry={edit.retryPropose} />
      ) : null}
    </VStack>
  );
}

function PolicyEditor({
  label,
  shape,
  isSending,
  onCancel,
  onSubmit,
}: {
  label: string;
  shape: PolicyShape;
  isSending: boolean;
  onCancel: () => void;
  onSubmit: (value: unknown) => void;
}) {
  const [minutes, setMinutes] = useState(shape.type === 'minutes' ? String(shape.minutes) : '');
  const [allowed, setAllowed] = useState(shape.type === 'allowed' ? shape.allowed : false);
  const [error, setError] = useState<string>();

  const submit = () => {
    if (shape.type === 'minutes') {
      const check = checkMinutesInput(minutes, shape.minutes);
      if (!check.ok) return setError(check.error);
      setError(undefined);
      return onSubmit(check.value);
    }
    if (allowed === shape.allowed) return setError('This is already the current value.');
    setError(undefined);
    onSubmit({allowed});
  };

  return (
    <VStack gap={3}>
      {shape.type === 'minutes' ? (
        <TextInput
          label={`${label} in minutes`}
          value={minutes}
          onChange={setMinutes}
          status={error ? {type: 'error', message: error} : undefined}
          statusVariant="detached"
          isDisabled={isSending}
        />
      ) : (
        <CheckboxInput
          label={`${label} allowed`}
          value={allowed}
          onChange={setAllowed}
          status={error ? {type: 'error', message: error} : undefined}
          isDisabled={isSending}
        />
      )}
      <Text type="supporting">Nothing changes until you confirm the change in the next step.</Text>
      <HStack gap={2} wrap="wrap">
        <Button label="Cancel" variant="ghost" onClick={onCancel} isDisabled={isSending} />
        <Button label="Review change" variant="primary" onClick={submit} isLoading={isSending} isDisabled={isSending} />
      </HStack>
    </VStack>
  );
}
