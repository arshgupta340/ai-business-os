// Issue #94 item 2: MESSAGE_CHANNEL=android_gateway must not crash startup. The gateway kind and its
// credentials are read from the environment; a missing or wrong setting is reported, never thrown.
import { describe, expect, it } from 'vitest';
import { buildProviders } from '../../src/compose/providers';
import { parseEnv } from '../../src/env';

const now = () => new Date();

describe('android gateway configuration', () => {
  it('builds a textbee sender from URL, key and kind', () => {
    const p = buildProviders(parseEnv({ MESSAGE_CHANNEL: 'android_gateway', ANDROID_GATEWAY_KIND: 'textbee', ANDROID_GATEWAY_URL: 'https://gateway.example.test', ANDROID_GATEWAY_API_KEY: 'k' }), now);
    expect(p.message?.channel).toBe('android_gateway');
    expect(p.status.message_channel.configured).toBe(true);
  });

  it('builds an SMSGate sender with username and password', () => {
    const p = buildProviders(parseEnv({ MESSAGE_CHANNEL: 'android_gateway', ANDROID_GATEWAY_KIND: 'smsgate', ANDROID_GATEWAY_URL: 'https://gateway.example.test',
      ANDROID_GATEWAY_USERNAME: 'u', ANDROID_GATEWAY_PASSWORD: 'p' }), now);
    expect(p.message?.channel).toBe('android_gateway');
  });

  it('reports a missing kind or credential instead of throwing at startup', () => {
    const noKind = buildProviders(parseEnv({ MESSAGE_CHANNEL: 'android_gateway', ANDROID_GATEWAY_URL: 'https://gateway.example.test', ANDROID_GATEWAY_API_KEY: 'k' }), now);
    expect(noKind.message).toBeUndefined();
    expect(noKind.status.message_channel).toMatchObject({ configured: false, detail: expect.stringContaining('ANDROID_GATEWAY_KIND') });
    const noPassword = buildProviders(parseEnv({ MESSAGE_CHANNEL: 'android_gateway', ANDROID_GATEWAY_KIND: 'smsgate', ANDROID_GATEWAY_URL: 'https://gateway.example.test', ANDROID_GATEWAY_USERNAME: 'u' }), now);
    expect(noPassword.status.message_channel).toMatchObject({ configured: false, detail: expect.stringContaining('ANDROID_GATEWAY_PASSWORD') });
  });

  it('reads TWILIO_WHATSAPP_FROM for the WhatsApp sandbox and reports a bad one', () => {
    const bad = buildProviders(parseEnv({ MESSAGE_CHANNEL: 'whatsapp_sandbox', TWILIO_ACCOUNT_SID: 'ACx', TWILIO_AUTH_TOKEN: 't', TWILIO_WHATSAPP_FROM: 'not-a-number' }), now);
    expect(bad.message).toBeUndefined();
    expect(bad.status.message_channel).toMatchObject({ configured: false, detail: expect.stringContaining('TWILIO_WHATSAPP_FROM') });
  });
});
