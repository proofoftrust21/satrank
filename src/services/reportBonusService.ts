// Tier 2 economic incentive service — OFF by default, gated by the env flag
// REPORT_BONUS_ENABLED. This service encapsulates everything:
//   1. In-process enabled flag (initialized from env, flipped to false by
//      auto-rollback when SAFE verdict ratio deviates abnormally).
//   2. Eligibility gate: SatRank reporter score >= threshold OR aged npub
//      via NIP-98 signature.
//   3. Daily counter + sats credit persistence (via ReportBonusRepository).
//   4. Atomic balance credit on the reporter's L402 token.
//   5. Auto-rollback watcher that compares rolling SAFE ratio to the baseline
//      captured when the bonus was enabled.
//
// The service is safe to construct in every environment. When
// `REPORT_BONUS_ENABLED` is false at boot AND never flipped at runtime, the
// only side-effect is a 0-valued gauge for `satrank_report_bonus_enabled`.
//
// Attack surface reminders (see REPORT-INCENTIVE-DESIGN.md for the full model):
//  - Reward is strictly less than query cost (0.1 sat/report vs 1 sat/decide),
//    so an attacker cannot auto-finance spam. They can only break-even, which
//    poisons the scoring at zero cost — hence the gate and the auto-rollback.
//  - Preimage verification in reportService is cryptographic, not an LN proof.
//    The gate is what actually makes the bonus defensible.
import type { Pool } from 'pg';
import type { Request } from 'express';
import { ReportBonusRepository } from '../repositories/reportBonusRepository';
import type { ScoringService } from './scoringService';
import type { NpubAgeCache } from '../nostr/npubAgeCache';
import { verifyNip98 } from '../middleware/nip98';
import { withTransaction } from '../database/transaction';
import { logger } from '../logger';
import { config } from '../config';
import {
  reportBonusEnabledGauge,
  reportBonusTotal,
  reportBonusPayoutSatsTotal,
  reportBonusGateTotal,
  reportBonusRollbackTotal,
  verdictTotal,
} from '../middleware/metrics';

export interface ReportBonusServiceOptions {
  enabledFromEnv: boolean;
  threshold: number;          // e.g. 10 reports
  dailyCap: number;           // e.g. 3 bonuses/day/reporter
  satsPerBonus: number;       // e.g. 1
  minReporterScore: number;   // e.g. 30
  minNpubAgeDays: number;     // e.g. 30
  rollbackRatio: number;      // e.g. 1.3
  guardIntervalMs: number;    // e.g. 15 * 60_000
}

export type EligibilityGate = 'score' | 'nip98' | 'none';

export class ReportBonusService {
  private enabled: boolean;
  private guardTimer: NodeJS.Timeout | null = null;

  // --- Auto-rollback guard state (audit C3) ---
  // We compare a 1-hour rolling window to a 24-hour baseline instead of
  // cumulative SAFE/total ratio (which barely moves under attack once the
  // counter has accumulated). Snapshot triples: [taken_at_ms, safe, total].
  // The window picks the oldest sample >= (now - windowMs) and compares
  // rate over the window to the baseline rate.
  private readonly GUARD_BASELINE_MS = 24 * 60 * 60_000;
  private readonly GUARD_WINDOW_MS = 60 * 60_000;
  private readonly GUARD_MIN_VERDICTS = 100; // below this, window is too noisy
  private samples: Array<{ ts: number; safe: number; total: number }> = [];

