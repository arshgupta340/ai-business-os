import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { builderPlugin } from './index';

// Every route the builder registers declares route config { auth: 'builder' },
// so the server's default-deny guard (auth/verify.ts) leaves it to the
// builder's own BuilderAuth. The plugin is registered on a bare Fastify, with
// no wrapper that would add the policy for it.

describe('builder route auth declaration', () => {
  it('every route the plugin registers declares auth: builder', async () => {
    const app = Fastify({ logger: false });
    const routes: { method: string | string[]; url: string; config?: unknown }[] = [];
    // The route options object is kept by reference: the plugin's own hook sets config.auth after this one runs.
    app.addHook('onRoute', (route) => {
      routes.push(route);
    });
    await app.register(builderPlugin, { env: { OPENAI_API_KEY: '' } });
    await app.ready();

    const inventory = routes.flatMap((r) => (Array.isArray(r.method) ? r.method : [r.method]).map((method) => ({
      route: `${method} ${r.url}`,
      auth: (r.config as { auth?: unknown } | undefined)?.auth,
    })));
    const urls = inventory.map((r) => r.route);
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
    expect(inventory.filter((r) => r.auth !== 'builder')).toEqual([]);
    await app.close();
  });
});
