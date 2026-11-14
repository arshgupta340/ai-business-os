import {describe, expect, it} from 'vitest';
import {ApiError, type ActivityEvent, type IntegrationProvider} from '@/lib/api';
import {statusView} from '@/lib/status';
import {PROVIDER_LABELS} from '@/components/shell/ConnectionHealth';
import {
  PROVIDER_PURPOSE,
  canRetry,
  channelText,
  consequenceFor,
  describeIntegrationEvent,
  errorText,
} from './integrations-view';

const PROVIDERS = Object.keys(PROVIDER_LABELS) as IntegrationProvider[];

function event(type: ActivityEvent['type'], payload: Record<string, unknown>): ActivityEvent {
  return {
    id: 'evt_1',
    businessId: 'biz_pizza_01',
    type,
    correlationId: 'call_1',
    actorType: 'system',
    payload,
    occurredAt: '2026-11-13T19:00:00Z',
  } as ActivityEvent;
}

describe('integration tones', () => {
  it('is green only for connected', () => {
    expect(statusView('integration', 'connected').tone).toBe('success');
    expect(statusView('integration', 'degraded').tone).toBe('warning');
    expect(statusView('integration', 'disconnected').tone).toBe('danger');
  });
});

describe('consequenceFor', () => {
  it('has a notice and an action for every provider when degraded or disconnected, and nothing when connected', () => {
    for (const provider of PROVIDERS) {
      expect(consequenceFor(provider, 'connected')).toBeNull();
      for (const state of ['degraded', 'disconnected'] as const) {
        const c = consequenceFor(provider, state);
        expect(c?.notice.length).toBeGreaterThan(10);
        expect(c?.action.length).toBeGreaterThan(10);
      }
    }
  });

  it('says what the owner notices for the calendar and the report sheet', () => {
    expect(consequenceFor('google_calendar', 'disconnected')?.notice).toContain('Bookings cannot be created');
    expect(consequenceFor('google_sheets', 'disconnected')?.notice).toContain('will catch up');
  });

  it('never offers a connect or reconnect flow', () => {
    for (const provider of PROVIDERS) {
      for (const state of ['degraded', 'disconnected'] as const) {
        const c = consequenceFor(provider, state)!;
        expect(`${c.notice} ${c.action}`.toLowerCase()).not.toMatch(/\b(re)?connect\b/);
      }
    }
  });
});

describe('text rules', () => {
  it('has one purpose sentence per provider, without em dashes or contractions', () => {
    for (const provider of PROVIDERS) expect(PROVIDER_PURPOSE[provider]).toBeTruthy();
    const all = [
      ...Object.values(PROVIDER_PURPOSE),
      ...PROVIDERS.flatMap((p) => ['degraded', 'disconnected'].map((s) => Object.values(consequenceFor(p, s as 'degraded')!).join(' '))),
      channelText('qr_only'),
    ].join(' ');
    expect(all).not.toContain('—');
    expect(all).not.toMatch(/\b\w+n't\b|\b(I'm|it's|you're|we're)\b/i);
  });
});

describe('channelText', () => {
  it('says plainly that qr_only sends no message and shows the QR on Live operations', () => {
    const text = channelText('qr_only');
    expect(text).toContain('QR code on the Live operations screen');
    expect(text).toContain('no message is sent');
  });

  it('names the other channels and handles a missing channel', () => {
    expect(channelText('surge')).toBe('Active channel: Surge text message.');
    expect(channelText('android_gateway')).toContain('Android');
    expect(channelText('whatsapp_sandbox')).toContain('WhatsApp sandbox');
    expect(channelText(undefined)).toContain('did not report');
  });
});

describe('describeIntegrationEvent', () => {
  it('describes a rejected webhook and marks a Square one as payment data', () => {
    const line = describeIntegrationEvent(event('webhook.rejected', {provider: 'square', reason: 'signature_invalid'}));
    expect(line.title).toBe('Rejected a Square webhook because its signature did not match. Nothing changed.');
    expect(line.payment).toBe(true);
  });

  it('describes sheet sync failures with and without retry', () => {
    expect(
      describeIntegrationEvent(event('sync.failed', {target: 'google_sheets', attempts: 1, final: false})).title,
    ).toBe('Report sheet update failed, retrying (attempt 1).');
    expect(describeIntegrationEvent(event('sync.failed', {target: 'google_sheets', attempts: 3, final: true})).title).toContain(
      'will not retry',
    );
  });

  it('describes a failed message without any recipient data', () => {
    const line = describeIntegrationEvent(
      event('message.failed', {dispatchId: 'dsp_1', subjectId: 'ord_1', channel: 'surge', status: 'FAILED'}),
    );
    expect(line.title).toBe('Message failed, show the QR code (Surge text message).');
  });

  it('describes a failed step in plain words', () => {
    const line = describeIntegrationEvent(
      event('execution.failed', {executionId: 'exe_1', actionType: 'square.checkout.create', errorCode: 'INTERNAL', retryable: false, nextStatus: 'FAILED'}),
    );
    expect(line.title).toBe('Step failed: Creating the Square checkout link (sandbox).');
    expect(line.payment).toBe(true);
  });
});

describe('errors', () => {
  it('names the provider for INTEGRATION_UNAVAILABLE and follows retryable', () => {
    const err = new ApiError({code: 'INTEGRATION_UNAVAILABLE', message: 'x', status: 503, retryable: true, kind: 'http', details: {provider: 'google_sheets'}});
    expect(errorText(err)).toBe('Google Sheets is not responding.');
    expect(canRetry(err)).toBe(true);
    const forbidden = new ApiError({code: 'FORBIDDEN_BUSINESS', message: 'x', status: 403, retryable: false, kind: 'http'});
    expect(errorText(forbidden)).toBe('You do not have access to this business.');
    expect(canRetry(forbidden)).toBe(false);
  });
});
