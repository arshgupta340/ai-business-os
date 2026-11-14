'use client';

// From the Astryx block "DialogConfirmationDialog": a header, the body text
// and Cancel plus the confirm button in the footer.

import type {ReactNode} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {HStack} from '@astryxdesign/core/HStack';
import {Layout, LayoutContent, LayoutFooter} from '@astryxdesign/core/Layout';
import {VStack} from '@astryxdesign/core/VStack';

export type ConfirmDialogProps = {
  isOpen: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  confirmVariant?: 'primary' | 'destructive';
  isPending: boolean;
  onConfirm: () => void;
  onClose: () => void;
};

/** The owner's confirmation before pause or the live switch. Nothing is sent before Confirm. */
export function ConfirmDialog({isOpen, title, children, confirmLabel, confirmVariant = 'primary', isPending, onConfirm, onClose}: ConfirmDialogProps) {
  // While the request is open the dialog cannot be dismissed, so the result is always seen.
  const close = () => {
    if (!isPending) onClose();
  };
  return (
    <Dialog isOpen={isOpen} onOpenChange={(open) => (open ? undefined : close())} width={480} purpose="form">
      {isOpen ? (
        <Layout
          header={<DialogHeader title={title} onOpenChange={() => close()} />}
          content={
            <LayoutContent>
              <VStack gap={3}>{children}</VStack>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <HStack gap={2} hAlign="end" wrap="wrap">
                <Button label="Cancel" variant="secondary" onClick={close} isDisabled={isPending} />
                <Button label={confirmLabel} variant={confirmVariant} onClick={onConfirm} isLoading={isPending} isDisabled={isPending} />
              </HStack>
            </LayoutFooter>
          }
        />
      ) : null}
    </Dialog>
  );
}
