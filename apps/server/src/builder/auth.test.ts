import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { parseEnv } from '../env';
import { FORWARDING_HEADERS, isLocalHost, isLoopbackAddress } from './auth';
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
    // A loopback peer that sends any X-Forwarded-For is a tunnel or proxy, so it is refused.
    const local = await app.inject({
      method: 'POST',
      url: '/api/builder/sessions?businessId=biz_pizza_01',
      headers: { ...AUTH, 'x-forwarded-for': '203.0.113.7' },
      payload: {},
      remoteAddress: '127.0.0.1',
    });
    expect(local.statusCode).toBe(401);
    expect(local.json()).toMatchObject({ code: 'UNAUTHENTICATED', message: 'Development auth accepts requests from this machine only.' });
  });

  it('the dev stand-in refuses each forwarding header from a loopback peer', async () => {
    app = await appWith({ BUILDER_DEV_AUTH: '1' });
    expect(FORWARDING_HEADERS).toEqual([
      'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'cf-connecting-ip', 'cf-ray', 'true-client-ip',
    ]);
    for (const name of FORWARDING_HEADERS) {
      for (const [method, url] of routes) {
        const res = await app.inject({ method, url, headers: { ...AUTH, [name]: '127.0.0.1' }, payload: {}, remoteAddress: '127.0.0.1' });
        expect(res.statusCode, `${name} ${method} ${url}`).toBe(401);
        expect(res.json()).toMatchObject({ code: 'UNAUTHENTICATED', message: 'Development auth accepts requests from this machine only.', retryable: false });
      }
    }
  });

  it('the dev stand-in refuses a tunnel Host from a loopback peer', async () => {
    app = await appWith({ BUILDER_DEV_AUTH: '1' });
    for (const host of ['quick-words-here.trycloudflare.com', 'your-assigned-name.ngrok-free.app', 'abos.example.com:4000', '192.168.1.20:4000', 'localhost.example.com', '127.0.0.1.nip.io']) {
      const res = await app.inject({ method: 'POST', url: '/api/builder/sessions?businessId=biz_pizza_01', headers: { ...AUTH, host }, payload: {}, remoteAddress: '127.0.0.1' });
      expect(res.statusCode, host).toBe(401);
      expect(res.json()).toMatchObject({ code: 'UNAUTHENTICATED', message: 'Development auth accepts requests from this machine only.' });
    }
  });

  it('the dev stand-in accepts a plain local request', async () => {
    app = await appWith({ BUILDER_DEV_AUTH: '1' });
    for (const host of ['localhost', 'localhost:4000', 'LOCALHOST:4000', '127.0.0.1', '127.0.0.1:4000']) {
      const res = await app.inject({ method: 'POST', url: '/api/builder/sessions?businessId=biz_pizza_01', headers: { ...AUTH, host }, payload: {}, remoteAddress: '127.0.0.1' });
      expect(res.statusCode, host).toBe(201);
    }
    // The default Host that app.inject sends (localhost:80) keeps working.
    const plain = await app.inject({ method: 'POST', url: '/api/builder/sessions?businessId=biz_pizza_01', headers: AUTH, payload: {} });
    expect(plain.statusCode).toBe(201);
  });

  it('the dev stand-in accepts the IPv6 loopback Host', async () => {
    app = await appWith({ BUILDER_DEV_AUTH: '1' });
    for (const host of ['[::1]', '[::1]:4000']) {
      const res = await app.inject({ method: 'POST', url: '/api/builder/sessions?businessId=biz_pizza_01', headers: { ...AUTH, host }, payload: {}, remoteAddress: '::1' });
      expect(res.statusCode, host).toBe(201);
    }
  });

  it('reads local Host headers exactly', () => {
    for (const host of ['localhost', 'localhost:80', '127.0.0.1:4000', '[::1]', '[::1]:4000', 'Localhost']) expect(isLocalHost(host), host).toBe(true);
    for (const host of [undefined, '', '::1', '[::1', 'localhost:', 'localhost:4000:1', 'localhost.', 'example.com', '[::2]:4000', '127.0.0.2', 'localhost ', ' localhost']) {
      expect(isLocalHost(host), String(host)).toBe(false);
    }
  });

  it('reads loopback addresses exactly', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress('0.0.0.0')).toBe(false);
    expect(isLoopbackAddress('127.0.0.1 ')).toBe(false);
  });

  it('keeps /api/builder/ping open', async () => {
    app = await appWith({});
    const res = await app.inject({ method: 'GET', url: '/api/builder/ping' });
    expect(res.json()).toEqual({ ok: true, lane: 'builder' });
  });
});
