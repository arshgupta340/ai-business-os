'use client';

import {Selector, type SelectorProps} from '@astryxdesign/core/Selector';
import {businessSelectorPlaceholder, useBusiness, useBusinessList} from '@/lib/session';

export type BusinessSelectorProps = {
  /** Field width. Leave it out in the top bar; the mobile menu passes "100%". */
  width?: SelectorProps['width'];
};

export function BusinessSelector({width}: BusinessSelectorProps = {}) {
  const {businesses, businessId, setBusinessId} = useBusiness();
  const {status} = useBusinessList();
  // In real mode the selector shows only what the server returned. Until the
  // list is ready it says why it is empty and cannot be opened.
  const isWaiting = status !== 'ready' && status !== 'signed_out';
  return (
    <Selector
      width={width}
      label="Business"
      isLabelHidden
      variant="secondary"
      size="sm"
      value={businessId ?? undefined}
      options={businesses.map((b) => ({value: b.id, label: b.name}))}
      isLoading={status === 'loading'}
      isDisabled={isWaiting}
      placeholder={businessSelectorPlaceholder(status)}
      onChange={(value) => {
        if (value) setBusinessId(value);
      }}
    />
  );
}
