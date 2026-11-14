'use client';

import {useState} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {HStack} from '@astryxdesign/core/HStack';
import {Layout, LayoutContent, LayoutFooter} from '@astryxdesign/core/Layout';
import {MetadataList, MetadataListItem} from '@astryxdesign/core/MetadataList';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {VStack} from '@astryxdesign/core/VStack';
import {SandboxBadge} from '@/components/SandboxBadge';
import {useProposePrice, type ApprovalRequest} from '@/lib/api';
import {formatMoney} from '@/lib/format';
import {validateNewPrice} from '../_lib/price-input';
import {proposeErrorView} from '../_lib/propose-errors';

export type PriceEditorTarget = {
  itemName: string;
  variationId: string;
  variationName: string;
  currentPriceMinor: number;
  currency: 'USD';
  /** Text to start the field with, for example the uploaded menu price. */
  initialValue?: string;
};

type Props = {
  businessId: string;
  target: PriceEditorTarget | null;
  onClose: () => void;
  /** Called with the approval the server created. Nothing has changed in Square yet. */
  onProposed: (approval: ApprovalRequest, variationId: string) => void;
};

export function PriceEditorDialog({businessId, target, onClose, onProposed}: Props) {
  return (
    <Dialog
      isOpen={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      width={480}
      purpose="form">
      {target ? <EditorContent key={target.variationId} businessId={businessId} target={target} onClose={onClose} onProposed={onProposed} /> : null}
    </Dialog>
  );
}

function EditorContent({businessId, target, onClose, onProposed}: Props & {target: PriceEditorTarget}) {
  const propose = useProposePrice(businessId);
  const [value, setValue] = useState(target.initialValue ?? '');
  const [touched, setTouched] = useState(false);
  const check = validateNewPrice(value, target.currentPriceMinor);
  const errorView = propose.error ? proposeErrorView(propose.error) : null;

  const submit = () => {
    setTouched(true);
    if (!check.ok || propose.isPending) return;
    propose.mutate(
      {variationId: target.variationId, newPriceMinor: check.minor, currency: 'USD'},
      {onSuccess: ({approval}) => onProposed(approval, target.variationId)},
    );
  };

  const fieldStatus =
    touched && !check.ok
      ? {type: 'error' as const, message: check.message}
      : errorView?.fieldMessage
        ? {type: 'error' as const, message: errorView.fieldMessage}
        : undefined;

  return (
    <Layout
      header={
        <DialogHeader
          title={`Change the price of ${target.itemName}, ${target.variationName}`}
          subtitle="You confirm the exact change in the next step. Square does not change before that."
          onOpenChange={() => onClose()}
        />
      }
      content={
        <LayoutContent>
          <VStack gap={4}>
            <MetadataList>
              <MetadataListItem label="Current price in Square">
                <HStack gap={2} vAlign="center">
                  <Text hasTabularNumbers>{formatMoney(target.currentPriceMinor, target.currency)}</Text>
                  <SandboxBadge />
                </HStack>
              </MetadataListItem>
              {check.ok ? (
                <MetadataListItem label="New price">
                  <HStack gap={2} vAlign="center">
                    <Text weight="semibold" hasTabularNumbers>
                      {formatMoney(check.minor, target.currency)}
                    </Text>
                    <SandboxBadge />
                  </HStack>
                </MetadataListItem>
              ) : null}
            </MetadataList>
            <TextInput
              label="New price in dollars (sandbox)"
              description="For example 19.99. More than $0.00 and at most $1,000.00."
              value={value}
              onChange={(v) => {
                setValue(v);
                if (propose.error) propose.reset();
              }}
              onEnter={submit}
              inputMode="decimal"
              enterKeyHint="done"
              autoComplete="off"
              hasAutoFocus
              status={fieldStatus}
              statusVariant="detached"
            />
            {errorView && !errorView.fieldMessage ? (
              <Banner status="error" title={errorView.title} description={errorView.message} container="card">
                {errorView.correlationId ? <Text type="supporting">Reference for support: {errorView.correlationId}</Text> : undefined}
              </Banner>
            ) : null}
          </VStack>
        </LayoutContent>
      }
      footer={
        <LayoutFooter hasDivider>
          <HStack gap={2} hAlign="end">
            <Button label="Cancel" variant="secondary" onClick={onClose} isDisabled={propose.isPending} />
            <Button
              label={errorView?.retryable && !errorView.fieldMessage ? 'Try again' : 'Review the change'}
              variant="primary"
              onClick={submit}
              isLoading={propose.isPending}
              isDisabled={propose.isPending || (errorView !== null && !errorView.retryable && !errorView.fieldMessage)}
            />
          </HStack>
        </LayoutFooter>
      }
    />
  );
}
