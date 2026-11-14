import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../app';
import { parseEnv } from '../../env';
import { UnverifiedSeedOwnerAuth } from '../auth';
import { builderPlugin } from '../index';
import { ToolNameSchema } from '../pending-contracts';
import type { RealtimeMinter } from './minter';
import { MINTS_PER_WINDOW } from './index';

// Route tests for POST /api/realtime/client-secret through buildApp and
// app.inject. OpenAI is never called: in "openai" mode the global fetch is
// replaced by a fake OpenAI that records the request. The key below is fake.

const FAKE_KEY = 'sk-test-FAKE-KEY-never-real-0123456789abcdef';
const FAKE_SECRET = 'ek_test_fake_client_secret_42';
const AUTH = { authorization: 'Bearer test-token' };
const PIZZA = 'businessId=biz_pizza_01';
const BARBER = 'businessId=biz_barber_01';
const NOW = new Date('2026-11-13T18:00:00Z');
const EXPIRES_AT = Math.floor(NOW.getTime() / 1000) + 60;

type FetchCall = { url: string; init: RequestInit };

function fakeOpenAi(respond: () => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

const okResponse = () =>
  new Response(JSON.stringify({ value: FAKE_SECRET, expires_at: EXPIRES_AT, session: { type: 'realtime', tools: [] } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

let app: FastifyInstance | undefined;

async function appWith(env: Record<string, string>) {
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('OPENAI_BUILDER_MODEL', '');
  vi.stubEnv('OPENAI_REALTIME_MODEL', '');
  vi.stubEnv('BUILDER_DEV_AUTH', '1');
  vi.stubEnv('NODE_ENV', 'test');
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  app = await buildApp(parseEnv({}));
  return app;
}

const OPENAI_ENV = { OPENAI_API_KEY: FAKE_KEY, OPENAI_BUILDER_MODEL: 'test-builder-model', OPENAI_REALTIME_MODEL: 'gpt-realtime-2.1' };

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function newSession(instance: FastifyInstance, query = PIZZA): Promise<string> {
  const res = await instance.inject({ method: 'POST', url: `/api/builder/sessions?${query}`, headers: AUTH, payload: {} });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

function mint(instance: FastifyInstance, body: unknown, query = PIZZA, headers: Record<string, string> = AUTH) {
  return instance.inject({ method: 'POST', url: `/api/realtime/client-secret?${query}`, headers, payload: body as object });
}

describe('POST /api/realtime/client-secret: who may mint', () => {
  it('refuses a request with no bearer token', async () => {
    const a = await appWith(OPENAI_ENV);
    const calls = fakeOpenAi(okResponse);
    const res = await mint(a, { builderSessionId: 'bld_abc' }, PIZZA, {});
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHENTICATED');
    expect(calls).toHaveLength(0);
  });

  it('refuses everything when builder auth is not configured (fail closed)', async () => {
    const a = await appWith({ ...OPENAI_ENV, BUILDER_DEV_AUTH: '' });
    const calls = fakeOpenAi(okResponse);
    const res = await mint(a, { builderSessionId: 'bld_abc' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHENTICATED');
    expect(calls).toHaveLength(0);
  });

  it('refuses a business the owner does not own, and a missing businessId', async () => {
    const a = await appWith(OPENAI_ENV);
    const calls = fakeOpenAi(okResponse);
    const forbidden = await mint(a, { builderSessionId: 'bld_abc' }, 'businessId=biz_other_01');
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().code).toBe('FORBIDDEN_BUSINESS');
    expect((await mint(a, { builderSessionId: 'bld_abc' }, '')).json().code).toBe('VALIDATION_FAILED');
    expect(calls).toHaveLength(0);
  });

  it('refuses an unknown session and a session from another business with NOT_FOUND', async () => {
    const a = await appWith(OPENAI_ENV);
    const calls = fakeOpenAi(okResponse);
    const unknown = await mint(a, { builderSessionId: 'bld_does_not_exist' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe('NOT_FOUND');

    const barberSession = await newSession(a, BARBER);
    const foreign = await mint(a, { builderSessionId: barberSession }, PIZZA);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().code).toBe('NOT_FOUND');
    expect(calls).toHaveLength(0);
  });

  it('validates the body: a builderSessionId is required and nothing else is accepted', async () => {
    const a = await appWith(OPENAI_ENV);
    fakeOpenAi(okResponse);
    const id = await newSession(a);
    expect((await mint(a, {})).json().code).toBe('VALIDATION_FAILED');
    expect((await mint(a, { builderSessionId: 'agt_x' })).json().code).toBe('VALIDATION_FAILED');
    // The browser cannot send its own session settings or tools.
    const extra = await mint(a, { builderSessionId: id, tools: [{ type: 'function', name: 'propose_order' }] });
    expect(extra.statusCode).toBe(400);
    expect(extra.json().code).toBe('VALIDATION_FAILED');
  });
});

describe('POST /api/realtime/client-secret: minting', () => {
  it('returns the documented shape and sends the server-bound session to OpenAI', async () => {
    const a = await appWith(OPENAI_ENV);
    const calls = fakeOpenAi(okResponse);
    const id = await newSession(a);
    const res = await mint(a, { builderSessionId: id });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      clientSecret: FAKE_SECRET,
      expiresAt: new Date(EXPIRES_AT * 1000).toISOString(),
      model: 'gpt-realtime-2.1',
      builderSessionId: id,
    });
    expect(res.headers['cache-control']).toBe('no-store');

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://api.openai.com/v1/realtime/client_secrets');
    expect(call.init.method).toBe('POST');
    // The key is used here, in the request to OpenAI, and nowhere else.
    expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_KEY}`);
    const sent = JSON.parse(String(call.init.body));
    expect(sent.expires_after).toEqual({ anchor: 'created_at', seconds: 60 });
    expect(sent.session.model).toBe('gpt-realtime-2.1');
    expect(sent.session.tools).toEqual([]);
    expect(sent.session.tool_choice).toBe('none');
    for (const tool of ToolNameSchema.options) expect(String(call.init.body)).not.toContain(tool);
  });

  it('never puts the server key in the response body or headers', async () => {
    const a = await appWith(OPENAI_ENV);
    fakeOpenAi(okResponse);
    const id = await newSession(a);
    const res = await mint(a, { builderSessionId: id });
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain(FAKE_KEY);
    expect(JSON.stringify(res.headers)).not.toContain(FAKE_KEY);
  });

  it('maps an upstream failure to INTEGRATION_UNAVAILABLE without the upstream message', async () => {
    const a = await appWith(OPENAI_ENV);
    const upstream = `upstream detail: invalid key ${FAKE_KEY} for org org_secret_123`;
    fakeOpenAi(() => new Response(JSON.stringify({ error: { message: upstream } }), { status: 401 }));
    const id = await newSession(a);
    const res = await mint(a, { builderSessionId: id });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'INTEGRATION_UNAVAILABLE', retryable: true, details: { provider: 'openai' } });
    expect(res.payload).not.toContain('upstream detail');
    expect(res.payload).not.toContain('org_secret_123');
    expect(res.payload).not.toContain(FAKE_KEY);
  });

  it('maps a network error and a malformed OpenAI response to INTEGRATION_UNAVAILABLE', async () => {
    const a = await appWith(OPENAI_ENV);
    const id = await newSession(a);
    fakeOpenAi(() => {
      throw new TypeError(`fetch failed for ${FAKE_KEY}`);
    });
    const network = await mint(a, { builderSessionId: id });
    expect(network.json().code).toBe('INTEGRATION_UNAVAILABLE');
    expect(network.payload).not.toContain(FAKE_KEY);

    fakeOpenAi(() => new Response(JSON.stringify({ unexpected: true }), { status: 200 }));
    expect((await mint(a, { builderSessionId: id })).json().code).toBe('INTEGRATION_UNAVAILABLE');
  });

  it('discards a secret whose effective session came back with tools', async () => {
    const a = await appWith(OPENAI_ENV);
    fakeOpenAi(
      () => new Response(JSON.stringify({ value: FAKE_SECRET, expires_at: EXPIRES_AT, session: { tools: [{ type: 'function', name: 'propose_order' }] } }), { status: 200 }),
    );
    const id = await newSession(a);
    const res = await mint(a, { builderSessionId: id });
    expect(res.json().code).toBe('INTEGRATION_UNAVAILABLE');
    expect(res.payload).not.toContain(FAKE_SECRET);
  });

  it('rate limits per owner and answers RATE_LIMITED with Retry-After', async () => {
    const a = await appWith(OPENAI_ENV);
    const calls = fakeOpenAi(okResponse);
    const id = await newSession(a);
    for (let i = 0; i < MINTS_PER_WINDOW; i++) expect((await mint(a, { builderSessionId: id })).statusCode).toBe(200);

    const limited = await mint(a, { builderSessionId: id });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // The same owner on the other business shares the limit: it is per owner.
    const barberId = await newSession(a, BARBER);
    expect((await mint(a, { builderSessionId: barberId }, BARBER)).statusCode).toBe(429);
    expect(calls).toHaveLength(MINTS_PER_WINDOW);

    vi.setSystemTime(new Date(NOW.getTime() + 61_000));
    expect((await mint(a, { builderSessionId: id })).statusCode).toBe(200);
  });
});

describe('POST /api/realtime/client-secret: no usable key', () => {
  it('answers INTEGRATION_UNAVAILABLE in recorded mode and never returns a secret-shaped value', async () => {
    const a = await appWith({});
    const calls = fakeOpenAi(okResponse);
    const id = await newSession(a);
    const res = await mint(a, { builderSessionId: id });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'INTEGRATION_UNAVAILABLE', details: { provider: 'openai' } });
    expect(res.json().clientSecret).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('answers INTEGRATION_UNAVAILABLE when the realtime model is missing or not the contract model', async () => {
    for (const model of ['', 'gpt-other-realtime']) {
      const a = await appWith({ ...OPENAI_ENV, OPENAI_REALTIME_MODEL: model });
      const calls = fakeOpenAi(okResponse);
      const id = await newSession(a);
      expect((await mint(a, { builderSessionId: id })).json().code).toBe('INTEGRATION_UNAVAILABLE');
      expect(calls).toHaveLength(0);
      await a.close();
      app = undefined;
    }
  });
});

// buildApp has no way to capture logs, so this one registers the builder plugin
// on a bare Fastify instance with a log stream at the most verbose level.
describe('logging', () => {
  it('never writes the server key or the client secret to the log', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const env = { ...OPENAI_ENV };
    const bare = Fastify({ logger: { level: 'trace', stream } });
    await bare.register(builderPlugin, { auth: new UnverifiedSeedOwnerAuth(), env });
    app = bare;

    fakeOpenAi(okResponse);
    const id = (await bare.inject({ method: 'POST', url: `/api/builder/sessions?${PIZZA}`, headers: AUTH, payload: {} })).json().id;
    const ok = await mint(bare, { builderSessionId: id });
    expect(ok.statusCode).toBe(200);

    fakeOpenAi(() => new Response(`bad key ${FAKE_KEY}`, { status: 401 }));
    await mint(bare, { builderSessionId: id });
    fakeOpenAi(() => {
      throw new TypeError(`fetch failed ${FAKE_KEY}`);
    });
    await mint(bare, { builderSessionId: id });

    const log = lines.join('');
    expect(log).toContain('realtime client secret minted');
    expect(log).toContain('realtime client secret request refused');
    expect(log).not.toContain(FAKE_KEY);
    expect(log).not.toContain(FAKE_SECRET);
  });

  it('uses an injected minter when one is passed to the plugin', async () => {
    const minter: RealtimeMinter = {
      kind: 'test',
      mint: vi.fn(async () => ({ value: 'ek_test_injected', expiresAt: new Date('2026-11-13T18:01:00Z') })),
    };
    const bare = Fastify();
    await bare.register(builderPlugin, { auth: new UnverifiedSeedOwnerAuth(), env: {}, realtimeMinter: minter });
    app = bare;
    const id = (await bare.inject({ method: 'POST', url: `/api/builder/sessions?${PIZZA}`, headers: AUTH, payload: {} })).json().id;
    const res = await mint(bare, { builderSessionId: id });
    expect(res.json()).toEqual({ clientSecret: 'ek_test_injected', expiresAt: '2026-11-13T18:01:00.000Z', model: 'gpt-realtime-2.1', builderSessionId: id });
    expect(minter.mint).toHaveBeenCalledTimes(1);
  });
});
