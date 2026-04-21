// Public monitoring endpoint for the 30-day report adoption dashboard.
//
// Question we need to answer in 30 days: "Did Tier 1 (badge) generate enough
// report volume on its own?" Target: N >= 200 in the 30-day window.
//
// Public fields (no auth):
//   - weekly bucket counts of reports submitted (total / verified / unique reporters)
//   - cumulative count + progress vs target
// Privileged fields (X-API-Key required):
//   - Tier 2 `bonus.*` section (payouts, distinct recipients, enabled flag)
//
// The bonus payout counters are commercially-sensitive (competitors could map
// adoption vs spend). The 30-day window + cache freshness still leak at the
// weekly granularity — that's a deliberate compromise for the public dashboard.
// Cached for 5 minutes because it runs GROUP BY on the attestations table.
import type { Request, Response, NextFunction } from 'express';
import type { Pool } from 'pg';
import type { ReportBonusRepository } from '../repositories/reportBonusRepository';
import * as memoryCache from '../cache/memoryCache';
import { safeEqual } from '../middleware/auth';
import { config } from '../config';

const CACHE_KEY = 'stats:reports';
const CACHE_TTL_MS = 5 * 60_000;

interface ReportWeekBucket {
  weekStart: string; // YYYY-MM-DD of the week's Monday (UTC)
  submitted: number;
  verified: number;
  distinctReporters: number;
}

interface ReportStatsResponse {
  window: { sinceDays: number; generatedAt: number };
  summary: {
    totalSubmitted: number;
    totalVerified: number;
    distinctReporters: number;
    targetN: number;
    progressPct: number;
  };
  weekly: ReportWeekBucket[];
  bonus: {
    enabled: boolean;
    totalBonusesGranted: number;
    totalSatsPaid: number;
    distinctRecipients: number;
  };
}

export class ReportStatsController {
  constructor(
    private pool: Pool,
    private bonusRepo: ReportBonusRepository,
    private bonusEnabledGetter: () => boolean,
  ) {}

  getStats = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const full = await memoryCache.getOrComputeAsync<ReportStatsResponse>(
        CACHE_KEY, CACHE_TTL_MS, () => this.compute(30),
      );

      // Audit H7: the `bonus.*` numbers (payouts, distinct recipients, enabled
      // flag) are commercially sensitive. Redact for unauthenticated callers.
      const apiKey = req.headers['x-api-key'] as string | undefined;
      const isPrivileged = config.API_KEY ? safeEqual(apiKey, config.API_KEY) : false;
      if (isPrivileged) {
        res.json({ data: full });
        return;
      }
      const { bonus: _bonus, ...publicFields } = full;
      res.json({ data: publicFields });
    } catch (err) {
      next(err);
    }
  };

  private async compute(sinceDays: number): Promise<ReportStatsResponse> {
    const now = Math.floor(Date.now() / 1000);
    const sinceUnix = now - sinceDays * 86400;
    const sinceDay = new Date(sinceUnix * 1000).toISOString().slice(0, 10);

    // Summary: all reports in the last N days
    const summaryRes = await this.pool.query<{ submitted: string; verified: string; distinct_reporters: string }>(
      `SELECT
         COUNT(*)::bigint AS submitted,
         SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END)::bigint AS verified,
         COUNT(DISTINCT attester_hash)::bigint AS distinct_reporters
       FROM attestations
       WHERE category IN ('successful_transaction','failed_transaction','unresponsive')
         AND timestamp >= $1`,
      [sinceUnix],
    );
    const summary = summaryRes.rows[0] ?? { submitted: '0', verified: '0', distinct_reporters: '0' };
    const submittedCount = Number(summary.submitted);
    const verifiedCount = Number(summary.verified);
    const distinctReportersCount = Number(summary.distinct_reporters);

    // Weekly buckets. ISO weeks via PG to_char(IYYY-IW) = ISO year + ISO week,
    // equivalent to SQLite's strftime('%Y-%W', ...) for our purposes.
    // We group by ISO (year, week) to survive year boundaries cleanly.
    const weeklyRes = await this.pool.query<{
      year_week: string;
      week_start_ts: string;
      submitted: string;
      verified: string;
      distinct_reporters: string;
    }>(
      `SELECT
         to_char(to_timestamp(timestamp), 'IYYY-IW') AS year_week,
         MIN(timestamp)::bigint AS week_start_ts,
         COUNT(*)::bigint AS submitted,
         SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END)::bigint AS verified,
         COUNT(DISTINCT attester_hash)::bigint AS distinct_reporters
       FROM attestations
       WHERE category IN ('successful_transaction','failed_transaction','unresponsive')
         AND timestamp >= $1
       GROUP BY year_week
       ORDER BY year_week`,
      [sinceUnix],
    );

    const weekly: ReportWeekBucket[] = weeklyRes.rows.map(r => ({
      weekStart: new Date(Number(r.week_start_ts) * 1000).toISOString().slice(0, 10),
      submitted: Number(r.submitted),
      verified: Number(r.verified),
      distinctReporters: Number(r.distinct_reporters),
    }));

    const bonus = await this.bonusRepo.summarySince(sinceDay);

    const TARGET_N = 200;
    const totalSubmitted = submittedCount;
    return {
      window: { sinceDays, generatedAt: now },
      summary: {
        totalSubmitted,
        totalVerified: verifiedCount,
        distinctReporters: distinctReportersCount,
        targetN: TARGET_N,
        progressPct: Math.min(100, Math.round((totalSubmitted / TARGET_N) * 1000) / 10),
      },
      weekly,
      bonus: {
        enabled: this.bonusEnabledGetter(),
        totalBonusesGranted: bonus.totalBonuses,
        totalSatsPaid: bonus.totalSats,
        distinctRecipients: bonus.distinctReporters,
      },
    };
  }
}
