import { describe, it, expect } from 'vitest';
import { HostRateLimiter } from '../utils/hostRateLimiter';

describe('HostRateLimiter', () => {
  it('respects minGapMs per host independently — 10 hosts × 3 calls ≈ 2 × gap, not 29 × gap', async () => {
    const limiter = new HostRateLimiter(100);
    const urls: string[] = [];
    for (let h = 0; h < 10; h++) {
      for (let c = 0; c < 3; c++) {
        urls.push(`https://host${h}.example.com/path${c}`);
      }
    }

    const start = Date.now();
    await Promise.all(urls.map((u) => limiter.wait(u)));
    const elapsed = Date.now() - start;

    // Per-host scheme: 3 concurrent calls per host → waits at 0, 100, 200ms.
    // Wall time ≈ 200ms total (dominated by the longest per-host chain).
    // Global-naive scheme would be 29 × 100 = 2900ms minimum.
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(600);
  });

  it('does not block calls to different hosts', async () => {
    const limiter = new HostRateLimiter(500);

    // First call to host A starts the cooldown.
    await limiter.wait('https://host-a.example.com/x');

    // A call to host B immediately after should not wait.
    const start = Date.now();
    await limiter.wait('https://host-b.example.com/y');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(50);
  });

  it('serializes sequential same-host calls with the configured gap', async () => {
    const limiter = new HostRateLimiter(100);
    const host = 'https://single-host.example.com';

    const t0 = Date.now();
    await limiter.wait(`${host}/a`);
    const t1 = Date.now();
    await limiter.wait(`${host}/b`);
    const t2 = Date.now();
    await limiter.wait(`${host}/c`);
    const t3 = Date.now();

    expect(t1 - t0).toBeLessThan(50);
    expect(t2 - t1).toBeGreaterThanOrEqual(90);
    expect(t3 - t2).toBeGreaterThanOrEqual(90);
  });

  it('skips the rate limit for malformed URLs instead of throwing', async () => {
    const limiter = new HostRateLimiter(1000);
    const start = Date.now();
    await expect(limiter.wait('not-a-url')).resolves.toBeUndefined();
    expect(Date.now() - start).toBeLessThan(50);
  });
});
