'use client';

import {Fragment, useState} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import {Divider} from '@astryxdesign/core/Divider';
import {HStack} from '@astryxdesign/core/HStack';
import {Text} from '@astryxdesign/core/Text';
import {TimeInput} from '@astryxdesign/core/TimeInput';
import {VStack} from '@astryxdesign/core/VStack';
import {StatusBadge} from '@/components/StatusBadge';
import type {ApprovalRequest, BusinessFact} from '@/lib/api';
import {statusView} from '@/lib/status';
import {formatHours, sourceTypeLabel} from '../../knowledge/_components/knowledge-model';
import {checkHoursInput, hoursRows, initialHoursInput, type HoursInput, type HoursRowModel} from '../_lib/settings-model';
import {EditNotice} from './EditNotice';
import {RequestError} from './RequestError';
import {useFactEdit} from './useFactEdit';

type Props = {
  businessId: string;
  timezone: string;
  facts: readonly BusinessFact[];
  pendingApprovals: readonly ApprovalRequest[];
  openDialog: (approvalId: string) => void;
  refetchFacts: () => void;
};

/** Opening hours, Monday to Sunday, from the verified hours facts. */
export function HoursSection({businessId, timezone, facts, pendingApprovals, openDialog, refetchFacts}: Props) {
  const rows = hoursRows(facts);
  return (
    <VStack gap={3}>
      <Text type="supporting">{`Times are in the business time zone, ${timezone}.`}</Text>
      <VStack gap={3}>
        {rows.map((row, i) => (
          <Fragment key={row.day}>
            {i > 0 ? <Divider /> : null}
            <HoursDayRow
              businessId={businessId}
              row={row}
              pendingApprovals={pendingApprovals}
              openDialog={openDialog}
              refetchFacts={refetchFacts}
            />
          </Fragment>
        ))}
      </VStack>
      <Text type="supporting">Your agents use these hours on the next call.</Text>
    </VStack>
  );
}

function HoursDayRow({
  businessId,
  row,
  pendingApprovals,
  openDialog,
  refetchFacts,
}: {
  businessId: string;
  row: HoursRowModel;
  pendingApprovals: readonly ApprovalRequest[];
  openDialog: (approvalId: string) => void;
  refetchFacts: () => void;
}) {
  const {verified} = row;
  const edit = useFactEdit({businessId, kind: 'hours', factKey: row.day, verified, pendingApprovals, openDialog, refetchFacts});
  const [editing, setEditing] = useState(false);
  const busy = edit.phase === 'waiting' || edit.phase === 'saving';
  const status = verified ? statusView('fact', verified.status) : undefined;

  return (
    <VStack gap={2}>
      <HStack gap={3} vAlign="center" justify="between" wrap="wrap">
        <VStack gap={0.5}>
          <Text weight="medium">{row.label}</Text>
          <Text>{verified ? formatHours(verified.value) : 'Not set'}</Text>
          {verified ? (
            <Text type="supporting">{`${sourceTypeLabel(verified.sourceType)}, version ${verified.version}`}</Text>
          ) : null}
        </VStack>
        <HStack gap={2} vAlign="center">
          {status ? <StatusBadge label={status.label} tone={status.tone} /> : null}
          {!editing ? (
            <Button
              label={`Edit ${row.label}`}
              size="sm"
              onClick={() => setEditing(true)}
              isDisabled={busy || edit.isProposing}
            />
          ) : null}
        </HStack>
      </HStack>

      <EditNotice edit={edit} describe={formatHours} subject={`${row.label} hours`} />

      {editing ? (
        <HoursEditor
          day={row.label}
          current={verified?.value}
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

function HoursEditor({
  day,
  current,
  isSending,
  onCancel,
  onSubmit,
}: {
  day: string;
  current: unknown;
  isSending: boolean;
  onCancel: () => void;
  onSubmit: (value: unknown) => void;
}) {
  const [input, setInput] = useState<HoursInput>(() => initialHoursInput(current));
  const [errors, setErrors] = useState<{open?: string; close?: string; form?: string}>({});

  const submit = () => {
    const check = checkHoursInput(input, current);
    if (!check.ok) {
      setErrors(check.errors);
      return;
    }
    setErrors({});
    onSubmit(check.value);
  };

  return (
    <VStack gap={3}>
      <CheckboxInput
        label="Closed all day"
        value={input.closed}
        onChange={(closed) => setInput((prev) => ({...prev, closed}))}
        isDisabled={isSending}
      />
      {!input.closed ? (
        <HStack gap={3} wrap="wrap">
          <TimeInput
            label={`${day} opens`}
            value={input.open as never}
            onChange={(open) => setInput((prev) => ({...prev, open: open ?? undefined}))}
            status={errors.open ? {type: 'error', message: errors.open} : undefined}
            statusVariant="detached"
            isDisabled={isSending}
            width={200}
          />
          <TimeInput
            label={`${day} closes`}
            value={input.close as never}
            onChange={(close) => setInput((prev) => ({...prev, close: close ?? undefined}))}
            status={errors.close ? {type: 'error', message: errors.close} : undefined}
            statusVariant="detached"
            isDisabled={isSending}
            width={200}
          />
        </HStack>
      ) : null}
      {errors.form ? <Banner status="warning" title={errors.form} /> : null}
      <Text type="supporting">Nothing changes until you confirm the change in the next step.</Text>
      <HStack gap={2} wrap="wrap">
        <Button label="Cancel" variant="ghost" onClick={onCancel} isDisabled={isSending} />
        <Button label="Review change" variant="primary" onClick={submit} isLoading={isSending} isDisabled={isSending} />
      </HStack>
    </VStack>
  );
}
