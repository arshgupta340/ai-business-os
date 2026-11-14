'use client';

import {isMockMode} from '@/lib/env';
import {StatusBadge, type StatusTone} from '@/components/StatusBadge';

export type ConnectionHealthStatus = {label: string; tone: StatusTone};

/**
 * Connection health slot in the top bar. Today it shows "Mock mode" when
 * NEXT_PUBLIC_MOCK=1 and a neutral "Checking" otherwise. A later task passes
 * a real status from GET /api/health. Do not pass tone "success" unless the
 * server reported it.
 */
export function ConnectionHealth({status}: {status?: ConnectionHealthStatus}) {
  const resolved: ConnectionHealthStatus =
    status ?? (isMockMode() ? {label: 'Mock mode', tone: 'info'} : {label: 'Checking', tone: 'neutral'});
  return <StatusBadge label={resolved.label} tone={resolved.tone} />;
}
