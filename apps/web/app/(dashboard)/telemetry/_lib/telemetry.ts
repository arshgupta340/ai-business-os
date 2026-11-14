/**
 * Pure logic for the telemetry screen: metric labels, the PRD goals, duration
 * formatting and the time window to `since` conversion. No React here, so it
 * is unit tested directly.
 *
 * Source: docs/API.md 3.12 (`GET /api/telemetry`, metric names) and
 * docs/PRD.md section 2 (the only latency goals the PRD states).
 */

/** The fields of one metric as the API returns it. `name` is a string so an unknown name still renders. */
export type MetricInput = {name: string; p50Ms: number; p95Ms: number; count: number};

/** Which percentile a PRD goal is about. */
export type Percentile = 'p50' | 'p95';

export type MetricGoal = {
  /** The percentile the goal is compared with. */
  percentile: Percentile;
  maxMs: number;
  /** Plain-language goal, as the PRD words it. */
  text: string;
  /** Why this percentile is the one compared. */
  basis: string;
};

type MetricInfo = {label: string; description: string; goal?: MetricGoal};

/**
 * Goals come only from docs/PRD.md section 2: "first audible response ideally
 * <= 2.5 seconds in representative calls; tool lookup median <= 1.5 seconds
 * with cache". The PRD calls them instrumented goals, not guarantees. It
 * states no goal for answer time, approval time or webhook delay, so those
 * show none.
 */
export const METRIC_INFO: Record<string, MetricInfo> = {
  call_answer_latency: {
    label: 'Time to answer a call',
    description: 'How long a caller waits for the agent to answer.',
  },
  first_audio: {
    label: 'Time to first audio',
    description: 'How long a caller waits to hear the first words from the agent.',
    goal: {
      percentile: 'p95',
      maxMs: 2500,
      text: 'First audio in 2.5 seconds or less in representative calls.',
      basis: 'The PRD names no percentile for this goal, so the stricter p95 is compared.',
    },
  },
  tool_latency: {
    label: 'Tool call time',
    description: 'How long one lookup or other tool call by the agent takes.',
    goal: {
      percentile: 'p50',
      maxMs: 1500,
      text: 'Tool lookup median of 1.5 seconds or less, with cache.',
      basis: 'The PRD goal is a median, so p50 is compared. This metric does not say which calls used the cache.',
    },
  },
  approval_time: {
    label: 'Owner approval time',
    description: 'How long you take to approve or reject a request after it arrives.',
  },
  webhook_delay: {
    label: 'Payment webhook delay',
    description: 'How long a payment webhook from Square takes to arrive.',
  },
};

/**
 * Below this many samples p95 is the largest value measured, so it can move a
 * lot with one more call. This threshold is a screen choice, not a PRD rule.
 */
export const LOW_SAMPLE_THRESHOLD = 20;

/** Readable duration: "820 ms", "1.3 s", "48 s", "3 min 32 s", "14 min", "1 h 5 min". */
export function formatDuration(ms: number): string {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const wholeMs = Math.round(safe);
  if (wholeMs < 1000) return `${wholeMs} ms`;
  const tenths = Math.round(safe / 100);
  if (tenths < 100) return `${(tenths / 10).toFixed(1)} s`;
  const seconds = Math.round(safe / 1000);
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s === 0 ? `${m} min` : `${m} min ${s} s`;
  }
  const minutes = Math.round(safe / 60000);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
}

export function formatSampleCount(count: number): string {
  return count === 1 ? '1 sample' : `${count} samples`;
}

export type GoalCheck = MetricGoal & {measuredMs: number; isWithin: boolean};

export type MetricView = {
  name: string;
  label: string;
  /** Absent for a metric name the screen does not know. */
  description?: string;
  isKnown: boolean;
  hasData: boolean;
  count: number;
  p50Ms: number;
  p95Ms: number;
  countText: string;
  /** Set when there are samples, but fewer than LOW_SAMPLE_THRESHOLD. */
  lowSampleNote?: string;
  /** The PRD goal, when the PRD states one. */
  goal?: MetricGoal;
  /** The comparison with the goal. Only when there is a goal and at least one sample. */
  goalCheck?: GoalCheck;
  /** Shared scale for both bars: the largest of p50, p95 and the goal, plus 10 percent. Never 0. */
  scaleMaxMs: number;
};

