/**
 * #126: Integrations, agent preview, Build, Telemetry and Settings show no raw
 * contract value. Each list is read from the contract schema, never copied by
 * hand, and each helper also gets values no contract has today.
 */
import {describe, expect, it} from 'vitest';
import {
  ActionTypeSchema,
  ActivityEventTypeSchema,
  EffectSchema,
  IntegrationProviderSchema,
  IntegrationStateSchema,
  KnowledgeScopeSchema,
  MessageChannelSchema,
  MessageChannelSettingSchema,
  TelemetryMetricNameSchema,
  ToolNameSchema,
  WebhookProviderSchema,
} from '@abos/contracts';
import {ApiError, type ActivityEvent} from '@/lib/api';
import {effectLabel, toolLabel} from '@/lib/labels';
import {expectOwnerLabel, FUTURE_VALUES, NOT_TEXT} from '@/lib/owner-label.test-helpers';
import {providerName, unavailableSentence} from './agents/[id]/preview/_lib/preview';
import {builderSendErrorView, scopeLabel} from './build/_lib/spec';
import {INTEGRATION_EVENT_TYPES, channelText, consequenceFor, describeIntegrationEvent, errorText} from './integrations/_lib/integrations-view';
import {healthChannelText} from './overview/_components/HealthSection';
import {metricView} from './telemetry/_lib/telemetry';

/** expectOwnerLabel, plus no dotted identifier such as "square.checkout.create". */
function expectPlain(text: unknown, raw: string): void {
  expectOwnerLabel(text, raw);
  expect(text as string, `${JSON.stringify(text)} has a dotted identifier`).not.toMatch(/[a-z]\.[a-z]/);
}

function event(type: string, payload: Record<string, unknown>): ActivityEvent {
  return {id: 'evt_1', businessId: 'biz_pizza_01', type, correlationId: 'c', actorType: 'system', occurredAt: '2026-11-14T18:00:00.000Z', payload} as ActivityEvent;
}

const apiError = (code: string, details?: Record<string, unknown>) =>
  new ApiError({code: code as never, message: 'Operation failed: INVALID_STATE.', status: 503, retryable: true, kind: 'http', details});

describe('Integrations screen', () => {
  it('names every message channel setting, and one it does not know', () => {
    for (const channel of [...MessageChannelSettingSchema.options, ...FUTURE_VALUES]) expectPlain(channelText(channel as never), channel);
  });

  it('describes a failed step for every action type, and one it does not know', () => {
    for (const actionType of [...ActionTypeSchema.options, ...FUTURE_VALUES]) {
      expectPlain(describeIntegrationEvent(event('execution.failed', {approvalId: 'a', actionType, errorCode: 'INTERNAL'})).title, actionType);
    }
  });

  it('names the provider of every rejected webhook, and one it does not know', () => {
    for (const provider of [...WebhookProviderSchema.options, ...FUTURE_VALUES]) {
      expectPlain(describeIntegrationEvent(event('webhook.rejected', {provider, reason: 'signature_invalid'})).title, provider);
    }
    expect(describeIntegrationEvent(event('webhook.rejected', {provider: 'agentphone', reason: 'signature_invalid'})).title).toBe(
      'Rejected a webhook from AgentPhone because its signature did not match. Nothing changed.',
    );
  });

  it('names the channel of every failed message, and one it does not know', () => {
    for (const channel of [...MessageChannelSchema.options, ...FUTURE_VALUES]) {
      expectPlain(describeIntegrationEvent(event('message.failed', {dispatchId: 'd', subjectId: 's', channel, status: 'FAILED'})).title, channel);
    }
  });

  it('never shows an event type raw, whatever reaches the default case', () => {
    const listed: readonly string[] = INTEGRATION_EVENT_TYPES;
    for (const type of [...ActivityEventTypeSchema.options, ...FUTURE_VALUES].filter((t) => !listed.includes(t))) {
      const {title} = describeIntegrationEvent(event(type, {}));
      expectPlain(title, type);
    }
  });

  it('returns no consequence for an inherited member or a state it does not know', () => {
    for (const provider of IntegrationProviderSchema.options) {
      for (const state of IntegrationStateSchema.options) {
        if (state !== 'connected') expect(consequenceFor(provider, state), `${provider} ${state}`).not.toBeNull();
      }
      for (const state of FUTURE_VALUES) expect(consequenceFor(provider, state as never), `${provider} ${state}`).toBeNull();
    }
    for (const provider of FUTURE_VALUES) expect(consequenceFor(provider as never, 'degraded')).toBeNull();
  });

  it('names every provider in an unavailable error, and one it does not know', () => {
    for (const provider of [...IntegrationProviderSchema.options, ...WebhookProviderSchema.options, ...FUTURE_VALUES]) {
      expectPlain(errorText(apiError('INTEGRATION_UNAVAILABLE', {provider})), provider);
    }
  });
});

describe('Overview health block', () => {
  it('names every message channel setting, and one it does not know', () => {
    for (const channel of [...MessageChannelSettingSchema.options, ...FUTURE_VALUES]) expectPlain(healthChannelText(channel), channel);
    for (const channel of NOT_TEXT) expectPlain(healthChannelText(channel), String(channel));
    expect(healthChannelText('qr_only')).toBe('QR code only, no message is sent');
  });
});

describe('agent preview', () => {
  it('names every provider, and one it does not know', () => {
    for (const provider of [...IntegrationProviderSchema.options, ...WebhookProviderSchema.options, ...FUTURE_VALUES]) {
      expectPlain(providerName(provider), provider);
      expectPlain(unavailableSentence(apiError('INTEGRATION_UNAVAILABLE', {providers: [provider]})), provider);
    }
  });

  it('names every tool and effect in the trace, and one it does not know', () => {
    for (const tool of [...ToolNameSchema.options, ...FUTURE_VALUES]) expectPlain(toolLabel(tool), tool);
    for (const effect of [...EffectSchema.options, ...FUTURE_VALUES]) expectPlain(effectLabel(effect), effect);
  });
});

describe('Build screen', () => {
  it('names every knowledge scope, and one it does not know', () => {
    for (const scope of [...KnowledgeScopeSchema.options, ...FUTURE_VALUES]) expectPlain(scopeLabel(scope), scope);
    for (const scope of NOT_TEXT) expectPlain(scopeLabel(scope), String(scope));
  });

  it('names every provider when the builder is not available', () => {
    for (const provider of [...IntegrationProviderSchema.options, ...WebhookProviderSchema.options, ...FUTURE_VALUES]) {
      expectPlain(builderSendErrorView(apiError('INTEGRATION_UNAVAILABLE', {provider})).description, provider);
    }
  });
});

describe('Telemetry screen', () => {
  it('has its own label for every metric the contract lists', () => {
    for (const name of TelemetryMetricNameSchema.options) {
      const view = metricView({name, p50Ms: 10, p95Ms: 20, count: 30});
      expect(view.isKnown, name).toBe(true);
      expectPlain(view.label, name);
    }
  });

  it('shows a metric it does not know in a readable form, never raw', () => {
    for (const name of FUTURE_VALUES) {
      const view = metricView({name, p50Ms: 10, p95Ms: 20, count: 30});
      expect(view.isKnown, name).toBe(false);
      expectPlain(view.label, name);
    }
  });
});
