import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../app';
import { parseEnv } from '../../env';
import { InMemoryBuilderSessionStore } from '../session/stores';

// POST /api/realtime/client-secret for a builder session that is closed. The
// app is built with buildApp, and the builder plugin gets a session store the
// test holds, so a session can be marked completed or abandoned. OpenAI is
// never called: the global fetch is a fake that records every request, and the
// key below is fake.

const holder = vi.hoisted(() => ({ options: {} as Record<string, unknown> }));
vi.mock('../index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../index')>();
  const builderPlugin = async (app: never, opts: object) => actual.builderPlugin(app, { ...opts, ...holder.options } as never);
  return { ...actual, builderPlugin };
});

const FAKE_KEY = 'sk-test-FAKE-KEY-never-real-0123456789abcdef';
const AUTH = { authorization: 'Bearer test-token' };
const PIZZA = 'businessId=biz_pizza_01';
const NOW = new Date('2026-11-13T18:00:00Z');

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup() {
  vi.stubEnv('OPENAI_API_KEY', FAKE_KEY);
  vi.stubEnv('OPENAI_BUILDER_MODEL', 'test-builder-model');
  vi.stubEnv('OPENAI_REALTIME_MODEL', 'gpt-realtime-2.1');
  vi.stubEnv('BUILDER_DEV_AUTH', '1');
  vi.stubEnv('NODE_ENV', 'test');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const sessions = new InMemoryBuilderSessionStore();
  holder.options = { sessions };
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ value: 'ek_test_fake', expires_at: Math.floor(NOW.getTime() / 1000) + 60, session: { tools: [] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }));
  app = await buildApp(parseEnv({}));
  return { app, sessions, calls };
}

async function newSession(instance: FastifyInstance): Promise<string> {
  const res = await instance.inject({ method: 'POST', url: `/api/builder/sessions?${PIZZA}`, headers: AUTH, payload: {} });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

function mint(instance: FastifyInstance, builderSessionId: string) {
  return instance.inject({ method: 'POST', url: `/api/realtime/client-secret?${PIZZA}`, headers: AUTH, payload: { builderSessionId } });
}

describe('POST /api/realtime/client-secret: closed sessions', () => {
  it('mints for an active session (the fake OpenAI is called once)', async () => {
    const { app: a, calls } = await setup();
    const id = await newSession(a);
    expect((await mint(a, id)).statusCode).toBe(200);
    expect(calls).toHaveLength(1);
  });

  for (const status of ['completed', 'abandoned'] as const) {
    it(`refuses a session that is ${status} with INVALID_STATE and never calls OpenAI`, async () => {
      const { app: a, sessions, calls } = await setup();
      const id = await newSession(a);
      const session = (await sessions.get('biz_pizza_01', id))!;
      await sessions.update({ ...session, status });

      const res = await mint(a, id);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        code: 'INVALID_STATE',
        message: 'This builder session is closed. Start a new one to use voice.',
        retryable: false,
        details: { state: status },
      });
      expect(res.json().clientSecret).toBeUndefined();
      expect(calls).toHaveLength(0);
    });
  }
});
