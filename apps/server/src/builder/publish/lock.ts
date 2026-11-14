// Runs work for one key at a time, in arrival order. Publish, pause, rollback
// and draft writes for one agent go through the same key, so two of them can
// never interleave. In memory only: one server process. A database version
// needs a row lock on the agents row instead (select ... for update).
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

// The key for one builder session. Chat turns and agent creates from a
// session use it on the same KeyedLock (see builder/index.ts).
export function sessionLockKey(businessId: string, sessionId: string): string {
  return `${businessId}:${sessionId}`;
}
