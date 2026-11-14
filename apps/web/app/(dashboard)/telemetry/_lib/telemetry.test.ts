import {describe, expect, it} from 'vitest';
import {formatDuration, metricView, sinceFor, sortMetrics, startOfDayInZone, LOW_SAMPLE_THRESHOLD} from './telemetry';

describe('formatDuration', () => {
  it.each([
    [0, '0 ms'],
    [820, '820 ms'],
    [999, '999 ms'],
    [999.4, '999 ms'],
    [999.5, '1.0 s'],
    [1000, '1.0 s'],
    [1310, '1.3 s'],
    [9949, '9.9 s'],
    [9950, '10 s'],
    [48000, '48 s'],
    [59499, '59 s'],
    [59500, '1 min'],
    [212000, '3 min 32 s'],
    [599499, '9 min 59 s'],
    [599500, '10 min'],
    [3_569_999, '59 min'],
    [3_570_000, '1 h'],
    [3_900_000, '1 h 5 min'],
    [-5, '0 ms'],
  ])('%s ms reads %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe('sinceFor', () => {
  // 2026-11-13 18:30 in Los Angeles (PST, UTC-8) is 2026-11-14 02:30 UTC.
  const now = Date.parse('2026-11-14T02:30:00Z');

  it('last hour is one hour before now', () => {
    expect(sinceFor('hour', 'America/Los_Angeles', now)).toBe('2026-11-14T01:30:00.000Z');
  });

  it('today starts at local midnight in the business time zone, not the UTC day', () => {
    expect(sinceFor('today', 'America/Los_Angeles', now)).toBe('2026-11-13T08:00:00.000Z');
    expect(sinceFor('today', 'Asia/Kolkata', now)).toBe('2026-11-13T18:30:00.000Z');
    expect(sinceFor('today', 'UTC', now)).toBe('2026-11-14T00:00:00.000Z');
  });

  it('last 7 days starts at local midnight six days before today', () => {
    expect(sinceFor('week', 'America/Los_Angeles', now)).toBe('2026-11-07T08:00:00.000Z');
  });

  it('uses the offset of the start day across a DST change', () => {
    // 2026-11-04 noon PST. Six days before is 2026-10-29, still PDT (UTC-7).
    const afterDst = Date.parse('2026-11-04T20:00:00Z');
    expect(new Date(startOfDayInZone(afterDst, 'America/Los_Angeles', 6)).toISOString()).toBe('2026-10-29T07:00:00.000Z');
    expect(new Date(startOfDayInZone(afterDst, 'America/Los_Angeles', 0)).toISOString()).toBe('2026-11-04T08:00:00.000Z');
  });
});

describe('metricView', () => {
  it('says "No data yet" for zero samples and makes no goal judgement', () => {
    const v = metricView({name: 'first_audio', p50Ms: 0, p95Ms: 0, count: 0});
    expect(v.hasData).toBe(false);
    expect(v.countText).toBe('No data yet.');
    expect(v.goal).toBeDefined();
    expect(v.goalCheck).toBeUndefined();
    expect(v.lowSampleNote).toBeUndefined();
    expect(v.scaleMaxMs).toBeGreaterThan(0);
  });

  it('notes a small sample with its count, singular for one', () => {
    const one = metricView({name: 'webhook_delay', p50Ms: 1900, p95Ms: 6400, count: 1});
    expect(one.countText).toBe('Based on 1 sample.');
    expect(one.lowSampleNote).toMatch(/^That is a small sample/);
    expect(metricView({name: 'webhook_delay', p50Ms: 1900, p95Ms: 6400, count: 7}).countText).toBe('Based on 7 samples.');
    expect(metricView({name: 'webhook_delay', p50Ms: 1900, p95Ms: 6400, count: LOW_SAMPLE_THRESHOLD - 1}).lowSampleNote).toBeDefined();
    const enough = metricView({name: 'tool_latency', p50Ms: 410, p95Ms: 1190, count: LOW_SAMPLE_THRESHOLD});
    expect(enough.lowSampleNote).toBeUndefined();
    expect(enough.countText).toBe(`Based on ${LOW_SAMPLE_THRESHOLD} samples.`);
  });

  it('shows an unknown metric by its raw name with no goal', () => {
    const v = metricView({name: 'model_cost', p50Ms: 10, p95Ms: 20, count: 30});
    expect(v.label).toBe('model_cost');
    expect(v.isKnown).toBe(false);
    expect(v.description).toBeUndefined();
    expect(v.goal).toBeUndefined();
    expect(v.goalCheck).toBeUndefined();
  });

  it('has goals only where the PRD states one', () => {
    for (const name of ['call_answer_latency', 'approval_time', 'webhook_delay']) {
      const v = metricView({name, p50Ms: 1, p95Ms: 1_000_000, count: 50});
      expect(v.goal).toBeUndefined();
      expect(v.goalCheck).toBeUndefined();
    }
  });

  it('compares first audio p95 with 2.5 s, at the boundary too', () => {
    expect(metricView({name: 'first_audio', p50Ms: 1310, p95Ms: 2500, count: 14}).goalCheck).toMatchObject({
      percentile: 'p95',
      measuredMs: 2500,
      isWithin: true,
    });
    expect(metricView({name: 'first_audio', p50Ms: 1310, p95Ms: 2501, count: 14}).goalCheck?.isWithin).toBe(false);
  });

  it('compares tool latency p50 (the median the PRD names) with 1.5 s, not p95', () => {
    const v = metricView({name: 'tool_latency', p50Ms: 410, p95Ms: 4000, count: 61});
    expect(v.goalCheck).toMatchObject({percentile: 'p50', measuredMs: 410, isWithin: true});
    expect(metricView({name: 'tool_latency', p50Ms: 1600, p95Ms: 1700, count: 61}).goalCheck?.isWithin).toBe(false);
  });

  it('scales bars to the larger of p95 and the goal', () => {
    expect(metricView({name: 'first_audio', p50Ms: 500, p95Ms: 900, count: 30}).scaleMaxMs).toBeCloseTo(2750);
    expect(metricView({name: 'approval_time', p50Ms: 48000, p95Ms: 212000, count: 9}).scaleMaxMs).toBeCloseTo(233200);
  });
});

describe('sortMetrics', () => {
  it('puts known metrics in API order and unknown names last', () => {
    const sorted = sortMetrics([{name: 'zzz'}, {name: 'webhook_delay'}, {name: 'call_answer_latency'}, {name: 'aaa'}]);
    expect(sorted.map((m) => m.name)).toEqual(['call_answer_latency', 'webhook_delay', 'zzz', 'aaa']);
  });
});
