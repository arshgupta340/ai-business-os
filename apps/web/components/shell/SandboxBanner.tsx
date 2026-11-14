'use client';

import {Banner} from '@astryxdesign/core/Banner';

export const SANDBOX_BANNER_TEXT = 'Sandbox. Payments are test data. No real money moves.';

/** Persistent, not dismissable. Shown on every dashboard screen. */
export function SandboxBanner() {
  return <Banner status="warning" title={SANDBOX_BANNER_TEXT} container="section" collapsible={false} />;
}
