// The default telemetry port: it does nothing and never throws. Modules that take a
// `TelemetryPort` by injection use this until the server wires in a real recorder.
import type { TelemetryPort } from './types';

const noop = (): void => {};

export const noopTelemetry: TelemetryPort = {
  record: noop,
  time: () => noop,
};
