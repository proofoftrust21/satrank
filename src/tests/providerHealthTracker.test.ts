import { describe, it, expect, vi } from 'vitest';
import { ProviderHealthTracker } from '../utils/providerHealthTracker';

describe('ProviderHealthTracker', () => {
  it('emits provider_health_degraded exactly once after N consecutive failures', () => {
    const warn = vi.fn();
    const tracker = new ProviderHealthTracker(10, { warn });

    for (let i = 0; i < 10; i++) {
      tracker.recordFailure(`https://www.plebtv.com/api/l402/video/${i}`, 'http_5xx_after_retry');
    }

    expect(warn).toHaveBeenCalledTimes(1);
    const [payload, msg] = warn.mock.calls[0];
    expect(payload).toMatchObject({
      event: 'provider_health_degraded',
      host: 'www.plebtv.com',
      consecutiveFailures: 10,
      lastErrorKind: 'http_5xx_after_retry',
    });
    expect(typeof (payload as { firstSeenInRun: unknown }).firstSeenInRun).toBe('number');
    expect(msg).toMatch(/degraded/i);
  });

  it('does not re-emit even if the host keeps failing past the threshold in the same run', () => {
    const warn = vi.fn();
    const tracker = new ProviderHealthTracker(10, { warn });
    for (let i = 0; i < 15; i++) {
      tracker.recordFailure(`https://bad.example.com/path${i}`, 'network_error');
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not emit when a success resets the counter before the threshold', () => {
    const warn = vi.fn();
    const tracker = new ProviderHealthTracker(10, { warn });

    for (let i = 0; i < 5; i++) {
      tracker.recordFailure(`https://flaky.example.com/path${i}`, 'decode_failed');
    }
    tracker.recordSuccess('https://flaky.example.com/ok');
    for (let i = 0; i < 4; i++) {
      tracker.recordFailure(`https://flaky.example.com/again${i}`, 'decode_failed');
    }

    expect(warn).not.toHaveBeenCalled();
  });

  it('tracks hosts independently — A crossing threshold does not trigger B', () => {
    const warn = vi.fn();
    const tracker = new ProviderHealthTracker(10, { warn });

    for (let i = 0; i < 10; i++) {
      tracker.recordFailure(`https://host-a.example.com/${i}`, 'network_error');
      tracker.recordFailure(`https://host-b.example.com/${i}`, 'invoice_malformed');
    }

    expect(warn).toHaveBeenCalledTimes(2);
    const hosts = warn.mock.calls.map((c) => (c[0] as { host: string }).host).sort();
    expect(hosts).toEqual(['host-a.example.com', 'host-b.example.com']);
  });

  it('silently ignores malformed URLs without throwing or logging', () => {
    const warn = vi.fn();
    const tracker = new ProviderHealthTracker(2, { warn });
    expect(() => tracker.recordFailure('not-a-url', 'network_error')).not.toThrow();
    expect(() => tracker.recordSuccess('not-a-url')).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});
