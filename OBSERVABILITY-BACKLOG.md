# Observability Backlog

Deferred LOW-priority items that need more than a quick edit. Everything CRITICAL / HIGH / MEDIUM is shipped (see [OBSERVABILITY-COVERAGE.md](./OBSERVABILITY-COVERAGE.md)).

## Items to ship later

### Relay bandwidth accounting

- **What**: bytes in/out per Nostr relay.
- **Why skipped**: `nostr-tools` does not expose WebSocket payload sizes — it wraps `ws` and hides byte counts behind its own publish/subscribe API. Instrumenting requires either patching nostr-tools internals or swapping the relay transport for a thin wrapper that counts frames.
- **Threshold to revisit**: we start hitting a relay's rate limit / bandwidth cap, or we sign up for a paid relay that bills by bytes.
- **Likely shape**: `satrank_nostr_relay_bytes_total{relay, direction}` counter (direction=in|out).

### Pino log-level distribution metric

- **What**: gauge of warn / error log rate over time.
- **Why skipped**: cleanest solution is `pino-prometheus` (or a similar sidecar) which adds a new npm dependency and boot ordering concern (pino streams are frozen after `pino()`). Not worth the churn at current log volume — logs are grep-able and structured.
- **Threshold to revisit**: when Loki / log-shipping is wired up and we want a single pane of glass for ops.

## Done — kept here as a changelog

- Deposit phase counter (#1) — shipped `satrank_deposit_phase_total{phase}` with phases `invoice_created`, `verify_success_fresh`, `verify_success_cached`, `verify_pending`, `verify_not_found`.
- Watchlist flagged-changes counter (#2) — shipped `satrank_watchlist_changes_total{direction}` with directions `up`, `down`, `fresh`. Incremented on cache miss so the metric tracks detected business events, not poll volume.
- Per-endpoint verdict label (#5) — shipped `source` label on `satrank_verdict_total`: `decide` / `verdict` / `best-route` / `dvm` / `mcp` / `unknown` (default for test callers).
- Dead fallback cleanup (#6) — removed `try/catch` guards in `agentRepository.updateLightningStats`, `touchLastQueried`, `findHotNodes` that targeted pre-v28 schema. Schema has been at v28 for a while; the fallbacks masked any real runtime error those methods could throw.
