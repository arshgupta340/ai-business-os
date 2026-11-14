// GET /api/telemetry (API 3.12, SHOULD). Exported only; the lead registers it in app.ts.
import {
  APPROVAL_EXPIRY_MS,
  ERROR_CODE_INFO,
  TelemetryQuerySchema,
  TelemetryResponseSchema,
  makeApiError,
  type ErrorCode,
  type TelemetryResponse,
} from '@abos/contracts';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { APPROVAL_TIME_EVENT_TYPES, DERIVABLE_METRICS, deriveApprovalTimes } from './derive';
import { METRIC_NAMES, summarizeDurations, type TelemetryRecorder } from './recorder';
import type { TelemetryAuthGuard, TelemetryEventSource } from './types';

export interface TelemetryPluginOptions {
  recorder: TelemetryRecorder;
  /** The server's owner check, reused. */
  guard: TelemetryAuthGuard;
  /**
   * Where derived metrics read their events. When it is given, approval_time comes from the
   * events and replaces any explicitly recorded approval_time samples, so nothing is counted twice.
   */
  eventSource?: TelemetryEventSource;
}

function correlationIdOf(request: FastifyRequest): string {
  // app.ts decorates every request with a correlation id; fall back to Fastify's request id.
  const decorated = (request as { correlationId?: unknown }).correlationId;
  return typeof decorated === 'string' && decorated !== '' ? decorated : request.id;
}

function sendError(request: FastifyRequest, reply: FastifyReply, code: ErrorCode, message: string, details?: Record<string, unknown>) {
  return reply.status(ERROR_CODE_INFO[code].httpStatus).send(makeApiError(code, message, correlationIdOf(request), details));
}

/** Summary for one business: recorded metrics, with derived ones from the event source merged in. */
export async function buildTelemetryResponse(
  recorder: TelemetryRecorder,
  eventSource: TelemetryEventSource | undefined,
  businessId: string,
  since: string | undefined,
): Promise<TelemetryResponse> {
  const recorded = recorder.summary(since === undefined ? { businessId } : { businessId, since });
  if (eventSource === undefined) return recorded;

  // A decision after `since` can belong to a request up to one approval lifetime earlier,
  // so the event query starts that much before `since`. The samples are filtered on `since` below.
  const query: Parameters<TelemetryEventSource['listEvents']>[0] = { businessId, types: APPROVAL_TIME_EVENT_TYPES };
  const sinceMs = since === undefined ? NaN : Date.parse(since);
  if (!Number.isNaN(sinceMs)) query.since = new Date(sinceMs - APPROVAL_EXPIRY_MS).toISOString();
  const events = await eventSource.listEvents(query);
  const derived = deriveApprovalTimes(events, businessId).samples.filter((s) => Number.isNaN(sinceMs) || Date.parse(s.at) >= sinceMs);

  const byName = new Map(recorded.metrics.map((m) => [m.name, m]));
  for (const name of DERIVABLE_METRICS) byName.delete(name);
  const approval = summarizeDurations('approval_time', derived.map((s) => s.ms));
  if (approval !== null) byName.set('approval_time', approval);
  const metrics: TelemetryResponse['metrics'] = [];
  for (const name of METRIC_NAMES) {
    const line = byName.get(name);
    if (line !== undefined) metrics.push(line);
  }
  return { metrics };
}

export const telemetryPlugin: FastifyPluginAsync<TelemetryPluginOptions> = async (app, options) => {
  const { recorder, guard, eventSource } = options;

  app.get('/api/telemetry', async (request, reply) => {
    const parsed = TelemetryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(request, reply, 'VALIDATION_FAILED', 'Invalid telemetry query.', { issues: parsed.error.issues.map((i) => i.path.join('.')) });
    }
    const { businessId, since } = parsed.data;

    const decision = await guard(request, businessId);
    if (!decision.ok) {
      const fallback = decision.code === 'UNAUTHENTICATED' ? 'Sign in required.' : 'You do not own this business.';
      return sendError(request, reply, decision.code, decision.message ?? fallback);
    }

    const body = await buildTelemetryResponse(recorder, eventSource, businessId, since);
    // Validate against the contract before sending, so a shape drift fails loudly here.
    return reply.status(200).send(TelemetryResponseSchema.parse(body));
  });
};
