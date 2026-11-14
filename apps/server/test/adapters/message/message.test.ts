import { describe, expect, it, vi } from 'vitest';
import { createMessageAdapter, maskRecipient, sendOnce } from '../../../src/adapters/message/index';
import { renderBookingConfirmation, renderCheckoutMessage } from '../../../src/adapters/message/templates';
import type { DispatchRecord, MessageAdapter, MessageAdapterConfig, MessageStore } from '../../../src/adapters/message/types';

const to = '+15551234567';
const key = 'a'.repeat(64);
const input = { to, body: 'Approved body', idempotencyKey: key };
const configs = [
  { channel: 'surge', surge: { accountId: 'acct_demo', apiKey: 'fake' } },
  { channel: 'android_gateway', androidGateway: { kind: 'textbee', apiKey: 'fake', deviceId: 'device' } },
  { channel: 'android_gateway', androidGateway: { kind: 'smsgate', baseUrl: 'http://phone:8080', username: 'user', password: 'fake' } },
  { channel: 'whatsapp_sandbox', whatsappSandbox: { accountSid: 'ACdemo', authToken: 'fake', from: 'whatsapp:+14155238886' } },
] satisfies Omit<MessageAdapterConfig, 'fetch'>[];
const responses = [
  { id: 'msg_1', status: 'pending' },
  { data: { success: true, smsBatchId: 'batch_1' } },
  { id: 'sms_1', state: 'Pending' },
  { sid: 'SM1', status: 'queued' },
];

