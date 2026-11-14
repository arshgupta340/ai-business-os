/**
 * Proves that no provider key, integration state or action type from the
 * contracts reaches the owner as a raw value through the shared health
 * helpers: PROVIDER_LABELS, providerLabel, summarizeHealth, providerProblems
 * and providersForSteps.
 *
 * The lists are read from the contract schemas, never copied by hand.
 */
import {describe, expect, it} from 'vitest';
import {
  ActionTypeSchema,
  IntegrationHealthSchema,
  IntegrationProviderSchema,
  IntegrationStateSchema,
  WebhookProviderSchema,
  type IntegrationHealth,
  type IntegrationProvider,
} from '@abos/contracts';
import {expectOwnerLabel, FUTURE_VALUES, NOT_TEXT} from '@/lib/owner-label.test-helpers';
import {TONES, statusView} from '@/lib/status';
import {providerProblems, providersForSteps} from './ProviderHealthNotice';
import {HEALTH_PROVIDERS, PROVIDER_LABELS, providerLabel, summarizeHealth} from './shell/ConnectionHealth';

const PROVIDERS = IntegrationProviderSchema.options;
const STATES = IntegrationStateSchema.options;
const NOT_CONNECTED = STATES.filter((state) => state !== 'connected');

/** A contract-valid health record with every provider connected, and `overrides` on top. */
function health(overrides: Record<string, unknown> = {}): IntegrationHealth {
  const entries = Object.fromEntries(
    PROVIDERS.map((provider) => [
      provider,
      {state: 'connected', lastCheckedAt: '2026-11-14T18:00:00.000Z', ...(provider === 'square' ? {environment: 'sandbox'} : {})},
    ]),
  );
  const base = IntegrationHealthSchema.parse(entries);
  return {...base, ...overrides} as IntegrationHealth;
}

const withState = (provider: string, state: string): IntegrationHealth =>
  health({[provider]: {...health()[provider as IntegrationProvider], state}});

describe('provider labels', () => {
  it('has one health card for every integration provider, and no others', () => {
    expect([...HEALTH_PROVIDERS].sort()).toEqual([...PROVIDERS].sort());
    // One provider map for the app: every health card and every webhook provider, and nothing else.
    expect(Object.keys(PROVIDER_LABELS).sort()).toEqual([...new Set([...PROVIDERS, ...WebhookProviderSchema.options])].sort());
    // The health record has one entry for every provider key.
    expect(Object.keys(IntegrationHealthSchema.shape).sort()).toEqual([...PROVIDERS].sort());
  });

  it.each(PROVIDERS)('%s has an owner-facing name', (provider) => {
    expect(Object.hasOwn(PROVIDER_LABELS, provider)).toBe(true);
    expectOwnerLabel(PROVIDER_LABELS[provider], provider);
    expect(providerLabel(provider)).toBe(PROVIDER_LABELS[provider]);
  });

  it.each(WebhookProviderSchema.options)('webhook provider %s has an owner-facing name that is its own label', (provider) => {
    const label = providerLabel(provider);
    expectOwnerLabel(label, provider);
    // Its own label, not the readable fallback: a brand name keeps its capitals.
    expect(label.toLowerCase().replace(/\s/g, '')).toBe(provider.replace(/_/g, ''));
    expect(label).not.toBe(label.toLowerCase());
    if (provider === 'agentphone') expect(label).toBe('AgentPhone');
  });

  it('shows a provider it has never seen in a readable form', () => {
    for (const value of FUTURE_VALUES) expectOwnerLabel(providerLabel(value), value);
    expect(providerLabel('refund_service')).toBe('Refund service');
    for (const value of NOT_TEXT) expect(providerLabel(value as string), String(value)).toBe('Unknown provider');
  });
});

