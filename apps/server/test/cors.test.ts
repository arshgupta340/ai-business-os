import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { parseEnv } from '../src/env';

describe('CORS', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp(parseEnv({ WEB_ORIGIN: 'https://web.example.test' }));
  });
  afterAll(async () => {
    await app.close();
  });

  it('answers a preflight from the configured origin', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: {
        origin: 'https://web.example.test',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://web.example.test');
    expect(String(res.headers['access-control-allow-headers'])).toContain('Authorization');
  });

  it('never answers with a wildcard, and does not echo another origin', async () => {
    const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://evil.example.test' } });
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example.test');
  });

  it('defaults to the local web app when WEB_ORIGIN is not set', async () => {
    const local = await buildApp(parseEnv({}));
    const res = await local.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'GET' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    await local.close();
  });

  it('refuses a WEB_ORIGIN that is not a URL', () => {
    expect(() => parseEnv({ WEB_ORIGIN: 'not a url' })).toThrow(/WEB_ORIGIN/);
  });
});
