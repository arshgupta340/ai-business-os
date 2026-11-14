'use client';

import {HStack} from '@astryxdesign/core/HStack';
import {Link} from '@astryxdesign/core/Link';
import {isMockMode} from '@/lib/env';
import {useIntegrationsHealth, type IntegrationHealth, type IntegrationProvider} from '@/lib/api';
import {useBusiness} from '@/lib/session';
import {statusView} from '@/lib/status';
import {StatusBadge, type StatusTone} from '@/components/StatusBadge';

export type ConnectionHealthStatus = {label: string; tone: StatusTone};

/** Owner-facing provider names, in the order the health record lists them. */
export const PROVIDER_LABELS: Record<IntegrationProvider, string> = {
  square: 'Square',
  twilio: 'Twilio',
  openai: 'OpenAI',
  google_calendar: 'Google Calendar',
  google_sheets: 'Google Sheets',
  message_channel: 'Message channel',
};

export type HealthSummary = {
  /** The worst provider state. */
  worst: 'connected' | 'degraded' | 'disconnected';
  degraded: string[];
  disconnected: string[];
  /** Short label and tone for the top bar. */
  status: ConnectionHealthStatus;
  /** One sentence naming the providers with a problem, for a tooltip. */
  detail: string;
};

/**
 * Summary of GET /api/integrations/health. The tone of the worst state comes
 * from statusView('integration', ...): warning for degraded, danger for
 * disconnected, and success only when every provider reports connected.
 */
export function summarizeHealth(health: IntegrationHealth): HealthSummary {
  const entries = (Object.keys(PROVIDER_LABELS) as IntegrationProvider[]).map((key) => ({
    name: PROVIDER_LABELS[key],
    state: health[key]?.state,
  }));
  const degraded = entries.filter((e) => e.state === 'degraded').map((e) => e.name);
  const disconnected = entries.filter((e) => e.state === 'disconnected').map((e) => e.name);
  const worst = disconnected.length ? 'disconnected' : degraded.length ? 'degraded' : 'connected';
  const tone = statusView('integration', worst).tone;

  // Kept short so it fits the top bar on a phone. The tooltip names the providers.
  const issues = disconnected.length + degraded.length;
  const label = issues === 0 ? 'Integrations OK' : issues === 1 ? '1 integration issue' : `${issues} integration issues`;

  const detailParts: string[] = [];
  if (disconnected.length) detailParts.push(`Disconnected: ${disconnected.join(', ')}.`);
  if (degraded.length) detailParts.push(`Degraded: ${degraded.join(', ')}.`);
  const detail = detailParts.length ? detailParts.join(' ') : 'Every provider reports connected.';

  return {worst, degraded, disconnected, status: {label, tone}, detail};
}

/**
 * Connection health slot in the top bar. It reads the integration health of
 * the selected business and links to /integrations; the provider names with a
 * problem show on hover. In mock mode the "Mock mode" marker stays visible
 * next to it, because the health data is then mock data.
 *
 * A caller may still pass `status` to override the health badge. Do not pass
 * tone "success" unless the server reported it.
 */
export function ConnectionHealth({status}: {status?: ConnectionHealthStatus}) {
  const {businessId} = useBusiness();
  const health = useIntegrationsHealth(status ? null : businessId);
  const mock = isMockMode();

  let badge: ConnectionHealthStatus;
  let detail: string | undefined;
  if (status) {
    badge = status;
  } else if (health.data) {
    const summary = summarizeHealth(health.data);
    badge = summary.status;
    detail = summary.detail;
  } else if (health.error) {
    badge = {label: 'Health unknown', tone: 'neutral'};
    detail = 'Could not load integration health.';
  } else {
    badge = {label: 'Checking', tone: 'neutral'};
  }

  return (
    <HStack gap={2} vAlign="center">
      {mock ? <StatusBadge label="Mock mode" tone="info" /> : null}
      <Link href="/integrations" tooltip={detail ? `${detail} Open integrations.` : 'Open integrations'}>
        <StatusBadge label={badge.label} tone={badge.tone} />
      </Link>
    </HStack>
  );
}
