'use client';

import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {VStack} from '@astryxdesign/core/VStack';
import {useIntegrationsHealth, type IntegrationHealth, type IntegrationProvider} from '@/lib/api';
import {statusView, type Tone} from '@/lib/status';
import {consequenceFor} from '@/app/(dashboard)/integrations/_lib/integrations-view';
import {PROVIDER_LABELS} from '@/components/shell/ConnectionHealth';

/** The Banner status for a tone that statusView chose. Same translation as StatusBadge. */
const BANNER_STATUS: Record<Tone, 'info' | 'warning' | 'error' | 'success'> = {
  neutral: 'info',
  info: 'info',
  warning: 'warning',
  danger: 'error',
  success: 'success',
};

export type ProviderProblem = {
  provider: IntegrationProvider;
  state: 'degraded' | 'disconnected';
  title: string;
  description: string;
  tone: Tone;
};

/**
 * The providers in `providers` that are not connected, with what the owner
 * will notice. Pure, so screens and tests share it.
 */
export function providerProblems(health: IntegrationHealth | undefined, providers: readonly IntegrationProvider[]): ProviderProblem[] {
  if (!health) return [];
  const problems: ProviderProblem[] = [];
  for (const provider of providers) {
    const entry = health[provider];
    if (!entry || entry.state === 'connected') continue;
    const consequence = consequenceFor(provider, entry.state);
    const view = statusView('integration', entry.state);
    problems.push({
      provider,
      state: entry.state,
      tone: view.tone,
      title: `${PROVIDER_LABELS[provider]} is ${view.label.toLowerCase()}`,
      description: consequence ? consequence.notice : 'It may not work as expected right now.',
    });
  }
  return problems;
}

/**
 * Says when a provider that the action on screen depends on is degraded or
 * disconnected, and what that means for this action. Renders nothing while
 * every listed provider is connected or the health has not loaded.
 */
export function ProviderHealthNotice({
  businessId,
  providers,
  showLink = true,
}: {
  businessId: string | null | undefined;
  providers: readonly IntegrationProvider[];
  /** Show the "Open Integrations" button. */
  showLink?: boolean;
}) {
  const health = useIntegrationsHealth(businessId);
  const problems = providerProblems(health.data, providers);
  if (problems.length === 0) return null;
  return (
    <VStack gap={2}>
      {problems.map((p) => (
        <Banner
          key={p.provider}
          status={BANNER_STATUS[p.tone]}
          title={p.title}
          description={p.description}
          collapsible={false}
          endContent={showLink ? <Button label="Open Integrations" size="sm" href="/integrations" /> : undefined}
        />
      ))}
    </VStack>
  );
}

/** The providers an action step writes to. Steps that stay in this app are left out. */
export function providersForSteps(steps: readonly string[]): IntegrationProvider[] {
  const out = new Set<IntegrationProvider>();
  for (const step of steps) {
    if (step.startsWith('square.')) out.add('square');
    else if (step.startsWith('message.')) out.add('message_channel');
    else if (step.startsWith('sheets.')) out.add('google_sheets');
    else if (step.startsWith('calendar.')) out.add('google_calendar');
  }
  return [...out];
}
