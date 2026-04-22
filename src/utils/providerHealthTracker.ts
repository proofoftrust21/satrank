// Provider health tracker — counts consecutive failures per host within a single
// run and emits a single structured log when a host crosses the degraded
// threshold. Run-scoped: a fresh instance per script invocation; nothing
// persists across runs. Intended for backfill/crawler loops so operators can
// spot a provider-wide outage (e.g. the 2026-04-22 plebtv incident: 28 URLs
// returning HTTP 500 in a row) in docker logs without polling external status
// pages.
//
// Threshold is deliberately high (default 10) to avoid false positives on
// providers with occasional flakes. Not an alerting mechanism — just an
// observability breadcrumb in the logs.

import { logger as defaultLogger } from '../logger';

/** The four error kinds a provider is blamed for. Rate-limit skips (429) and
 *  circuit-breaker skips are NOT tracked here: rate limits are our decision to
 *  defer, and the LND breaker is our component, not the provider's fault. */
export type ProviderErrorKind =
  | 'http_5xx_after_retry'
  | 'invoice_malformed'
  | 'network_error'
  | 'decode_failed';

interface HostState {
  consecutiveFailures: number;
  lastErrorKind: ProviderErrorKind | null;
  firstSeenInRun: number | null;
  degradedLogged: boolean;
}

interface MinimalLogger {
  warn(obj: object, msg: string): void;
}

export class ProviderHealthTracker {
  private readonly state = new Map<string, HostState>();

  constructor(
    private readonly threshold: number = 10,
    private readonly log: MinimalLogger = defaultLogger,
  ) {}

  recordFailure(url: string, kind: ProviderErrorKind): void {
    const host = this.hostOf(url);
    if (host === null) return;
    const s = this.state.get(host) ?? {
      consecutiveFailures: 0,
      lastErrorKind: null,
      firstSeenInRun: null,
      degradedLogged: false,
    };
    s.consecutiveFailures += 1;
    s.lastErrorKind = kind;
    if (s.firstSeenInRun === null) {
      s.firstSeenInRun = Math.floor(Date.now() / 1000);
    }
    if (s.consecutiveFailures >= this.threshold && !s.degradedLogged) {
      this.log.warn(
        {
          event: 'provider_health_degraded',
          host,
          consecutiveFailures: s.consecutiveFailures,
          lastErrorKind: s.lastErrorKind,
          firstSeenInRun: s.firstSeenInRun,
        },
        'Provider appears degraded — consider external check',
      );
      s.degradedLogged = true;
    }
    this.state.set(host, s);
  }

  recordSuccess(url: string): void {
    const host = this.hostOf(url);
    if (host === null) return;
    const s = this.state.get(host);
    if (!s) return;
    s.consecutiveFailures = 0;
    s.lastErrorKind = null;
    s.firstSeenInRun = null;
    // degradedLogged stays true — "une seule ligne par run" means a host that
    // flip-flops within a single run logs only the first degradation, even if
    // it recovers and re-degrades. Avoids log spam on genuinely flaky providers.
    this.state.set(host, s);
  }

  private hostOf(url: string): string | null {
    try {
      return new URL(url).host;
    } catch {
      return null;
    }
  }
}
