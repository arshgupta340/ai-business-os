'use client';

import {useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {HStack} from '@astryxdesign/core/HStack';
import {Switch} from '@astryxdesign/core/Switch';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {VStack} from '@astryxdesign/core/VStack';
import {SandboxBadge} from '@/components/SandboxBadge';
import {StatusBadge} from '@/components/StatusBadge';
import {isApiError, useProposeFact, type ApprovalRequest, type BusinessFact, type FactConflict, type JsonValue} from '@/lib/api';
import {statusView} from '@/lib/status';
import {ApiErrorBanner} from './ApiErrorBanner';
import {ProposalNotice} from './ProposalNotice';
import {factKeyLabel, factKindGroupLabel} from '@/lib/labels';
import {
  applyEdits,
  describeValue,
  editableFields,
  formatConfidence,
  isLowConfidence,
  isPriceConflict,
  type FieldInput,
} from './knowledge-model';

type Props = {
  businessId: string;
  fact: BusinessFact;
  fileName?: string;
  /** The open conflict this draft takes part in, if any. */
  conflict?: FactConflict;
  onRefetch: () => void;
};

/**
 * One draft fact from an uploaded file. Every value is rendered as plain text
 * inside a Text node: file content is data, never markup or a link.
 */
export function DraftFactRow({businessId, fact, fileName, conflict, onRefetch}: Props) {
  const propose = useProposeFact(businessId);
  const [approval, setApproval] = useState<Pick<ApprovalRequest, 'id' | 'state'> | null>(null);
  const [editing, setEditing] = useState(false);
  const [inputs, setInputs] = useState<FieldInput>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const valueText = describeValue(fact.kind, fact.value);
  const factView = statusView('fact', fact.status);
  const low = isLowConfidence(fact);
  const fields = editableFields(fact.value);
  const isMenuItem = fact.kind === 'menu_item';
  const priceConflict = conflict ? isPriceConflict(conflict) : false;

  const send = (value: unknown, reason: string) => {
    // A draft in an open conflict is confirmed by choosing it for that conflict,
    // so the conflict closes when the owner approves the edit.
    // The edited value is plain JSON from the form (ProposeFactBody.value is a JsonValue).
    const json = value as JsonValue;
    const body = conflict && !priceConflict ? {resolvesConflictId: conflict.id, value: json, reason} : {kind: fact.kind, key: fact.key, value: json, reason};
    propose.mutate(body, {
      onSuccess: ({approval: created}) => {
        setApproval({id: created.id, state: created.state});
        setEditing(false);
      },
      onError: (error) => {
        if (isApiError(error) && error.code === 'INVALID_STATE') onRefetch();
      },
    });
  };

  const submitCorrection = () => {
    const result = applyEdits(fact.value, inputs);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    send(result.value, fileName ? `Corrected from ${fileName}` : 'Corrected from an uploaded file');
  };

  return (
    <Card padding={3}>
      <VStack gap={2}>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Text weight="semibold">
            {factKindGroupLabel(fact.kind)}: {factKeyLabel(fact.kind, fact.key, fact.value)}
          </Text>
          <StatusBadge label={factView.label} tone={factView.tone} />
          {low ? <StatusBadge label="Please confirm" tone="warning" /> : null}
        </HStack>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Text>{valueText.text}</Text>
          {valueText.hasMoney ? <SandboxBadge /> : null}
        </HStack>
        <Text type="supporting">
          Source: {fileName ?? 'Uploaded file'}
          {fact.sourceRef ? `, reference ${fact.sourceRef}` : ''}. Confidence {formatConfidence(fact.confidence)}.
        </Text>

        {isMenuItem ? (
          <Text type="supporting">
            Menu prices from a file are drafts for comparison only. Prices always come from Square.
          </Text>
        ) : approval ? (
          <ProposalNotice approval={approval} />
        ) : editing && fields ? (
          <VStack gap={2}>
            {fields.map((field) =>
              field.type === 'boolean' ? (
                <Switch
                  key={field.name}
                  label={field.label}
                  value={inputs[field.name] === undefined ? Boolean(field.value) : inputs[field.name] === true}
                  onChange={(checked) => setInputs((prev) => ({...prev, [field.name]: checked}))}
                />
              ) : (
                <TextInput
                  key={field.name}
                  label={field.label}
                  value={String(inputs[field.name] ?? field.value)}
                  onChange={(text) => setInputs((prev) => ({...prev, [field.name]: text}))}
                  status={errors[field.name] ? {type: 'error', message: errors[field.name]} : undefined}
                />
              ),
            )}
            <HStack gap={2} wrap="wrap">
              <Button label="Send the correction" variant="primary" isLoading={propose.isPending} onClick={submitCorrection} />
              <Button label="Cancel" variant="ghost" isDisabled={propose.isPending} onClick={() => setEditing(false)} />
            </HStack>
          </VStack>
        ) : (
          <HStack gap={2} wrap="wrap">
            <Button
              label={conflict ? 'Use the uploaded value' : 'Confirm'}
              variant="primary"
              size="sm"
              isLoading={propose.isPending}
              onClick={() => send(fact.value, fileName ? `Confirmed from ${fileName}` : 'Confirmed from an uploaded file')}
            />
            {fields ? (
              <Button
                label="Correct it"
                size="sm"
                isDisabled={propose.isPending}
                onClick={() => {
                  setInputs({});
                  setErrors({});
                  setEditing(true);
                }}
              />
            ) : null}
          </HStack>
        )}
        {propose.error ? <ApiErrorBanner title="The change was not sent" error={propose.error} /> : null}
      </VStack>
    </Card>
  );
}
