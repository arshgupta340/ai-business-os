import { describe, expect, it } from 'vitest';
import { noopTelemetry } from '../../src/telemetry/port';
import { createTelemetry } from '../../src/telemetry/recorder';
import type { TelemetryPort } from '../../src/telemetry/types';

describe('noopTelemetry', () => {
  it('does nothing and never throws, even on bad input', () => {
    expect(() => noopTelemetry.record('tool_latency', { businessId: '', ms: Number.NaN })).not.toThrow();
    const stop = noopTelemetry.time('first_audio', { businessId: 'biz_a' });
    expect(() => {
      stop();
      stop();
    }).not.toThrow();
    expect(noopTelemetry.record('tool_latency', { businessId: 'biz_a', ms: 1 })).toBeUndefined();
  });

  it('the real recorder satisfies the port', () => {
    const port: TelemetryPort = createTelemetry({ now: Date.now });
    expect(typeof port.record).toBe('function');
    expect(typeof port.time).toBe('function');
  });
});
