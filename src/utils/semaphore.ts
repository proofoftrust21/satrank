// Semaphore — limit concurrent operations (e.g. LND queryRoutes)
// Protects shared resources from cascading failures under load.

export class Semaphore {
  private inflight = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  /** Acquires a slot — returns a release function that must be called. */
  async acquire(): Promise<() => void> {
    if (this.inflight < this.max) {
      this.inflight++;
      return () => this.release();
    }
    return new Promise(resolve => {
      this.queue.push(() => {
        this.inflight++;
        resolve(() => this.release());
      });
    });
  }

  /** Wraps an async operation — acquires, runs, releases (even on error). */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try { return await fn(); } finally { release(); }
  }

  private release(): void {
    this.inflight--;
    const next = this.queue.shift();
    if (next) next();
  }

  get inFlight(): number { return this.inflight; }
  get waiting(): number { return this.queue.length; }
}