describe('summarizeHealth', () => {
  it('is green only when every provider reports connected', () => {
    const summary = summarizeHealth(health());
    expect(summary.status).toEqual({label: 'Integrations OK', tone: 'success'});
    expect(summary.unknown).toEqual([]);
    expect(statusView('integration', 'connected').tone).toBe('success');
  });

  const problems = PROVIDERS.flatMap((provider) => NOT_CONNECTED.map((state) => [provider, state] as const));

  it.each(problems)('%s %s is not green and names the provider by its label', (provider, state) => {
    const summary = summarizeHealth(withState(provider, state));
    expect(summary.status.tone).toBe(statusView('integration', state).tone);
    expect(summary.status.tone).not.toBe('success');
    expect(TONES).toContain(summary.status.tone);
    expectOwnerLabel(summary.status.label, provider);
    expectOwnerLabel(summary.detail, provider);
    expect(summary.detail).toContain(PROVIDER_LABELS[provider]);
    expect(summary.worst).toBe(state);
  });

  it.each(PROVIDERS)('%s with a state this app has never seen is not counted as connected', (provider) => {
    for (const value of [...FUTURE_VALUES, ...NOT_TEXT]) {
      const summary = summarizeHealth(withState(provider, value as string));
      expect(summary.status, String(value)).toEqual({label: 'Health unknown', tone: 'neutral'});
      expect(summary.unknown).toEqual([PROVIDER_LABELS[provider]]);
      expect(summary.detail).toBe(`State not known: ${PROVIDER_LABELS[provider]}.`);
    }
  });

  it.each(PROVIDERS)('%s with no entry is not counted as connected', (provider) => {
    const summary = summarizeHealth(health({[provider]: undefined}));
    expect(summary.status.tone).not.toBe('success');
    expect(summary.unknown).toEqual([PROVIDER_LABELS[provider]]);
  });

  it('counts a provider key it has never seen, and names it in a readable form', () => {
    const down = summarizeHealth(health({refund_service: {state: 'disconnected', lastCheckedAt: '2026-11-14T18:00:00.000Z'}}));
    expect(down.status).toEqual({label: '1 integration issue', tone: 'danger'});
    expect(down.detail).toBe('Disconnected: Refund service.');
    const up = summarizeHealth(health({refund_service: {state: 'connected', lastCheckedAt: '2026-11-14T18:00:00.000Z'}}));
    expect(up.status.tone).toBe('success');
  });

  it('keeps a known problem ahead of an unknown state', () => {
    const summary = summarizeHealth(health({...withState('google_sheets', 'degraded'), twilio: {...health().twilio, state: 'ON_HOLD'}}));
    expect(summary.status).toEqual({label: '1 integration issue', tone: 'warning'});
    expect(summary.detail).toBe('Degraded: Google Sheets. State not known: Twilio.');
  });
});

describe('providerProblems', () => {
  it.each(PROVIDERS)('%s connected is not a problem', (provider) => {
    expect(providerProblems(health(), [provider])).toEqual([]);
  });

  const problems = PROVIDERS.flatMap((provider) => NOT_CONNECTED.map((state) => [provider, state] as const));

  it.each(problems)('%s %s is named by its label, says what the owner will notice and is never green', (provider, state) => {
    const found = providerProblems(withState(provider, state), PROVIDERS);
    expect(found).toHaveLength(1);
    const [problem] = found;
    expect(problem.title).toBe(`${PROVIDER_LABELS[provider]} is ${statusView('integration', state).label.toLowerCase()}`);
    expectOwnerLabel(problem.title, provider);
    expectOwnerLabel(problem.description, provider);
    expectOwnerLabel(problem.description, state);
    expect(problem.tone).toBe(statusView('integration', state).tone);
    expect(problem.tone).not.toBe('success');
  });

  it('shows a state it has never seen as a readable neutral notice', () => {
    for (const value of FUTURE_VALUES) {
      const [problem] = providerProblems(withState('square', value), ['square']);
      expect(problem.tone, value).toBe('neutral');
      expectOwnerLabel(problem.title, value);
      expectOwnerLabel(problem.description, value);
    }
  });

  it('names a provider it has never seen in a readable form, and skips one with no entry', () => {
    const record = health({refund_service: {state: 'degraded', lastCheckedAt: '2026-11-14T18:00:00.000Z'}});
    const [problem] = providerProblems(record, ['refund_service' as IntegrationProvider]);
    expect(problem.title).toBe('Refund service is degraded');
    expect(problem.tone).toBe('warning');
    expect(providerProblems(health(), ['not_there' as IntegrationProvider])).toEqual([]);
  });
});

describe('providersForSteps', () => {
  it.each(ActionTypeSchema.options)('%s maps to one known provider, or to none when it stays in this app', (step) => {
    const providers = providersForSteps([step]);
    if (step.startsWith('local.')) {
      expect(providers).toEqual([]);
    } else {
      // A step that writes outside this app always has a provider whose health is shown next to it.
      expect(providers).toHaveLength(1);
      expect(PROVIDERS).toContain(providers[0]);
    }
  });
});
