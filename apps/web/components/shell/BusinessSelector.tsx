'use client';

import {Selector, type SelectorProps} from '@astryxdesign/core/Selector';
import {useBusiness} from '@/lib/session';

export type BusinessSelectorProps = {
  /** Field width. Leave it out in the top bar; the mobile menu passes "100%". */
  width?: SelectorProps['width'];
};

export function BusinessSelector({width}: BusinessSelectorProps = {}) {
  const {businesses, businessId, setBusinessId} = useBusiness();
  return (
    <Selector
      width={width}
      label="Business"
      isLabelHidden
      variant="secondary"
      size="sm"
      value={businessId ?? undefined}
      options={businesses.map((b) => ({value: b.id, label: b.name}))}
      onChange={(value) => {
        if (value) setBusinessId(value);
      }}
    />
  );
}
