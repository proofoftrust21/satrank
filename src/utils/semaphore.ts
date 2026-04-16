// Semaphore — limit concurrent operations (e.g. LND queryRoutes).
// Protects shared resources from cascading failures under load.
//
// Security fixes (audit 2026-04-16 H1/H2):
//   - One-shot release: the returned release function has a `released` flag
//     so a buggy caller double-releasing can't push `inflight` negative and
//     silently uncap concurrency.
//   - Bounded queue: when the in-flight count is at capacity AND the wait
//     queue is full, acquire() rejects with SemaphoreFullError instead of
//     accumulating unbounded waiter promises (OOM under flood). Callers
//     surface this as a 503 to the client.

export class SemaphoreFullError extends Error {
  constructor(name: string, maxQueue: number) {
    super(`Semaphore '${name}' queue full (max ${maxQueue}) — backpressure applied`);
    this.name = 'SemaphoreFullError';
  }
}

export interface SemaphoreOptions {
  /** Max concurrent slots. */
  max: number;
  /** Max queued waiters before acquire() rejects. Defaults to max × 10. */
  maxQueue?: number;
  /** Optional name for diagnostics (error messages, future metrics). */
  name?: string;
}

export class Semaphore {
  private inflight = 0;
  private queue: Array<() => void> = [];
  private readonly maxQueue: number;
  private readonly name: string;

  constructor(opts: number | SemaphoreOptions) {
    if (typeof opts === 'number') {
      this.max = opts;
      this.maxQueue = opts * 10;
      this.name = 'anonymous';
    } else {
      this.max = opts.max;
      this.maxQueue = opts.maxQueue ?? opts.max * 10;
      this.name = opts.name ?? 'anonymous';
    }
  }

  private readonly max: number;

  /** Acquires a slot — returns a release function that must be called.
   *  Rejects with SemaphoreFullError when the queue is saturated. */
  async acquire(): Promise<() => void> {
    if (this.inflight < this.max) {
      this.inflight++;
      return this.makeRelease();
    }
    if (this.queue.length >= this.maxQueue) {
      throw new SemaphoreFullError(this.name, this.maxQueue);
    }
    return new Promise<() => void>(resolve => {
      this.queue.push(() => {
        this.inflight++;
        resolve(this.makeRelease());
      });
    });
  }

  /** Wraps an async operation — acquires, runs, releases (even on error). */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try { return await fn(); } finally { release(); }
  }

  /** One-shot release factory: calling the returned function twice is a no-op
   *  on the second call. Without this, a caller running `try/finally` plus an
   *  explicit release (typo-prone refactor) would decrement `inflight` twice
   *  and eventually let the count go negative, silently uncapping concurrency. */
  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inflight--;
      const next = this.queue.shift();
      if (next) next();
    };
  }

  get inFlight(): number { return this.inflight; }
  get waiting(): number { return this.queue.length; }
  get queueCapacity(): number { return this.maxQueue; }
}
