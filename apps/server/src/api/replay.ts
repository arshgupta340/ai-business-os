// The Idempotency-Key replay memory of POST /api/approvals/:id/decision (API.md section 1).
//
// It is held in this process: a restart or a second server instance starts with none of it. That is
// safe for the decision itself, because the database records a decision once and an identical repeat
// changes nothing (private.decide_and_enqueue). What is lost with it is only the binding of a key to
// its first request: after a restart the same key with another body is judged as a new request by the
// database, not refused as a reused key. A shared store for that needs a table (a migration).
//
// Issue #93 "smaller": the memory is bounded. An expired entry is dropped first, then the oldest.
export type Replay<T> = { fingerprint: string; response: T };

export interface ReplayCache<T> {
  get(key: string, now?: number): Replay<T> | undefined;
  set(key: string, replay: Replay<T>, now?: number): void;
  delete(key: string): void;
  readonly size: number;
}

export function createReplayCache<T>(options: { ttlMs: number; maxEntries: number }): ReplayCache<T> {
  // A Map keeps insertion order, so its first key is the oldest.
  const entries = new Map<string, Replay<T> & { expiresAt: number }>();
  const prune = (now: number) => {
    for (const [key, entry] of entries) if (entry.expiresAt <= now) entries.delete(key);
  };
  return {
    get(key, now = Date.now()) {
      prune(now);
      const entry = entries.get(key);
      return entry ? { fingerprint: entry.fingerprint, response: entry.response } : undefined;
    },
    set(key, replay, now = Date.now()) {
      prune(now);
      entries.delete(key);
      entries.set(key, { ...replay, expiresAt: now + options.ttlMs });
      while (entries.size > options.maxEntries) entries.delete(entries.keys().next().value as string);
    },
    delete(key) { entries.delete(key); },
    get size() { return entries.size; },
  };
}
