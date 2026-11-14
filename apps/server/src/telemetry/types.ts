// Types for the telemetry module (task B-30). The public response shape comes from
// `@abos/contracts` (TelemetryResponseSchema); nothing here redefines it.
import type { ActivityEvent, ActivityEventType, TelemetryMetricName, TelemetryResponse } from '@abos/contracts';
import type { FastifyRequest } from 'fastify';

export type { TelemetryMetricName, TelemetryResponse };

/** What a caller says about one measurement. */
export interface SampleContext {
  businessId: string;
  correlationId?: string;
}

export interface RecordInput extends SampleContext {
  /** Duration in milliseconds. Must be a finite number at or above zero. */
  ms: number;
}

/**
 * The only telemetry surface other modules should depend on. The voice worker, the tool
 * layer and the webhook handler take this by injection; the default is `noopTelemetry`.
 */
export interface TelemetryPort {
  /** Records one completed duration. Call it only after the timed thing really finished. */
  record(metric: TelemetryMetricName, input: RecordInput): void;
  /** Starts a timer. Calling the returned function records the elapsed time once. */
  time(metric: TelemetryMetricName, context: SampleContext): () => void;
}

/** One line of the extended internal summary. */
export interface DetailedMetric {
  name: TelemetryMetricName;
  /** Null when there are failures but no completed samples. Never reported as zero. */
  p50Ms: number | null;
  p95Ms: number | null;
  /** The true number of retained completed samples. */
  count: number;
  /** Operations that were timed but did not complete. Not included in the percentiles. */
  failures: number;
}

export interface DetailedSummary {
  metrics: DetailedMetric[];
}

export interface SummaryQuery {
  businessId: string;
  /** ISO timestamp. Only samples recorded at or after it count. */
  since?: string;
}

/** A source of activity events for one business, provided by whoever owns `activity_events`. */
export interface TelemetryEventSource {
  listEvents(query: { businessId: string; since?: string; types: readonly ActivityEventType[] }): Promise<ActivityEvent[]>;
}

/** The result of the server's owner check for one business. */
export type TelemetryGuardResult =
  | { ok: true }
  | { ok: false; code: 'UNAUTHENTICATED' | 'FORBIDDEN_BUSINESS'; message?: string };

/** Reuses the server's owner check: is the requester signed in, and do they own this business? */
export type TelemetryAuthGuard = (request: FastifyRequest, businessId: string) => Promise<TelemetryGuardResult> | TelemetryGuardResult;
