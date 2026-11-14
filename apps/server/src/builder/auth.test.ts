import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { parseEnv } from '../env';
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

  it('keeps /api/builder/ping open', async () => {
    app = await appWith({});
    const res = await app.inject({ method: 'GET', url: '/api/builder/ping' });
    expect(res.json()).toEqual({ ok: true, lane: 'builder' });
  });
});