  constructor(
    private pool: Pool,
    private repo: ReportBonusRepository,
    private scoringService: ScoringService,
    private npubAges: NpubAgeCache,
    private opts: ReportBonusServiceOptions,
  ) {
    this.enabled = opts.enabledFromEnv;
    reportBonusEnabledGauge.set(this.enabled ? 1 : 0);
    if (this.enabled) {
      // Seed the sample ring with the starting state so the guard has a
      // reference point immediately (no "warm up" gap where attacks are invisible).
      this.recordSample();
      logger.info('Report bonus enabled — guard initialized');
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Evaluate eligibility without crediting. Public so tests can exercise the
   *  gate independently. Returns the gate that accepted OR 'none'. */
  async evaluateEligibility(
    reporterHash: string,
    req: Request,
  ): Promise<{ eligible: boolean; gate: EligibilityGate }> {
    // Gate A: reporter has a meaningful SatRank score. Cheapest path — just
    // one snapshot lookup. Covers the dominant legitimate-user case.
    const scoreResult = await this.scoringService.getScore(reporterHash);
    const score = scoreResult.total;
    if (score >= this.opts.minReporterScore) {
      return { eligible: true, gate: 'score' };
    }

    // Gate B: NIP-98 signed request from an aged Nostr identity. Only used
    // when the reporter does not yet have a score (fresh agent, Observer-only
    // reporter, etc.). The signature proves someone with a long-established
    // Nostr presence authored this specific request.
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Nostr ')) {
      return { eligible: false, gate: 'none' };
    }
    // Canonical host from server-side config — DO NOT trust req.headers.host
    // (attacker-controlled; audit H3). Any NIP-98 event must bind to this
    // exact public hostname to be accepted.
    const fullUrl = `https://${config.PUBLIC_HOST}${req.originalUrl.split('?')[0]}`;
    const rawBody = (req as Request & { rawBody?: Buffer | string }).rawBody ?? null;
    const verified = await verifyNip98(authHeader, req.method, fullUrl, rawBody);
    if (!verified.valid || !verified.pubkey) {
      // `detail` is diagnostic-only — NEVER surface to the HTTP response
      // (audit M2 oracle closure). Stays in the server log.
      logger.warn({ reporterHash: reporterHash.slice(0, 12), detail: verified.detail }, 'NIP-98 verification failed for bonus gate');
      return { eligible: false, gate: 'none' };
    }
    if (!this.npubAges.isAgedNpub(verified.pubkey, this.opts.minNpubAgeDays)) {
      return { eligible: false, gate: 'none' };
    }
    return { eligible: true, gate: 'nip98' };
  }

  /** Called by reportService AFTER a successful report insert. Decides whether
   *  to credit a bonus atomically with the per-day counter update.
   *
   *  Returns `{ credited: true, sats }` when a bonus is awarded, otherwise
   *  `{ credited: false }` with a reason. Always emits the gate metric so
   *  dashboards see traffic even when the bonus is off. */
  async maybeCredit(params: {
    reporterHash: string;
    req: Request;
    verified: boolean;
    paymentHash: Buffer | null;
  }): Promise<{ credited: boolean; sats?: number; gate: EligibilityGate; reason?: string }> {
    if (!params.verified) {
      // Preimage-verified requirement. Non-verified reports never earn a bonus.
      return { credited: false, gate: 'none', reason: 'not_verified' };
    }

    // Audit M4: skip the eligibility compute entirely when the bonus is off.
    // Previously we ran a scoreService lookup + (potential) NIP-98 verify on
    // every report even though the result was discarded — asymmetric CPU cost
    // the attacker could pay 1 sat to inflict.
    if (!this.enabled) {
      return { credited: false, gate: 'none', reason: 'disabled' };
    }

    const { eligible, gate } = await this.evaluateEligibility(params.reporterHash, params.req);
    // Audit M3: only emit the gate metric when the bonus can actually pay out.
    // When disabled, the metric gave attackers an oracle for probing gate
    // acceptance at zero risk.
    reportBonusGateTotal.inc({ gate });

    if (!eligible) {
      return { credited: false, gate, reason: 'gate_rejected' };
    }
    if (!params.paymentHash) {
      // We need the payment_hash to credit the balance; API-key path has none.
      return { credited: false, gate, reason: 'no_payment_hash' };
    }
    // Narrow once for the closure — TS cannot track non-null through
    // `withTransaction(...)`, so we bind a local non-null reference.
    const paymentHash: Buffer = params.paymentHash;

    const utcDay = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const nowUnix = Math.floor(Date.now() / 1000);

    // Atomic: read-modify-write the counter + balance in a single tx so two
    // concurrent reports cannot double-credit the same threshold crossing.
    const creditResult: { credited: boolean; sats?: number; reason?: string } = await withTransaction(
      this.pool,
      async (client) => {
        const repoInTx = new ReportBonusRepository(client);
        const before = await repoInTx.findToday(params.reporterHash, utcDay);
        if (before && before.bonuses_credited >= this.opts.dailyCap) {
          return { credited: false, reason: 'daily_cap_reached' };
        }
        const newCount = await repoInTx.incrementEligibleCount(params.reporterHash, utcDay);
        if (newCount % this.opts.threshold !== 0) {
          return { credited: false, reason: 'below_threshold' };
        }
        // Threshold crossed — pay out.
        await repoInTx.recordBonusCredit(params.reporterHash, utcDay, this.opts.satsPerBonus, nowUnix);
        const result = await client.query(
          'UPDATE token_balance SET remaining = remaining + $1 WHERE payment_hash = $2',
          [this.opts.satsPerBonus, paymentHash],
        );
        if ((result.rowCount ?? 0) === 0) {
          // Token gone (rare race — L402 revoked between report insert and credit).
          // Rollback the bonus counter so the user isn't charged against their cap.
          throw new Error('Balance credit targeted a missing token');
        }
        return { credited: true, sats: this.opts.satsPerBonus };
      },
    );

    if (creditResult.credited) {
      reportBonusTotal.inc();
      reportBonusPayoutSatsTotal.inc(creditResult.sats ?? 0);
      logger.info({
        reporterHash: params.reporterHash.slice(0, 12),
        gate,
        sats: creditResult.sats,
      }, 'Report bonus credited');
    }
    return { ...creditResult, gate };
  }

  /** Snapshot the current (cumulative SAFE count, cumulative total count) from
   *  Prometheus counter state. We compare deltas across time windows, not the
   *  cumulative ratio — cumulative saturates after ~1M verdicts and hides
   *  short-term attacks (audit C3). */
  private snapshotSafeTotals(): { safe: number; total: number } | null {
    try {
      const metric = verdictTotal as unknown as {
        hashMap: Record<string, { value: number; labels: Record<string, string> }>;
      };
      const values = Object.values(metric.hashMap ?? {});
      let total = 0;
      let safe = 0;
      for (const v of values) {
        total += v.value;
        if (v.labels.verdict === 'SAFE') safe += v.value;
      }
      return { safe, total };
    } catch {
      return null;
    }
  }

  /** Append the current counter snapshot to the ring and trim entries older
   *  than GUARD_BASELINE_MS so memory stays bounded. */
  private recordSample(): void {
    const snap = this.snapshotSafeTotals();
    if (!snap) return;
    const now = Date.now();
    this.samples.push({ ts: now, ...snap });
    const cutoff = now - this.GUARD_BASELINE_MS;
    while (this.samples.length > 0 && this.samples[0].ts < cutoff) this.samples.shift();
  }

  /** Compute SAFE/total ratio over the window [from, now]. Returns null when
   *  the window has fewer than GUARD_MIN_VERDICTS total verdicts (too noisy). */
  private windowRate(sinceMs: number): number | null {
    const latest = this.samples[this.samples.length - 1];
    if (!latest) return null;
    // Find the oldest sample at or before `sinceMs`.
    let anchor = this.samples[0];
    for (const s of this.samples) {
      if (s.ts <= sinceMs) anchor = s;
      else break;
    }
    if (!anchor || anchor.ts > sinceMs) return null;
    const deltaTotal = latest.total - anchor.total;
    const deltaSafe = latest.safe - anchor.safe;
    if (deltaTotal < this.GUARD_MIN_VERDICTS) return null;
    return deltaSafe / deltaTotal;
  }

  /** Start the watchdog. Every `guardIntervalMs`:
   *    1. record a fresh sample.
   *    2. compute window (1h) and baseline (24h) rates.
   *    3. if both are available and window_rate > baseline_rate × rollbackRatio,
   *       flip enabled=false.
   *  This closes audit C3: cumulative ratio was insensitive to short-term
   *  poisoning; the windowed delta catches it within one guard tick. */
  startGuard(): void {
    if (this.guardTimer) return;
    if (!this.enabled) return;
    this.guardTimer = setInterval(() => {
      if (!this.enabled) return;
      this.recordSample();
      const now = Date.now();
      const windowRate = this.windowRate(now - this.GUARD_WINDOW_MS);
      const baselineRate = this.windowRate(now - this.GUARD_BASELINE_MS);
      if (windowRate === null || baselineRate === null) return;
      if (baselineRate === 0) return;
      const ratio = windowRate / baselineRate;
      if (ratio > this.opts.rollbackRatio) {
        logger.error({
          baselineRate, windowRate, ratio, limit: this.opts.rollbackRatio,
          windowMinutes: this.GUARD_WINDOW_MS / 60_000,
          baselineHours: this.GUARD_BASELINE_MS / 3_600_000,
        }, 'Report bonus auto-rollback tripped — 1h SAFE ratio climbed past 24h baseline');
        this.enabled = false;
        reportBonusEnabledGauge.set(0);
        reportBonusRollbackTotal.inc();
      }
    }, this.opts.guardIntervalMs);
    this.guardTimer.unref?.();
  }

  stopGuard(): void {
    if (this.guardTimer) {
      clearInterval(this.guardTimer);
      this.guardTimer = null;
    }
  }

  /** For operator tooling — flip the flag off without restart. No re-enable
   *  path: use the env var + process restart to turn it back on so the action
   *  leaves a clear audit trail. */
  disableForRollback(reason: string): void {
    if (!this.enabled) return;
    this.enabled = false;
    reportBonusEnabledGauge.set(0);
    reportBonusRollbackTotal.inc();
    logger.error({ reason }, 'Report bonus manually disabled');
  }
}