describe.each(configs.map((config, i) => ({ config, i, name: `${config.channel} ${i}` })))('$name', ({ config, i }) => {
  it('sends the documented request with the stable key where supported', async () => {
    const fetch = vi.fn(async () => Response.json(responses[i]));
    const adapter = createMessageAdapter({ ...config, fetch });
    expect(await adapter.send(input)).toMatchObject({ status: 'SENT' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = init.headers as Record<string, string>;
    if (i === 0) {
      expect(url).toBe('https://api.surge.app/accounts/acct_demo/messages');
      expect(headers.Authorization).toBe('Bearer fake');
      expect(JSON.parse(String(init.body))).toEqual({ to, body: input.body, metadata: { idempotency_key: key }, settings: { link_shortening: 'disabled' } });
    } else if (i === 1) {
      expect(url).toBe('https://api.textbee.dev/api/v1/gateway/send-sms');
      expect(headers['x-api-key']).toBe('fake');
      expect(JSON.parse(String(init.body))).toEqual({ recipients: [to], message: input.body, deviceId: 'device' });
    } else if (i === 2) {
      expect(url).toBe('http://phone:8080/message');
      expect(headers.Authorization).toBe(`Basic ${Buffer.from('user:fake').toString('base64')}`);
      expect(JSON.parse(String(init.body))).toEqual({ id: key.slice(0, 36), textMessage: { text: input.body }, phoneNumbers: [to] });
    } else {
      expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/ACdemo/Messages.json');
      expect(headers.Authorization).toBe(`Basic ${Buffer.from('ACdemo:fake').toString('base64')}`);
      expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ To: `whatsapp:${to}`, From: 'whatsapp:+14155238886', Body: input.body });
    }
  });

  it.each([400, 401, 403, 404, 422, 429])('refuses HTTP %i with a contract error code', async (status) => {
    const adapter = createMessageAdapter({ ...config, fetch: async () => Response.json({ message: to }, { status }) });
    expect(await adapter.send(input)).toEqual({ status: 'FAILED', errorCode: status === 429 ? 'RATE_LIMITED' : 'INTEGRATION_UNAVAILABLE' });
  });

  it.each([408, 409, 500, 503])('treats HTTP %i as unknown', async (status) => {
    const fetch = vi.fn(async () => new Response('', { status }));
    expect(await createMessageAdapter({ ...config, fetch }).send(input)).toEqual({ status: 'UNKNOWN', errorCode: 'INTEGRATION_UNAVAILABLE' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('treats malformed and unrecognized success bodies as unknown', async () => {
    for (const body of ['not json', '{}', '']) {
      expect(await createMessageAdapter({ ...config, fetch: async () => new Response(body) }).send(input)).toMatchObject({ status: 'UNKNOWN' });
    }
  });

  it('sanitizes network errors and does not retry', async () => {
    const fetch = vi.fn(async () => { throw new Error(`secret ${to}`); });
    const result = await createMessageAdapter({ ...config, fetch }).send(input);
    expect(result.status).toBe('UNKNOWN');
    expect(JSON.stringify(result)).not.toContain(to);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('times out even if the injected fetch ignores abort', async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    expect(await createMessageAdapter({ ...config, fetch, timeoutMs: 5 }).send(input)).toMatchObject({ status: 'UNKNOWN' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid recipients before fetch', async () => {
    const fetch = vi.fn(async () => Response.json(responses[i]));
    const adapter = createMessageAdapter({ ...config, fetch });
    expect(await adapter.send({ ...input, to: `invalid ${to}` })).toEqual({ status: 'FAILED', errorCode: 'VALIDATION_FAILED' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects invalid stable keys before fetch', async () => {
    const fetch = vi.fn();
    expect(await createMessageAdapter({ ...config, fetch }).send({ ...input, idempotencyKey: 'not-a-stable-key' })).toEqual({ status: 'FAILED', errorCode: 'VALIDATION_FAILED' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not mark explicit provider failure as sent', async () => {
    const failures = [{ id: 'msg_1', status: 'failed' }, { data: { success: false } }, { id: 'sms_1', state: 'Failed' }, { sid: 'SM1', status: 'undelivered' }];
    expect(await createMessageAdapter({ ...config, fetch: async () => Response.json(failures[i]) }).send(input)).toMatchObject({ status: 'FAILED' });
  });

  it('does not infer success from an id with an unknown or absent state', async () => {
    const bodies = [{ id: 'msg_1', status: 'mystery' }, { data: { smsBatchId: 'batch_1' } }, { id: 'sms_1' }, { sid: 'SM1' }];
    expect(await createMessageAdapter({ ...config, fetch: async () => Response.json(bodies[i]) }).send(input)).toMatchObject({ status: 'UNKNOWN' });
  });

  it('bounds response body reads as well as fetch', async () => {
    const fetch = vi.fn(async () => ({ status: 200, json: () => new Promise<unknown>(() => {}) }) as Response);
    expect(await createMessageAdapter({ ...config, fetch, timeoutMs: 5 }).send(input)).toMatchObject({ status: 'UNKNOWN' });
  });

  it('suppresses a response that echoes the recipient as the provider id', async () => {
    const bodies = [{ id: to, status: 'sent' }, { data: { success: true, smsBatchId: to } }, { id: to, state: 'Sent' }, { sid: to, status: 'sent' }];
    const result = await createMessageAdapter({ ...config, fetch: async () => Response.json(bodies[i]) }).send(input);
    expect(result.status).toBe('UNKNOWN');
    expect(JSON.stringify(result)).not.toContain(to);
  });
});

function memoryStore(initial?: DispatchRecord) {
  const records = new Map<string, DispatchRecord>(initial ? [[key, initial]] : []);
  const events: string[] = [];
  const store: MessageStore = {
    async findByKey(k) { return records.get(k); },
    async recordAttempt(record) {
      if (records.has(record.idempotencyKey)) return false;
      records.set(record.idempotencyKey, record);
      events.push('attempt');
      return true;
    },
    async recordOutcome(k, outcome) {
      const existing = records.get(k);
      if (!existing) throw new Error('Missing attempt');
      records.set(k, { ...existing, ...outcome });
      events.push('outcome');
    },
  };
  return { store, records, events };
}
const dispatch = { dispatchKey: key, to, body: input.body };
const record = (status: DispatchRecord['status']): DispatchRecord => ({ idempotencyKey: key, channel: 'surge', status, providerMessageId: 'msg_1' });

describe('sendOnce', () => {
  it('records before send and deduplicates sequential and concurrent calls', async () => {
    const { store, events } = memoryStore();
    const send = vi.fn(async () => { events.push('send'); return { status: 'SENT' as const, providerMessageId: 'msg_1' }; });
    const adapter: MessageAdapter = { channel: 'surge', send };
    await Promise.all(Array.from({ length: 12 }, () => sendOnce(store, adapter, dispatch)));
    await sendOnce(store, adapter, dispatch);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(input);
    expect(events).toEqual(['attempt', 'send', 'outcome']);
  });

  it.each(['SENT', 'DELIVERED', 'UNKNOWN', 'QUEUED', 'FAILED'] as const)('does not resend an existing %s', async (status) => {
    const { store } = memoryStore(record(status));
    const send = vi.fn();
    const result = await sendOnce(store, { channel: 'surge', send }, dispatch);
    expect(result.status).toBe(status);
    expect(result.needsReview).toBe(status === 'UNKNOWN' || status === 'QUEUED');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not create a row or contact a provider for qr_only, even without a recipient', async () => {
    const fetch = vi.fn();
    const { store, events } = memoryStore();
    const adapter = createMessageAdapter({ channel: 'qr_only', fetch });
    expect(await adapter.send({ ...input, to: '' })).toEqual({ status: 'SKIPPED' });
    expect(await sendOnce(store, adapter, { ...dispatch, to: '' })).toEqual({ status: 'SKIPPED', needsReview: false });
    expect(events).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('records UNKNOWN when an injected adapter throws and does not resend', async () => {
    const { store, records } = memoryStore();
    const send = vi.fn(async () => { throw new Error(to); });
    const result = await sendOnce(store, { channel: 'surge', send }, dispatch);
    expect(result).toMatchObject({ status: 'UNKNOWN', needsReview: true });
    expect(JSON.stringify(result)).not.toContain(to);
    expect(records.get(key)?.status).toBe('UNKNOWN');
    await sendOnce(store, { channel: 'surge', send }, dispatch);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the atomic attempt gate throws', async () => {
    const { store } = memoryStore();
    store.recordAttempt = async () => { throw new Error(to); };
    const send = vi.fn();
    const result = await sendOnce(store, { channel: 'surge', send }, dispatch);
    expect(result).toMatchObject({ status: 'UNKNOWN', needsReview: true });
    expect(JSON.stringify(result)).not.toContain(to);
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a bad number before recording or sending', async () => {
    const { store, events } = memoryStore();
    const send = vi.fn();
    expect(await sendOnce(store, { channel: 'surge', send }, { ...dispatch, to: `bad ${to}` })).toMatchObject({ status: 'FAILED', errorCode: 'VALIDATION_FAILED' });
    expect(send).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('persists an ambiguous provider result before suppressing the next attempt', async () => {
    const { store, records } = memoryStore();
    const send = vi.fn(async () => ({ status: 'UNKNOWN' as const, errorCode: 'INTEGRATION_UNAVAILABLE' as const }));
    const adapter: MessageAdapter = { channel: 'surge', send };
    expect(await sendOnce(store, adapter, dispatch)).toMatchObject({ status: 'UNKNOWN', needsReview: true });
    expect(records.get(key)?.status).toBe('UNKNOWN');
    await sendOnce(store, adapter, dispatch);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not resend if recording the outcome fails after sending', async () => {
    const { store, records } = memoryStore();
    store.recordOutcome = async () => { throw new Error(to); };
    const send = vi.fn(async () => ({ status: 'SENT' as const, providerMessageId: 'msg_1' }));
    const adapter: MessageAdapter = { channel: 'surge', send };
    const result = await sendOnce(store, adapter, dispatch);
    expect(result).toMatchObject({ status: 'UNKNOWN', needsReview: true });
    expect(JSON.stringify(result)).not.toContain(to);
    expect(records.get(key)?.status).toBe('QUEUED');
    await sendOnce(store, adapter, dispatch);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not send when finding the existing record fails', async () => {
    const { store } = memoryStore();
    store.findByKey = async () => { throw new Error(to); };
    const send = vi.fn();
    const result = await sendOnce(store, { channel: 'surge', send }, dispatch);
    expect(result).toMatchObject({ status: 'UNKNOWN', needsReview: true });
    expect(JSON.stringify(result)).not.toContain(to);
    expect(send).not.toHaveBeenCalled();
  });

  it('does not send when the insert loses a race and the winning row cannot be read', async () => {
    const { store } = memoryStore();
    store.recordAttempt = async () => false;
    const send = vi.fn();
    expect(await sendOnce(store, { channel: 'surge', send }, dispatch)).toMatchObject({ status: 'UNKNOWN', needsReview: true });
    expect(send).not.toHaveBeenCalled();
  });

  it('requires a provider id before recording SENT', async () => {
    const { store, records } = memoryStore();
    const send = vi.fn(async () => ({ status: 'SENT' as const }));
    expect(await sendOnce(store, { channel: 'surge', send }, dispatch)).toMatchObject({ status: 'UNKNOWN', needsReview: true });
    expect(records.get(key)?.status).toBe('UNKNOWN');
  });
});

describe('configuration and templates', () => {
  it('selects the SMSGate cloud endpoint and normalizes the trailing slash', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ id: 'sms_1', state: 'Pending' }, { status: 202 }));
    const result = await createMessageAdapter({ channel: 'android_gateway', fetch, androidGateway: { kind: 'smsgate', baseUrl: 'https://api.sms-gate.app/3rdparty/v1/', username: 'user', password: 'fake', deviceId: 'device' } }).send(input);
    expect(result).toEqual({ status: 'SENT', providerMessageId: 'sms_1' });
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.sms-gate.app/3rdparty/v1/messages');
  });

  it('does not expose invalid URL values or full phone numbers in thrown errors', () => {
    const config: MessageAdapterConfig = { channel: 'surge', fetch: vi.fn(), surge: { accountId: 'acct', apiKey: 'fake', baseUrl: `not a URL ${to}` } };
    try { createMessageAdapter(config); throw new Error('Expected invalid configuration'); }
    catch (error) {
      expect(String(error)).toContain('SURGE_BASE_URL');
      expect(String(error)).not.toContain(to);
      expect(String(error)).not.toContain('not a URL');
    }
  });

  it('accepts SMSGate acknowledgments with numeric runs in the stable id', async () => {
    const stable = '1234567' + 'a'.repeat(57);
    const fetch = vi.fn(async () => Response.json({ id: stable.slice(0, 36), state: 'Pending' }));
    const adapter = createMessageAdapter({ ...configs[2], fetch });
    expect(await adapter.send({ ...input, idempotencyKey: stable })).toEqual({ status: 'SENT', providerMessageId: stable.slice(0, 36) });
  });

  it('names missing settings without echoing values', () => {
    expect(() => createMessageAdapter({ fetch: vi.fn() })).toThrow('MESSAGE_CHANNEL');
    expect(() => createMessageAdapter({ channel: 'surge', fetch: vi.fn() })).toThrow('SURGE_API_KEY');
    expect(() => createMessageAdapter({ channel: 'android_gateway', fetch: vi.fn() })).toThrow('ANDROID_GATEWAY_KIND');
    expect(() => createMessageAdapter({ channel: 'whatsapp_sandbox', fetch: vi.fn() })).toThrow('TWILIO_ACCOUNT_SID');
  });

  it('puts the link alone at the end and labels the test payment', () => {
    const url = 'https://square.link/u/test';
    expect(renderCheckoutMessage({ businessName: 'Demo Pizza Co.', url })).toEqual({ templateKey: 'checkout_link', body: `Demo Pizza Co.: pay for your pickup order here. Sandbox test payment.\n${url}` });
  });

  it('confirms only the service, local time and timezone', () => {
    expect(renderBookingConfirmation({ businessName: 'Demo Barbershop', serviceName: 'Haircut', startLocal: 'November 15 at 10:00 AM', timezone: 'America/Los_Angeles' })).toEqual({ templateKey: 'booking_confirmed', body: 'Demo Barbershop: your Haircut appointment is confirmed for November 15 at 10:00 AM, time zone America/Los_Angeles' });
  });

  it('ends every template without trailing punctuation and the checkout message with the link', () => {
    const url = 'https://sandbox.square.link/u/abc123';
    const checkout = renderCheckoutMessage({ businessName: 'Demo Pizza Co.', url }).body;
    const booking = renderBookingConfirmation({ businessName: 'Demo Barbershop', serviceName: 'Haircut', startLocal: 'November 15 at 10:00 AM', timezone: 'America/Los_Angeles' }).body;
    expect(checkout.endsWith(`\n${url}`)).toBe(true);
    expect(checkout).toMatch(/test payment/i);
    for (const body of [checkout, booking]) expect(body).not.toMatch(/[.,;:!?)\]'"]$/);
  });

  it('refuses a link that is not http, ends in punctuation, or a field with a line break', () => {
    expect(() => renderCheckoutMessage({ businessName: 'Demo', url: 'javascript:alert(1)' })).toThrow('url');
    expect(() => renderCheckoutMessage({ businessName: 'Demo', url: 'https://square.link/u/test.' })).toThrow('url');
    expect(() => renderCheckoutMessage({ businessName: 'Demo\nCall me', url: 'https://square.link/u/test' })).toThrow('businessName');
    expect(() => renderBookingConfirmation({ businessName: 'Demo', serviceName: '', startLocal: 'x', timezone: 'UTC' })).toThrow('serviceName');
  });
});

describe('provider specifics and masking', () => {
  it('maps the Surge demo message cap to RATE_LIMITED without returning the provider body', async () => {
    const fetch = vi.fn(async () => Response.json({ error: { type: 'demo_message_limit', message: `limit for ${to}` } }, { status: 403 }));
    const result = await createMessageAdapter({ ...configs[0], fetch }).send(input);
    expect(result).toEqual({ status: 'FAILED', errorCode: 'RATE_LIMITED' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('maps a repeated SMSGate id (409) to UNKNOWN, not SENT', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 409 }));
    expect(await createMessageAdapter({ ...configs[2], fetch }).send(input)).toEqual({ status: 'UNKNOWN', errorCode: 'INTEGRATION_UNAVAILABLE' });
  });

  it('defaults the WhatsApp sender to the sandbox number', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ sid: 'SM1', status: 'queued' }, { status: 201 }));
    await createMessageAdapter({ channel: 'whatsapp_sandbox', fetch, whatsappSandbox: { accountSid: 'ACdemo', authToken: 'fake' } }).send(input);
    const init = fetch.mock.calls[0]?.[1];
    expect(new URLSearchParams(String(init?.body)).get('From')).toBe('whatsapp:+14155238886');
  });

  it('masks a phone number to its last four digits', () => {
    expect(maskRecipient(to)).toBe('***4567');
    expect(maskRecipient('12')).toBe('***');
  });

  it('puts no full phone number in any configuration error', () => {
    const bad: MessageAdapterConfig[] = [
      { channel: 'whatsapp_sandbox', fetch: vi.fn(), whatsappSandbox: { accountSid: 'AC', authToken: 'fake', from: `bad${to}x` } },
      { channel: 'android_gateway', fetch: vi.fn(), androidGateway: { kind: 'smsgate', baseUrl: `ftp://${to}`, username: 'u', password: 'p' } },
    ];
    for (const config of bad) {
      expect(() => createMessageAdapter(config)).toThrow();
      try { createMessageAdapter(config); } catch (error) { expect(String(error)).not.toContain(to.slice(1)); }
    }
  });
});
