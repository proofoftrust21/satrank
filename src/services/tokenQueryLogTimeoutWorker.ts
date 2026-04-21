// Timeout worker for unresolved paid target-query intents.
//
// Per docs/PHASE-1-DESIGN.md §4 case 3: when an agent queries a target via a
// paid endpoint (verdict, profile, verdicts) but never follows up with
// /report before INTENT_OUTCOME_TIMEOUT_HOURS elapses, the intent stays
// recorded in `token_query_log` and is classified as "timed out". We do NOT
// write a synthetic row into `transactions` for such intents — polluting
// the ledger with unresolved intents would misrepresent actual payment
// flow. The `token_query_log` row alone is the lone trace.
//
// This worker is a pure observer:
//   - scans `token_query_log` for rows older than the timeout threshold
//   - skips any row whose `(payment_hash, target_hash)` is already closed
//     out by a row in `transactions` (matched via tx_id derivation or via
//     the `source='intent'` rows written by ReportService)
//   - emits a count for metrics / audit
//   - writes NOTHING to `transactions`
//
// The `source='intent'` write path lives in `ReportService.submit()` — this
// worker is strictly the no-op counterpart that accounts for the 3rd
// exhaustive case of §4. Tests assert `transactions` row count is unchanged
// after a scan across a seeded token_query_log with expired rows.
import type { Pool } from 'pg';
import { logger } from '../logger';

export interface TokenQueryLogTimeoutScanResult {
  /** token_query_log rows older than the timeout threshold that have no
   *  matching resolved tx (neither `source='intent'` via reportService nor
   *  any other follow-up). These are the "lost intents" — counted for
   *  observability, never materialized into `transactions`. */
  expired: number;
  /** Rows that were already resolved (a tx with `source='intent'` exists for
   *  their `(payment_hash, target_hash)` pair). Skipped — no-op. */
  resolved: number;
  /** Rows younger than the timeout (still in the grace window). Skipped —
   *  a /report may still arrive. */
  pending: number;
}

export class TokenQueryLogTimeoutWorker {
  constructor(
    private pool: Pool,
    private timeoutHours: number = 24,
  ) {}

  /** Scan `token_query_log` and classify every row. INVARIANT: zero
   *  inserts, zero updates, zero deletes. A failed scan must not crash the
   *  process — we log and return a best-effort result. */
  async scan(nowSeconds: number = Math.floor(Date.now() / 1000)): Promise<TokenQueryLogTimeoutScanResult> {
    const result: TokenQueryLogTimeoutScanResult = { expired: 0, resolved: 0, pending: 0 };
    const cutoff = nowSeconds - this.timeoutHours * 3600;

    try {
      const { rows } = await this.pool.query<{ payment_hash: Buffer; target_hash: string; decided_at: number }>(
        'SELECT payment_hash, target_hash, decided_at FROM token_query_log',
      );

      // Bulk-fetch resolved (payment_hash, target_hash) pairs from
      // transactions so the O(n) scan doesn't issue n queries. A resolved
      // intent has a matching tx with source='intent' for the same
      // (receiver_hash = target_hash, payment_hash equal). Both ReportService
      // write paths (intent + report) store the full payment_hash hex on tx;
      // token_query_log keeps it as the raw sha256 Buffer. Compare on hex.
      const { rows: resolvedRows } = await this.pool.query<{ payment_hash: string; receiver_hash: string }>(
        "SELECT payment_hash, receiver_hash FROM transactions WHERE source = 'intent'",
      );
      const resolvedSet = new Set(resolvedRows.map(r => `${r.payment_hash}:${r.receiver_hash}`));

      for (const row of rows) {
        const key = `${row.payment_hash.toString('hex')}:${row.target_hash}`;
        if (resolvedSet.has(key)) {
          result.resolved++;
          continue;
        }
        if (row.decided_at < cutoff) {
          result.expired++;
          continue;
        }
        result.pending++;
      }
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'token_query_log timeout scan failed',
      );
    }

    return result;
  }
}
