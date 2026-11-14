'use client';

import {Selector} from '@astryxdesign/core/Selector';
import {useBusiness} from '@/lib/session';

export function BusinessSelector() {
  const {businesses, businessId, setBusinessId} = useBusiness();
  return (
    <Selector
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
