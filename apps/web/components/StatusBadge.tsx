'use client';

import {Badge} from '@astryxdesign/core/Badge';

export type StatusTone = 'neutral' | 'info' | 'warning' | 'danger' | 'success';

/**
 * A short status label, for example "Pending approval" or "Payment failed".
 *
 * Rule: `success` (green) is reserved for states the server or provider has
 * confirmed, such as a verified paid webhook or a created calendar event.
 * Never show green before the provider confirms (AGENTS.md rule 5,
 * docs/PRD.md section 5). Use `info` or `warning` for anything still pending.
 */
export type StatusBadgeProps = {
  label: string;
  tone?: StatusTone;
};

const VARIANT_BY_TONE = {
  neutral: 'neutral',
  info: 'info',
  warning: 'warning',
  danger: 'error',
  success: 'success',
} as const;

export function StatusBadge({label, tone = 'neutral'}: StatusBadgeProps) {
  return <Badge label={label} variant={VARIANT_BY_TONE[tone]} />;
}
