// Telemetry module (task B-30). Other modules should import only `TelemetryPort` and
// `noopTelemetry`; the recorder and the plugin are for the server's composition root.
export type {
  DetailedMetric,
  DetailedSummary,
  RecordInput,
  SampleContext,
  SummaryQuery,
  TelemetryAuthGuard,
  TelemetryEventSource,
  TelemetryGuardResult,
  TelemetryPort,
} from './types';
export { noopTelemetry } from './port';
export {
  DEFAULT_MAX_SAMPLES_PER_METRIC,
  METRIC_NAMES,
  createTelemetry,
  nearestRank,
  summarizeDurations,
  type TelemetryOptions,
  type TelemetryRecorder,
} from './recorder';
export {
  APPROVAL_TIME_EVENT_TYPES,
  DERIVABLE_METRICS,
  DERIVATION_GAPS,
  deriveApprovalTimes,
  type ApprovalTimeResult,
  type DerivedSample,
} from './derive';
export { buildTelemetryResponse, telemetryPlugin, type TelemetryPluginOptions } from './plugin';
