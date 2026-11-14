'use client';

import {HStack} from '@astryxdesign/core/HStack';
import {Link} from '@astryxdesign/core/Link';
import {isMockMode} from '@/lib/env';
import type {WebhookProvider} from '@abos/contracts';
import {useIntegrationsHealth, type IntegrationHealth, type IntegrationProvider} from '@/lib/api';
import {useBusiness} from '@/lib/session';
import {readableLabel, statusView} from '@/lib/status';
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

/**
 * Providers that send webhooks and have no health card, so they are not in
 * PROVIDER_LABELS. PROVIDER_LABELS stays the list of health cards.
 */
const WEBHOOK_ONLY_PROVIDER_LABELS: Record<Exclude<WebhookProvider, IntegrationProvider>, string> = {
  agentphone: 'AgentPhone',
};

/**
 * The owner-facing name of a provider key from the health record or from a
 * webhook. A key this app does not know, as a later contract version may add,
 * shows in a readable form and never as the raw key.
 */
export function providerLabel(provider: string): string {
  const labels: Record<string, string> = {...WEBHOOK_ONLY_PROVIDER_LABELS, ...PROVIDER_LABELS};
  return typeof provider === 'string' && Object.hasOwn(labels, provider) ? labels[provider] : readableLabel(provider, 'Unknown provider');
}

export type HealthSummary = {
  /** The worst state among the providers whose state this app knows. */
  worst: 'connected' | 'degraded' | 'disconnected';
  degraded: string[];
  disconnected: string[];
  /** Providers with no entry, or with a state this app does not know. They are never counted as connected. */
  unknown: string[];
  /** Short label and tone for the top bar. */
  status: ConnectionHealthStatus;
  /** One sentence naming the providers with a problem, for a tooltip. */
  detail: string;
};

/**
 * Summary of GET /api/integrations/health. The tone of the worst state comes
 * from statusView('integration', ...): warning for degraded, danger for
 * disconnected, and success only when every provider reports connected.
 * A provider with no entry or with a state this app does not know is not
 * counted as connected, so the summary is never green because of it.
 */
export function summarizeHealth(health: IntegrationHealth): HealthSummary {
  const record: Record<string, {state?: unknown} | undefined> = health;
  // Every provider this app knows, then any other key the server sent.
  const keys = [...new Set([...Object.keys(PROVIDER_LABELS), ...Object.keys(record)])];
  const entries = keys.map((key) => ({name: providerLabel(key), state: record[key]?.state}));
  const degraded = entries.filter((e) => e.state === 'degraded').map((e) => e.name);
  const disconnected = entries.filter((e) => e.state === 'disconnected').map((e) => e.name);
  const unknown = entries.filter((e) => e.state !== 'connected' && e.state !== 'degraded' && e.state !== 'disconnected').map((e) => e.name);
  const worst = disconnected.length ? 'disconnected' : degraded.length ? 'degraded' : 'connected';

  // Kept short so it fits the top bar on a phone. The tooltip names the providers.
  const issues = disconnected.length + degraded.length;
  let status: ConnectionHealthStatus;
  if (issues > 0) {
    status = {label: issues === 1 ? '1 integration issue' : `${issues} integration issues`, tone: statusView('integration', worst).tone};
  } else if (unknown.length > 0) {
    status = {label: 'Health unknown', tone: 'neutral'};
  } else {
    status = {label: 'Integrations OK', tone: statusView('integration', 'connected').tone};
  }

  const detailParts: string[] = [];
  if (disconnected.length) detailParts.push(`Disconnected: ${disconnected.join(', ')}.`);
  if (degraded.length) detailParts.push(`Degraded: ${degraded.join(', ')}.`);
  if (unknown.length) detailParts.push(`State not known: ${unknown.join(', ')}.`);
  const detail = detailParts.length ? detailParts.join(' ') : 'Every provider reports connected.';

  return {worst, degraded, disconnected, unknown, status, detail};
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
