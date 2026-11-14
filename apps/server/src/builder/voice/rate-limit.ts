// A sliding-window limit kept in memory, one window per key (the owner ID).
// It stops a stuck client from minting secrets without bound. It is per
// process, so it resets on restart and is not shared between servers.

export type LimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => Date,
  ) {}

  // Counts one attempt for the key, or refuses it.
  take(key: string): LimitResult {
    const t = this.now().getTime();
    const recent = (this.hits.get(key) ?? []).filter((at) => at > t - this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? t;
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - t) / 1000)) };
    }
    recent.push(t);
    this.hits.set(key, recent);
    return { ok: true };
  }
}