export function metricView(metric: MetricInput): MetricView {
  const info = METRIC_INFO[metric.name];
  const count = Math.max(0, Math.floor(metric.count));
  const hasData = count > 0;
  const goal = info?.goal;
  let goalCheck: GoalCheck | undefined;
  if (goal && hasData) {
    const measuredMs = goal.percentile === 'p50' ? metric.p50Ms : metric.p95Ms;
    goalCheck = {...goal, measuredMs, isWithin: measuredMs <= goal.maxMs};
  }
  // 10 percent headroom so a goal mark at the top of the scale is not hidden at the track end.
  const scaleMaxMs = Math.max(metric.p50Ms, metric.p95Ms, goal?.maxMs ?? 0, 1) * 1.1;
  return {
    name: metric.name,
    label: info?.label ?? metric.name,
    description: info?.description,
    isKnown: !!info,
    hasData,
    count,
    p50Ms: metric.p50Ms,
    p95Ms: metric.p95Ms,
    countText: hasData ? `Based on ${formatSampleCount(count)}.` : 'No data yet.',
    lowSampleNote:
      hasData && count < LOW_SAMPLE_THRESHOLD
        ? 'That is a small sample, so p95 is close to the slowest one measured and can change a lot.'
        : undefined,
    goal,
    goalCheck,
    scaleMaxMs,
  };
}

/** Known metrics first, in the API.md order, then unknown names in the order received. */
export function sortMetrics<T extends {name: string}>(metrics: readonly T[]): T[] {
  const order = Object.keys(METRIC_INFO);
  const rank = (name: string) => {
    const i = order.indexOf(name);
    return i === -1 ? order.length : i;
  };
  return metrics
    .map((m, i) => ({m, i}))
    .sort((a, b) => rank(a.m.name) - rank(b.m.name) || a.i - b.i)
    .map(({m}) => m);
}

// ------------------------------------------------------------ time windows

export type TelemetryWindow = 'hour' | 'today' | 'week';

export const WINDOW_OPTIONS: ReadonlyArray<{value: TelemetryWindow; label: string}> = [
  {value: 'hour', label: 'Last hour'},
  {value: 'today', label: 'Today'},
  {value: 'week', label: 'Last 7 days'},
];

export const DEFAULT_WINDOW: TelemetryWindow = 'week';

export function isTelemetryWindow(value: string): value is TelemetryWindow {
  return WINDOW_OPTIONS.some((o) => o.value === value);
}

/** Offset of `timeZone` from UTC at instant `atMs`, in milliseconds (local minus UTC). */
function zoneOffsetMs(atMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(atMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const localAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const wholeSecond = atMs - (((atMs % 1000) + 1000) % 1000);
  return localAsUtc - wholeSecond;
}

/** The UTC instant of local midnight in `timeZone`, `daysBack` calendar days before the day of `nowMs`. */
export function startOfDayInZone(nowMs: number, timeZone: string, daysBack: number = 0): number {
  const parts = new Intl.DateTimeFormat('en-US', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(
    new Date(nowMs),
  );
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const midnightAsUtc = Date.UTC(get('year'), get('month') - 1, get('day') - daysBack);
  // Two passes so a day that starts on the other side of a DST change gets its own offset.
  let result = midnightAsUtc - zoneOffsetMs(midnightAsUtc, timeZone);
  result = midnightAsUtc - zoneOffsetMs(result, timeZone);
  return result;
}

/** The `since` query value (ISO, UTC) for a window, computed in the business time zone. */
export function sinceFor(window: TelemetryWindow, timeZone: string, nowMs: number): string {
  switch (window) {
    case 'hour':
      return new Date(nowMs - 60 * 60 * 1000).toISOString();
    case 'today':
      return new Date(startOfDayInZone(nowMs, timeZone, 0)).toISOString();
    case 'week':
      // Today and the six calendar days before it.
      return new Date(startOfDayInZone(nowMs, timeZone, 6)).toISOString();
  }
}
