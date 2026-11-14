'use client';

import {Center} from '@astryxdesign/core/Center';
import {Spinner} from '@astryxdesign/core/Spinner';

/** Centered spinner with a visible label. */
export function LoadingState({label = 'Loading'}: {label?: string}) {
  return (
    <Center axis="both" padding={8}>
      <Spinner size="lg" label={label} />
    </Center>
  );
}
