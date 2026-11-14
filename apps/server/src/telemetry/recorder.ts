// In-memory latency recorder (task B-30). The server's database role cannot create tables, so
// samples live in this process only: one bounded buffer per business and metric. A restart
// clears them, which is acceptable for test-time p50 and p95 numbers (PRD 2).
import { TelemetryMetricNameSchema, type TelemetryMetricName, type TelemetryResponse } from '@abos/contracts';
import type { DetailedMetric, DetailedSummary, RecordInput, SampleContext, SummaryQuery, TelemetryPort } from './types';

export const DEFAULT_MAX_SAMPLES_PER_METRIC = 1000;

/** Metric names in the order the contract lists them. Summaries keep this order. */
export const METRIC_NAMES: readonly TelemetryMetricName[] = TelemetryMetricNameSchema.options;

interface Sample {
  /** Epoch milliseconds when the sample was recorded (the moment the operation completed). */
  at: number;
  ms: number;
  correlationId?: string;
}

/** A fixed-size buffer. When it is full, adding a new item drops the oldest one. */
class RingBuffer<T> {
  private readonly items: T[] = [];
  constructor(private readonly capacity: number) {}
  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.shift();
  }
  toArray(): T[] {
    return [...this.items];
  }
}

/**
 * Nearest-rank percentile: sort the samples, take rank = ceil(p / 100 * n), and return the
 * sample at that rank (1-based). The result is always a value that was really measured.
 * Returns null for an empty list, so an empty metric is never reported as zero.
 */
export function nearestRank(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

/** p50, p95 and count for one list of durations, or null when the list is empty. */
export function summarizeDurations(name: TelemetryMetricName, values: readonly number[]): TelemetryResponse['metrics'][number] | null {
  const p50 = nearestRank(values, 50);
  const p95 = nearestRank(values, 95);
  if (p50 === null || p95 === null) return null;
  return { name, p50Ms: p50, p95Ms: p95, count: values.length };
}

export interface TelemetryRecorder extends TelemetryPort {
  /** Records one completed duration. Returns false and stores nothing when `ms` is not a valid duration. */
  record(metric: TelemetryMetricName, input: RecordInput): boolean;
  /** Counts one operation that was started but did not complete. It adds no duration. */
  fail(metric: TelemetryMetricName, context: SampleContext): void;
  /**
   * Runs `operation`. The elapsed time is recorded only when it resolves. When it rejects, one
   * failure is counted instead and the error is rethrown unchanged.
   */
  timeUnlessFailed<T>(metric: TelemetryMetricName, context: SampleContext, operation: () => Promise<T>): Promise<T>;
  /** The contract response: p50, p95 and count per metric, only for metrics that have samples. */
  summary(query: SummaryQuery): TelemetryResponse;
  /** The internal view: also failure counts, and metrics that have only failures. */
  detailedSummary(query: SummaryQuery): DetailedSummary;
  /** The retained completed durations for one business and metric, oldest first. */
  durations(metric: TelemetryMetricName, query: SummaryQuery): number[];
  reset(): void;
}

export interface TelemetryOptions {
  /** Clock in epoch milliseconds. Injected so tests control time. */
  now: () => number;
  maxSamplesPerMetric?: number;
}

function sinceMs(since: string | undefined): number | null {
  if (since === undefined) return null;
  const t = Date.parse(since);
  return Number.isNaN(t) ? null : t;
}

export function createTelemetry(options: TelemetryOptions): TelemetryRecorder {
  const { now } = options;
  const capacity = Math.max(1, Math.floor(options.maxSamplesPerMetric ?? DEFAULT_MAX_SAMPLES_PER_METRIC));
  // Keyed by businessId, then metric. A summary reads only its own business's map.
  let samples = new Map<string, Map<TelemetryMetricName, RingBuffer<Sample>>>();
  let failures = new Map<string, Map<TelemetryMetricName, RingBuffer<Sample>>>();

  const bufferFor = (store: typeof samples, businessId: string, metric: TelemetryMetricName): RingBuffer<Sample> => {
    let byMetric = store.get(businessId);
    if (byMetric === undefined) {
      byMetric = new Map();
      store.set(businessId, byMetric);
    }
    let buffer = byMetric.get(metric);
    if (buffer === undefined) {
      buffer = new RingBuffer<Sample>(capacity);
      byMetric.set(metric, buffer);
    }
    return buffer;
  };

  const read = (store: typeof samples, metric: TelemetryMetricName, query: SummaryQuery): Sample[] => {
    const buffer = store.get(query.businessId)?.get(metric);
    if (buffer === undefined) return [];
    const from = sinceMs(query.since);
    const all = buffer.toArray();
    return from === null ? all : all.filter((s) => s.at >= from);
  };

  const sample = (ms: number, context: SampleContext): Sample => {
    const s: Sample = { at: now(), ms };
    if (context.correlationId !== undefined) s.correlationId = context.correlationId;
    return s;
  };

  const record = (metric: TelemetryMetricName, input: RecordInput): boolean => {
    if (!Number.isFinite(input.ms) || input.ms < 0 || input.businessId === '') return false;
    bufferFor(samples, input.businessId, metric).push(sample(input.ms, input));
    return true;
  };

  const fail = (metric: TelemetryMetricName, context: SampleContext): void => {
    if (context.businessId === '') return;
    bufferFor(failures, context.businessId, metric).push(sample(0, context));
  };

  const time = (metric: TelemetryMetricName, context: SampleContext): (() => void) => {
    const started = now();
    let done = false;
    return () => {
      if (done) return; // a second call must not add a second sample
      done = true;
      record(metric, { ...context, ms: now() - started });
    };
  };

  const timeUnlessFailed = async <T>(metric: TelemetryMetricName, context: SampleContext, operation: () => Promise<T>): Promise<T> => {
    const started = now();
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      fail(metric, context);
      throw error;
    }
    record(metric, { ...context, ms: now() - started });
    return result;
  };

  const durations = (metric: TelemetryMetricName, query: SummaryQuery): number[] => read(samples, metric, query).map((s) => s.ms);

  const detailedSummary = (query: SummaryQuery): DetailedSummary => {
    const metrics: DetailedMetric[] = [];
    for (const name of METRIC_NAMES) {
      const values = durations(name, query);
      const failed = read(failures, name, query).length;
      if (values.length === 0 && failed === 0) continue;
      metrics.push({ name, p50Ms: nearestRank(values, 50), p95Ms: nearestRank(values, 95), count: values.length, failures: failed });
    }
    return { metrics };
  };

  const summary = (query: SummaryQuery): TelemetryResponse => {
    const metrics: TelemetryResponse['metrics'] = [];
    for (const name of METRIC_NAMES) {
      const line = summarizeDurations(name, durations(name, query));
      if (line !== null) metrics.push(line);
    }
    return { metrics };
  };

  const reset = (): void => {
    samples = new Map();
    failures = new Map();
  };

  return { record, fail, time, timeUnlessFailed, summary, detailedSummary, durations, reset };
}
