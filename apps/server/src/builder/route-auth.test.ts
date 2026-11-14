import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../errors';
import { UnverifiedSeedOwnerAuth } from './auth';
import { builderPlugin } from './index';

// Every route the builder registers declares route config { auth: 'builder' },
// so the server's default-deny guard (auth/verify.ts) leaves it to the
// builder's own BuilderAuth. That makes the builder alone responsible: a route
// that forgets requireBusiness is open. The plugin is registered on a bare
// Fastify, with no wrapper that would add a policy for it, and the routes are
// the ones Fastify registered (its onRoute hook), not a list written here.

interface Registered {
  method: string;
  url: string;
  auth: unknown;
}

async function builderApp(): Promise<{ app: FastifyInstance; routes: Registered[] }> {
  const app = Fastify({ logger: false });
  const options: { method: string | string[]; url: string; config?: unknown }[] = [];
  // The route options object is kept by reference: the plugin's own hook sets config.auth after this one runs.
  app.addHook('onRoute', (route) => {
    options.push(route);
  });
  // The server's error envelope, reduced to what this test reads.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.status(error.status).send({ code: error.code });
    return reply.status(500).send({ code: 'INTERNAL' });
  });
  // The real dev stand-in. inject() comes from 127.0.0.1, so the stand-in
  // runs, and a request with no Authorization header has no owner.
  await app.register(builderPlugin, { env: { OPENAI_API_KEY: '' }, auth: new UnverifiedSeedOwnerAuth() });
  await app.ready();
  const routes = options.flatMap((r) => (Array.isArray(r.method) ? r.method : [r.method]).map((method) => ({
    method,
    url: r.url,
    auth: (r.config as { auth?: unknown } | undefined)?.auth,
  })));
  return { app, routes };
}

// A concrete URL for a route pattern: every path parameter gets a sample
// value. A business in the path must look like a business ID, because the
// upload route reads it as the business scope.
function concrete(url: string): string {
  const path = url.replace(/^\/api\/businesses\/:id\//, '/api/businesses/biz_pizza_01/').replace(/:[A-Za-z]+/g, 'x_route_auth_01');
  return `${path}?businessId=biz_pizza_01`;
}

// The only routes allowed to answer without an owner. Adding one here is a
// decision, not a way to make the test pass.
const OPEN_ROUTES = new Set(['/api/builder/ping']);

let open: FastifyInstance | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

describe('builder route auth', () => {
  it('every route the plugin registers declares auth: builder', async () => {
    const { app, routes } = await builderApp();
    open = app;
    const urls = routes.map((r) => `${r.method} ${r.url}`);
    // The inventory covers every part of the plugin: sessions, agents, publish, extraction and voice.
    for (const expected of [
      'POST /api/builder/sessions',
      'POST /api/agents/:id/publish',
      'POST /api/agents/:id/rollback',
      'POST /api/businesses/:id/files',
      'POST /api/conflicts/:id/resolve',
    ]) {
      expect(urls).toContain(expected);
    }
    expect(urls.some((u) => u.includes('realtime'))).toBe(true);
    expect(routes.filter((r) => r.auth !== 'builder')).toEqual([]);
  });

  it('every route the plugin registers answers 401 UNAUTHENTICATED with no token', async () => {
    const { app, routes } = await builderApp();
    open = app;
    expect(routes.length).toBeGreaterThan(10);
    const open401: string[] = [];
    for (const route of routes.filter((r) => !OPEN_ROUTES.has(r.url))) {
      const res = await app.inject({ method: route.method as 'GET', url: concrete(route.url), ...(route.method === 'GET' || route.method === 'HEAD' ? {} : { payload: {} }) });
      // A HEAD response has no body, so only its status is checked.
      const code = route.method === 'HEAD' ? 'UNAUTHENTICATED' : res.json().code;
      if (res.statusCode !== 401 || code !== 'UNAUTHENTICATED') open401.push(`${route.method} ${route.url}: ${res.statusCode} ${code}`);
    }
    expect(open401).toEqual([]);
  });

  it('the check can fail: a route without requireBusiness is found', async () => {
    const app = Fastify({ logger: false });
    open = app;
    const options: { method: string | string[]; url: string }[] = [];
    app.addHook('onRoute', (route) => {
      options.push(route);
    });
    await app.register(async (scope) => {
      await builderPlugin(scope, { env: { OPENAI_API_KEY: '' }, auth: new UnverifiedSeedOwnerAuth() });
      scope.get('/api/agents/:id/forgot-auth', async () => ({ ok: true }));
    });
    await app.ready();
    const found: string[] = [];
    for (const r of options.filter((o) => o.method === 'GET' && !OPEN_ROUTES.has(o.url))) {
      const res = await app.inject({ method: 'GET', url: concrete(r.url) });
      if (res.statusCode !== 401) found.push(r.url);
    }
    expect(found).toEqual(['/api/agents/:id/forgot-auth']);
  });
});
