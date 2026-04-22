// Per-host rate limiter used by the backfill script and registry crawler.
//
// Replaces the historical global `RATE_LIMIT_MS` pattern — a single sleep after
// every request regardless of destination. That serialization was the opposite
// of what a polite crawler wants: it slowed down parallel probes to unrelated
// hosts while letting sequential probes against ONE host hit its rate limit
// (2026-04-22 incident: 28 www.plebtv.com URLs × 500ms = 14s tripped plebtv's
// server-side rate limit mid-backfill, leaving 28 NULL rows).
//
// The fix is to key the cooldown on `new URL(url).host` so the gap is enforced
// per provider, not globally. Two calls to different hosts race freely; two
// calls to the same host respect `minGapMs`.
//
// Concurrency correctness: `wait()` reserves the next slot BEFORE awaiting so
// parallel callers against the same host queue deterministically. If three
// concurrent `wait("https://h/x")` fire at t=0 with minGapMs=500, they resolve
// at t=0, t=500, t=1000 — not all three at t=0 (which would happen if we set
// the timestamp after the sleep instead of before).

export class HostRateLimiter {
  private readonly lastCallAt = new Map<string, number>();

  constructor(private readonly minGapMs: number) {}

  /** Block until enough time has elapsed since the last call to `url`'s host. */
  async wait(url: string): Promise<void> {
    const host = this.hostOf(url);
    if (host === null) return;
    const last = this.lastCallAt.get(host) ?? 0;
    const next = Math.max(Date.now(), last + this.minGapMs);
    this.lastCallAt.set(host, next);
    const delay = next - Date.now();
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  /** Extract host, returning null for malformed URLs (so the caller just skips
   *  the rate limit rather than crash — the downstream fetch will error more
   *  informatively anyway). */
  private hostOf(url: string): string | null {
    try {
      return new URL(url).host;
    } catch {
      return null;
    }
  }
}
