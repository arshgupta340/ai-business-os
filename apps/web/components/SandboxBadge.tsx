'use client';

import {Badge} from '@astryxdesign/core/Badge';

/**
 * Place next to any payment data (amounts, order totals, payment links,
 * payment status). Square runs in sandbox only (AGENTS.md rule 4).
 */
export function SandboxBadge({label = 'Sandbox'}: {label?: string}) {
  return <Badge label={label} variant="warning" />;
}
