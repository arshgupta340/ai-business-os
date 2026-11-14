// Integration health (API 3.11, review finding 5). "Configured" (the settings exist and a client was
// built) is kept apart from "connected" (a bounded read-only probe confirmed access). A provider is
// reported connected only after its probe succeeded; until then it is disconnected with a detail that
// says why. `refresh=1` runs the probes now; otherwise the last stored results are returned with the
// time they were taken.
import type { IntegrationState } from '@abos/contracts';
import type { ProviderKey, ProviderStatus } from './providers';

/** A bounded, read-only provider call. It must never write. Throws or returns ok:false when access fails. */
export type HealthProbe = () => Promise<{ ok: true; detail?: string } | { ok: false; detail: string }>;

export type HealthEntry = { state: IntegrationState; detail: string; lastCheckedAt: string };
export type HealthReport = Record<ProviderKey, HealthEntry>;

export interface HealthMonitor {
  read(input: { refresh: boolean }): Promise<HealthReport>;
}

export const HEALTH_PROBE_TIMEOUT_MS = 5000;
const KEYS: readonly ProviderKey[] = ['square', 'twilio', 'openai', 'google_calendar', 'google_sheets', 'message_channel'];

async function bounded(probe: HealthProbe, ms: number): Promise<{ ok: boolean; detail: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false; detail: string }>((resolve) => { timer = setTimeout(() => resolve({ ok: false, detail: 'check timed out' }), ms); });
  try {
    const r = await Promise.race([probe().then((x) => (x.ok ? { ok: true, detail: x.detail ?? 'ok' } : { ok: false, detail: x.detail }), () => ({ ok: false, detail: 'check failed' })), timeout]);
    return r;
  } finally { clearTimeout(timer); }
}

export function createHealthMonitor(deps: {
  status: Record<ProviderKey, ProviderStatus>;
  probes: Partial<Record<ProviderKey, HealthProbe>>;
  now(): Date;
  timeoutMs?: number;
}): HealthMonitor {
  const startedAt = deps.now().toISOString();
  const cache = new Map<ProviderKey, HealthEntry>();
  let running: Promise<void> | undefined;

  async function refresh() {
    await Promise.all(KEYS.map(async (key) => {
      const status = deps.status[key];
      const probe = deps.probes[key];
      if (!status.configured || !probe) return;
      const r = await bounded(probe, deps.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS);
      // Provider error text never reaches the response: probes return fixed details only.
      cache.set(key, { state: r.ok ? 'connected' : 'disconnected', detail: r.ok ? r.detail : r.detail, lastCheckedAt: deps.now().toISOString() });
    }));
  }

  return {
    async read({ refresh: now }) {
      if (now) {
        running ??= refresh().finally(() => { running = undefined; });
        await running;
      }
      const out = {} as HealthReport;
      for (const key of KEYS) {
        const status = deps.status[key];
        const cached = cache.get(key);
        if (!status.configured) out[key] = { state: 'disconnected', detail: status.detail, lastCheckedAt: cached?.lastCheckedAt ?? startedAt };
        else if (status.noProviderNeeded) out[key] = { state: 'connected', detail: status.detail, lastCheckedAt: startedAt };
        else if (cached) out[key] = cached;
        else if (!deps.probes[key]) out[key] = { state: 'disconnected', detail: `${status.detail}; no read-only check exists, so access is not confirmed`, lastCheckedAt: startedAt };
        else out[key] = { state: 'disconnected', detail: `${status.detail}; not checked yet (refresh=1 runs the check)`, lastCheckedAt: startedAt };
      }
      return out;
    },
  };
}
