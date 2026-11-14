import { describe, expect, it } from 'vitest';
import { createTelemetry, nearestRank } from '../../src/telemetry/recorder';

function clock(start = Date.parse('2026-11-14T19:00:00Z')) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const A = 'biz_a';
const B = 'biz_b';

describe('nearestRank percentiles', () => {
  it('odd count', () => {
    const v = [5, 1, 3, 2, 4];
    expect(nearestRank(v, 50)).toBe(3);
    expect(nearestRank(v, 95)).toBe(5);
  });
  it('even count', () => {
    const v = [40, 10, 30, 20];
    expect(nearestRank(v, 50)).toBe(20);
    expect(nearestRank(v, 95)).toBe(40);
  });
  it('twenty samples: p95 is the 19th value', () => {
    const v = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);
    expect(nearestRank(v, 50)).toBe(100);
    expect(nearestRank(v, 95)).toBe(190);
  });
  it('single sample', () => {
    expect(nearestRank([7], 50)).toBe(7);
    expect(nearestRank([7], 95)).toBe(7);
  });
  it('all equal', () => {
    expect(nearestRank([3, 3, 3, 3], 50)).toBe(3);
    expect(nearestRank([3, 3, 3, 3], 95)).toBe(3);
  });
  it('empty is null, never zero', () => {
    expect(nearestRank([], 50)).toBeNull();
  });
});

describe('createTelemetry', () => {
  it('summarizes recorded samples in the contract shape', () => {
    const t = createTelemetry({ now: clock().now });
    for (const ms of [100, 200, 300]) t.record('tool_latency', { businessId: A, ms });
    expect(t.summary({ businessId: A })).toEqual({ metrics: [{ name: 'tool_latency', p50Ms: 200, p95Ms: 300, count: 3 }] });
  });

  it('omits metrics with no samples', () => {
    const t = createTelemetry({ now: clock().now });
    expect(t.summary({ businessId: A })).toEqual({ metrics: [] });
    t.record('first_audio', { businessId: A, ms: 700 });
    expect(t.summary({ businessId: A }).metrics.map((m) => m.name)).toEqual(['first_audio']);
  });

  it('rejects invalid durations and stores nothing', () => {
    const t = createTelemetry({ now: clock().now });
    expect(t.record('tool_latency', { businessId: A, ms: -1 })).toBe(false);
    expect(t.record('tool_latency', { businessId: A, ms: Number.NaN })).toBe(false);
    expect(t.record('tool_latency', { businessId: A, ms: Number.POSITIVE_INFINITY })).toBe(false);
    expect(t.summary({ businessId: A }).metrics).toEqual([]);
  });

  it('bounds memory: the oldest sample drops when the buffer is full', () => {
    const t = createTelemetry({ now: clock().now, maxSamplesPerMetric: 3 });
    for (const ms of [1, 2, 3, 4, 5]) t.record('tool_latency', { businessId: A, ms });
    expect(t.durations('tool_latency', { businessId: A })).toEqual([3, 4, 5]);
    expect(t.summary({ businessId: A }).metrics[0]?.count).toBe(3);
  });

  it('keeps businesses isolated', () => {
    const t = createTelemetry({ now: clock().now });
    t.record('tool_latency', { businessId: A, ms: 100 });
    t.record('tool_latency', { businessId: B, ms: 9000 });
    t.record('first_audio', { businessId: B, ms: 800 });
    expect(t.summary({ businessId: A })).toEqual({ metrics: [{ name: 'tool_latency', p50Ms: 100, p95Ms: 100, count: 1 }] });
    expect(t.summary({ businessId: 'biz_none' })).toEqual({ metrics: [] });
  });

  it('filters by since', () => {
    const c = clock();
    const t = createTelemetry({ now: c.now });
    t.record('tool_latency', { businessId: A, ms: 1000 });
    c.advance(60_000);
    const cut = new Date(c.now()).toISOString();
    t.record('tool_latency', { businessId: A, ms: 50 });
    expect(t.summary({ businessId: A, since: cut })).toEqual({ metrics: [{ name: 'tool_latency', p50Ms: 50, p95Ms: 50, count: 1 }] });
    expect(t.summary({ businessId: A }).metrics[0]?.count).toBe(2);
  });

  it('time() records elapsed time only when the stopper is called, and only once', () => {
    const c = clock();
    const t = createTelemetry({ now: c.now });
    const stop = t.time('call_answer_latency', { businessId: A, correlationId: 'call_1' });
    c.advance(450);
    expect(t.summary({ businessId: A }).metrics).toEqual([]);
    stop();
    stop();
    expect(t.summary({ businessId: A })).toEqual({ metrics: [{ name: 'call_answer_latency', p50Ms: 450, p95Ms: 450, count: 1 }] });
  });

  it('timeUnlessFailed records on success and counts a failure separately', async () => {
    const c = clock();
    const t = createTelemetry({ now: c.now });
    const ok = await t.timeUnlessFailed('tool_latency', { businessId: A }, async () => {
      c.advance(120);
      return 'done';
    });
    expect(ok).toBe('done');
    const boom = new Error('provider down');
    await expect(
      t.timeUnlessFailed('tool_latency', { businessId: A }, async () => {
        c.advance(5000);
        throw boom;
      }),
    ).rejects.toBe(boom);
    // The failed 5000 ms run is not in the percentiles.
    expect(t.summary({ businessId: A })).toEqual({ metrics: [{ name: 'tool_latency', p50Ms: 120, p95Ms: 120, count: 1 }] });
    expect(t.detailedSummary({ businessId: A })).toEqual({ metrics: [{ name: 'tool_latency', p50Ms: 120, p95Ms: 120, count: 1, failures: 1 }] });
  });

  it('a metric with only failures is absent from the public summary and null in the detailed one', () => {
    const t = createTelemetry({ now: clock().now });
    t.fail('webhook_delay', { businessId: A });
    expect(t.summary({ businessId: A }).metrics).toEqual([]);
    expect(t.detailedSummary({ businessId: A }).metrics).toEqual([{ name: 'webhook_delay', p50Ms: null, p95Ms: null, count: 0, failures: 1 }]);
  });

  it('reset clears everything', () => {
    const t = createTelemetry({ now: clock().now });
    t.record('tool_latency', { businessId: A, ms: 1 });
    t.fail('tool_latency', { businessId: A });
    t.reset();
    expect(t.detailedSummary({ businessId: A }).metrics).toEqual([]);
  });
});
