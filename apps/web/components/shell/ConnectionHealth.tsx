'use client';

import {HStack} from '@astryxdesign/core/HStack';
import {Link} from '@astryxdesign/core/Link';
import {isDemoScript, isMockMode, withBasePath} from '@/lib/env';
import {hideEverythingUntil} from '@/lib/demo-reset';
import {clearDemoAgentBuilt} from '@/lib/demo-stage';
import {clearDemoRun} from '@/app/(dashboard)/build/demo/demo-run-store';
import {useIntegrationsHealth, type IntegrationHealth, type IntegrationProvider} from '@/lib/api';
import {useBusiness} from '@/lib/session';
import {PROVIDER_LABELS, providerLabel} from '@/lib/labels';
import {statusView} from '@/lib/status';
import {StatusBadge, type StatusTone} from '@/components/StatusBadge';

export type ConnectionHealthStatus = {label: string; tone: StatusTone};

/**
 * Every provider with a health card, in the order the health record lists
 * them. Typed on the contract, so a provider added to the contract and not
 * listed here fails the typecheck. Names come from PROVIDER_LABELS in
 * '@/lib/labels', the one provider map of the app.
 */
const HEALTH_PROVIDER_ORDER: Record<IntegrationProvider, number> = {
  square: 0,
  twilio: 1,
  openai: 2,
  google_calendar: 3,
  google_sheets: 4,
  message_channel: 5,
};

export const HEALTH_PROVIDERS: readonly IntegrationProvider[] = (Object.keys(HEALTH_PROVIDER_ORDER) as IntegrationProvider[]).sort(
  (a, b) => HEALTH_PROVIDER_ORDER[a] - HEALTH_PROVIDER_ORDER[b],
);

// Kept as exports of this file for the screens that import them from here.
export {PROVIDER_LABELS, providerLabel};

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
  const keys = [...new Set([...HEALTH_PROVIDERS, ...Object.keys(record)])];
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
 * The demo reset (Arsh, 2026-11-15). On the scripted demo build the badge
 * keeps its look and, when pressed, puts the app back to its starting page:
 * the saved Build run is dropped, the agent card is hidden again until the
 * next build, the lists of calls, orders, bookings,
 * approvals and activity leave out everything up to now, and the Build page is
 * loaded afresh. Nothing is deleted on the server (lib/demo-reset.ts).
 */
export function resetDemo(now: number = Date.now(), go: (url: string) => void = (url) => window.location.assign(url)): void {
  clearDemoRun();
  // Overview and My Agents show no agent again until the next build reaches its number.
  clearDemoAgentBuilt();
  hideEverythingUntil(now);
  go(withBasePath('/build'));
}

const RESET_BUTTON_STYLE = {all: 'unset', cursor: 'pointer', display: 'inline-flex'} as const;

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
      {isDemoScript() ? (
        // No tooltip and no visible change: on stage this is the presenter's own reset.
        <button type="button" style={RESET_BUTTON_STYLE} aria-label={`${badge.label}. Reset the demo.`} onClick={() => resetDemo()}>
          <StatusBadge label={badge.label} tone={badge.tone} />
        </button>
      ) : (
        <Link href="/integrations" tooltip={detail ? `${detail} Open integrations.` : 'Open integrations'}>
          <StatusBadge label={badge.label} tone={badge.tone} />
        </Link>
      )}
    </HStack>
  );
}
