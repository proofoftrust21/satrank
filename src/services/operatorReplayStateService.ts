// Phase 12.9 (2026-05-06) — operator replay-state shared service.
//
// Extracted from fulfillService private state so the IntentRanker can
// read it at rank time. Sim 17 finding (a2 explicit) :
//   "Same lightningenable operator (027cd9...) accumulated invoice-
//    replay state across calls, which then caused pay_skipped_replay_
//    state on later attempts — SatRank kept ranking it #1 anyway."
//
// fulfillService.attemptCandidate already SKIPS pre-pay when an operator
// is in lockout (Sim 13 Fix 1.2), but the ranker still puts them at top.
// Result : agents see the broken operator in /api/intent, attempt
// fulfill, see pay_skipped_replay_state, refund. Wasted RTT.
//
// Move the in-memory state into a process-wide service ; both
// fulfillService (writes on every pay_invoice_replayed) and
// Bm25HybridRanker / LegacyRanker (reads at rank time to push past
// top-K) share the same instance.
//
// V1 in-memory only ; multi-process scale would need Redis. State is
// inherently transient (5 min decay window) so a process restart
// effectively resets the lockout — agents get to retry the operator
// after a restart, which is the safer default.

const REPLAY_WINDOW_MS = 5 * 60 * 1000;
const REPLAY_THRESHOLD = 2;

interface ReplayState {
  count: number;
  last_seen_ms: number;
}

export class OperatorReplayStateService {
  private readonly state: Map<string, ReplayState> = new Map();
  /** Test override : caller-supplied clock so we can simulate time
   *  decay without sleeping. Defaults to Date.now(). */
  private readonly nowMs: () => number;

  constructor(opts: { nowMs?: () => number } = {}) {
    this.nowMs = opts.nowMs ?? (() => Date.now());
  }

  /** Record a replay event for an operator. Resets the count if the
   *  decay window has elapsed since the last hit. */
  recordReplay(operatorPubkey: string): void {
    if (!operatorPubkey) return;
    const now = this.nowMs();
    const prev = this.state.get(operatorPubkey);
    const stale = !prev || now - prev.last_seen_ms > REPLAY_WINDOW_MS;
    this.state.set(operatorPubkey, {
      count: stale ? 1 : prev.count + 1,
      last_seen_ms: now,
    });
  }

  /** Active lockout = count strictly above threshold AND within decay
   *  window. The strictly-above choice mirrors the existing fulfill-
   *  side gate (Sim 13 Fix 1.2) so both paths agree. */
  isLockedOut(operatorPubkey: string): boolean {
    if (!operatorPubkey) return false;
    const s = this.state.get(operatorPubkey);
    if (!s) return false;
    if (this.nowMs() - s.last_seen_ms > REPLAY_WINDOW_MS) return false;
    return s.count > REPLAY_THRESHOLD;
  }

  /** Diagnostic surface for /api/oracle and observability dashboards. */
  getState(operatorPubkey: string): ReplayState | undefined {
    return this.state.get(operatorPubkey);
  }

  /** Test helper : reset all state. Production must NEVER call this. */
  _resetForTests(): void {
    this.state.clear();
  }
}
