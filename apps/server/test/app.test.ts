import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { parseEnv } from '../src/env';

describe('environment', () => {
  it('defaults to the Square sandbox', () => {
    expect(parseEnv({}).SQUARE_ENVIRONMENT).toBe('sandbox');
  });

  it('refuses any Square environment other than sandbox (AC-19)', () => {
    expect(() => parseEnv({ SQUARE_ENVIRONMENT: 'production' })).toThrow(/sandbox/);
  });

  it('reads the port', () => {
    expect(parseEnv({ PORT: '4321' }).PORT).toBe(4321);
  });
});

describe('server skeleton', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp(parseEnv({}));
  });
  afterAll(async () => {
    await app.close();
  });

  it('answers GET /health and labels the sandbox', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, squareEnvironment: 'sandbox' });
  });

  it('puts a correlation ID on every response', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-correlation-id']).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
  });

  it('keeps a well formed caller correlation ID and replaces a bad one', async () => {
    const good = await app.inject({ method: 'GET', url: '/health', headers: { 'x-correlation-id': 'abc12345-test' } });
    expect(good.headers['x-correlation-id']).toBe('abc12345-test');
    const bad = await app.inject({ method: 'GET', url: '/health', headers: { 'x-correlation-id': 'not ok!' } });
    expect(bad.headers['x-correlation-id']).not.toBe('not ok!');
  });

  it('returns the standard error envelope for an unknown route', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NOT_FOUND', retryable: false });
    expect(res.json().correlationId).toBe(res.headers['x-correlation-id']);
  });

  it('registers the builder plugin: its routes exist and refuse a request without a token', async () => {
    await app.ready();
    const builderRoutes = app.routeInventory().filter((r) => r.auth === 'builder').map((r) => `${r.method} ${r.url}`);
    expect(builderRoutes).toEqual(expect.arrayContaining(['POST /api/builder/sessions', 'GET /api/agents', 'POST /api/agents/:id/publish']));
    const res = await app.inject({ method: 'POST', url: '/api/builder/sessions?businessId=biz_pizza_01', payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('has no builder ping route (issue #96): the path is not registered and answers no 200', async () => {
    await app.ready();
    expect(app.routeInventory().filter((r) => r.url.includes('ping'))).toEqual([]);
    const res = await app.inject({ method: 'GET', url: '/api/builder/ping' });
    expect([401, 404]).toContain(res.statusCode);
  });
});
