import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { parseEnv } from '../env';
import { isLoopbackAddress } from './auth';
import { builderAuthMode } from './env';

// The builder fails closed: with no auth option, only BUILDER_DEV_AUTH=1 (and
// never with NODE_ENV=production) lets the unverified stand-in run.

const AUTH = { authorization: 'Bearer any-token' };

async function appWith(env: Record<string, string>): Promise<FastifyInstance> {
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('BUILDER_DEV_AUTH', '');
  vi.stubEnv('NODE_ENV', 'test');
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return buildApp(parseEnv({}));
}

const routes = [
  ['POST', '/api/builder/sessions?businessId=biz_pizza_01'],
  ['GET', '/api/builder/sessions/bld_abc?businessId=biz_pizza_01'],
  ['POST', '/api/builder/sessions/bld_abc/messages?businessId=biz_pizza_01'],
  ['GET', '/api/agents?businessId=biz_pizza_01'],
  ['POST', '/api/agents?businessId=biz_pizza_01'],
  ['GET', '/api/agents/agt_abc?businessId=biz_pizza_01'],
  ['POST', '/api/agents/agt_abc/preview?businessId=biz_pizza_01'],
  ['POST', '/api/agents/agt_abc/test?businessId=biz_pizza_01'],
] as const;

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.unstubAllEnvs();
});

async function expectAllUnauthenticated(instance: FastifyInstance) {
  for (const [method, url] of routes) {
    const res = await instance.inject({ method, url, headers: AUTH, payload: {} });
    expect(res.statusCode, `${method} ${url}`).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHENTICATED', message: 'Builder auth is not configured.', retryable: false });
  }
}

describe('builder auth fails closed', () => {
  it('reads the opt-in exactly', () => {
    expect(builderAuthMode({})).toBe('not_configured');
    expect(builderAuthMode({ BUILDER_DEV_AUTH: 'true' })).toBe('not_configured');
    expect(builderAuthMode({ BUILDER_DEV_AUTH: '1' })).toBe('dev');
    expect(builderAuthMode({ BUILDER_DEV_AUTH: '1', NODE_ENV: 'production' })).toBe('refused_in_production');
  });

  it('answers UNAUTHENTICATED by default, even with a bearer header', async () => {
    app = await appWith({});
    await expectAllUnauthenticated(app);
  });

  it('refuses the opt-in when NODE_ENV is production', async () => {
    app = await appWith({ BUILDER_DEV_AUTH: '1', NODE_ENV: 'production' });
    await expectAllUnauthenticated(app);
  });

  it('works with the opt-in outside production', async () => {
    app = await appWith({ BUILDER_DEV_AUTH: '1' });
    const res = await app.inject({ method: 'POST', url: '/api/builder/sessions?businessId=biz_pizza_01', headers: AUTH, payload: {} });
    expect(res.statusCode).toBe(201);
  });

  it('the dev stand-in answers loopback addresses only', async () => {
    app = await appWith({ BUILDER_DEV_AUTH: '1' });
    for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const res = await app.inject({ method: 'POST', url: '/api/builder/sessions?businessId=biz_pizza_01', headers: AUTH, payload: {}, remoteAddress });
      expect(res.statusCode, remoteAddress).toBe(201);
    }
    for (const remoteAddress of ['192.168.1.20', '10.0.0.5', '::ffff:192.168.1.20', 'fe80::1', '127.0.0.2']) {
      for (const [method, url] of routes) {
        const res = await app.inject({ method, url, headers: AUTH, payload: {}, remoteAddress });
        expect(res.statusCode, `${remoteAddress} ${method} ${url}`).toBe(401);
        expect(res.json()).toMatchObject({ code: 'UNAUTHENTICATED', message: 'Development auth accepts requests from this machine only.', retryable: false });
      }
    }
  });

  it('the dev stand-in does not trust X-Forwarded-For', async () => {
    app = await appWith({ BUILDER_DEV_AUTH: '1' });
    const spoofed = await app.inject({
      method: 'POST',
      url: '/api/builder/sessions?businessId=biz_pizza_01',
      headers: { ...AUTH, 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' },
      payload: {},
      remoteAddress: '203.0.113.7',
    });
    expect(spoofed.statusCode).toBe(401);
    expect(spoofed.json().code).toBe('UNAUTHENTICATED');
    // A loopback peer that sends a foreign X-Forwarded-For is still the loopback peer.
    const local = await app.inject({
      method: 'POST',
      url: '/api/builder/sessions?businessId=biz_pizza_01',
      headers: { ...AUTH, 'x-forwarded-for': '203.0.113.7' },
      payload: {},
      remoteAddress: '127.0.0.1',
    });
    expect(local.statusCode).toBe(201);
  });

  it('reads loopback addresses exactly', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress('0.0.0.0')).toBe(false);
    expect(isLoopbackAddress('127.0.0.1 ')).toBe(false);
  });
});
