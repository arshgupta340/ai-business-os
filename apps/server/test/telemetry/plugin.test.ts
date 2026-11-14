import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ApiErrorSchema, TelemetryResponseSchema, type ActivityEvent } from '@abos/contracts';
import { pizzaOrderTimeline } from '@abos/contracts/fixtures';
import { createTelemetry, type TelemetryRecorder } from '../../src/telemetry/recorder';
import { telemetryPlugin } from '../../src/telemetry/plugin';
import type { TelemetryAuthGuard, TelemetryEventSource } from '../../src/telemetry/types';

const OWNED = pizzaOrderTimeline.businessId;
const OTHER = 'biz_someone_else';

// Fake guard: header `authorization: Bearer owner` is the owner of OWNED only.
const guard: TelemetryAuthGuard = (request, businessId) => {
  if (request.headers.authorization !== 'Bearer owner') return { ok: false, code: 'UNAUTHENTICATED' };
  if (businessId !== OWNED) return { ok: false, code: 'FORBIDDEN_BUSINESS' };
  return { ok: true };
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(recorder: TelemetryRecorder, eventSource?: TelemetryEventSource) {
  app = Fastify();
  await app.register(telemetryPlugin, eventSource === undefined ? { recorder, guard } : { recorder, guard, eventSource });
  return app;
}

const auth = { authorization: 'Bearer owner' };

describe('GET /api/telemetry', () => {
  it('returns the contract shape for the owner', async () => {
    const recorder = createTelemetry({ now: () => Date.parse('2026-11-14T19:00:00Z') });
    recorder.record('first_audio', { businessId: OWNED, ms: 698 });
    recorder.record('first_audio', { businessId: OWNED, ms: 812 });
    recorder.record('first_audio', { businessId: OTHER, ms: 99_999 });
    const server = await build(recorder);
    const res = await server.inject({ method: 'GET', url: `/api/telemetry?businessId=${OWNED}`, headers: auth });
    expect(res.statusCode).toBe(200);
    const body = TelemetryResponseSchema.parse(res.json());
    expect(body).toEqual({ metrics: [{ name: 'first_audio', p50Ms: 698, p95Ms: 812, count: 2 }] });
  });

  it('refuses without auth', async () => {
    const server = await build(createTelemetry({ now: Date.now }));
    const res = await server.inject({ method: 'GET', url: `/api/telemetry?businessId=${OWNED}` });
    expect(res.statusCode).toBe(401);
    expect(ApiErrorSchema.parse(res.json()).code).toBe('UNAUTHENTICATED');
  });

  it('refuses a business the owner does not own', async () => {
    const recorder = createTelemetry({ now: Date.now });
    recorder.record('tool_latency', { businessId: OTHER, ms: 10 });
    const server = await build(recorder);
    const res = await server.inject({ method: 'GET', url: `/api/telemetry?businessId=${OTHER}`, headers: auth });
    expect(res.statusCode).toBe(403);
    expect(ApiErrorSchema.parse(res.json()).code).toBe('FORBIDDEN_BUSINESS');
  });

  it('rejects a missing businessId or a bad since', async () => {
    const server = await build(createTelemetry({ now: Date.now }));
    const missing = await server.inject({ method: 'GET', url: '/api/telemetry', headers: auth });
    expect(missing.statusCode).toBe(400);
    const bad = await server.inject({ method: 'GET', url: `/api/telemetry?businessId=${OWNED}&since=yesterday`, headers: auth });
    expect(bad.statusCode).toBe(400);
  });

  it('derives approval_time from the event source and filters by since', async () => {
    const events: ActivityEvent[] = pizzaOrderTimeline.entries.map((e) => e.event);
    const seen: { since?: string }[] = [];
    const source: TelemetryEventSource = {
      async listEvents(q) {
        seen.push(q);
        return events;
      },
    };
    const recorder = createTelemetry({ now: Date.now });
    // An explicit approval_time sample is replaced by the derived one, never added to it.
    recorder.record('approval_time', { businessId: OWNED, ms: 1 });
    const server = await build(recorder, source);
    const res = await server.inject({ method: 'GET', url: `/api/telemetry?businessId=${OWNED}`, headers: auth });
    expect(res.json()).toEqual({ metrics: [{ name: 'approval_time', p50Ms: 65_000, p95Ms: 65_000, count: 1 }] });

    // The decision is at 19:04:10Z. A since after it drops the sample, and the metric is absent.
    const later = await server.inject({ method: 'GET', url: `/api/telemetry?businessId=${OWNED}&since=2026-11-14T19:05:00Z`, headers: auth });
    expect(later.json()).toEqual({ metrics: [] });
    // The event query reaches one approval lifetime (10 minutes) before since.
    expect(seen.at(-1)?.since).toBe('2026-11-14T18:55:00.000Z');
  });
});
