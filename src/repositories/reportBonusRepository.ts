// Persistence layer for the Tier 2 report bonus counter.
//
// One row per (reporter_hash, utc_day). We UPSERT on every eligible report to
// bump `eligible_count` and compute the bonus on 10-report thresholds; the
// `bonuses_credited` counter caps at REPORT_BONUS_DAILY_CAP.
//
// Every mutating operation must run inside the same transaction as the
// `token_balance` credit, so the daily counter and the sats payout never
// diverge. The service layer orchestrates that transaction; this repo only
// exposes the primitives.
// (pg async port, Phase 12B)
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export interface ReportBonusRow {
  reporter_hash: string;
  utc_day: string;
  eligible_count: number;
  bonuses_credited: number;
  total_sats_credited: number;
  last_credit_at: number | null;
}

export class ReportBonusRepository {
  constructor(private db: Queryable) {}

  /** Return the existing row for the key, or null. */
  async findToday(reporterHash: string, utcDay: string): Promise<ReportBonusRow | null> {
    const { rows } = await this.db.query<ReportBonusRow>(
      'SELECT * FROM report_bonus_log WHERE reporter_hash = $1 AND utc_day = $2',
      [reporterHash, utcDay],
    );
    return rows[0] ?? null;
  }

  /** Upsert a row and increment `eligible_count` by 1. Returns the new count.
   *  The caller is responsible for deciding, outside this method, whether the
   *  new count crosses a bonus threshold. */
  async incrementEligibleCount(reporterHash: string, utcDay: string): Promise<number> {
    await this.db.query(
      `
      INSERT INTO report_bonus_log (reporter_hash, utc_day, eligible_count)
      VALUES ($1, $2, 1)
      ON CONFLICT (reporter_hash, utc_day) DO UPDATE
        SET eligible_count = report_bonus_log.eligible_count + 1
      `,
      [reporterHash, utcDay],
    );
    const row = await this.findToday(reporterHash, utcDay);
    return row?.eligible_count ?? 0;
  }

  /** Record that a bonus has been credited. Caller supplies sats paid out.
   *  Atomic with the token_balance UPDATE when wrapped in a transaction. */
  async recordBonusCredit(reporterHash: string, utcDay: string, satsCredited: number, nowUnix: number): Promise<void> {
    await this.db.query(
      `
      UPDATE report_bonus_log
      SET bonuses_credited = bonuses_credited + 1,
          total_sats_credited = total_sats_credited + $1,
          last_credit_at = $2
      WHERE reporter_hash = $3 AND utc_day = $4
      `,
      [satsCredited, nowUnix, reporterHash, utcDay],
    );
  }

  /** Aggregate counters for the monitoring dashboard. Always bounded by the
   *  `since_day` cutoff so we don't scan the whole table. */
  async summarySince(utcDaySince: string): Promise<{ totalBonuses: number; totalSats: number; distinctReporters: number }> {
    const { rows } = await this.db.query<{ totalbonuses: string; totalsats: string; distinctreporters: string }>(
      `
      SELECT
        COALESCE(SUM(bonuses_credited), 0)::text AS totalBonuses,
        COALESCE(SUM(total_sats_credited), 0)::text AS totalSats,
        COUNT(DISTINCT reporter_hash)::text AS distinctReporters
      FROM report_bonus_log
      WHERE utc_day >= $1
      `,
      [utcDaySince],
    );
    const row = rows[0];
    return {
      totalBonuses: Number(row?.totalbonuses ?? 0),
      totalSats: Number(row?.totalsats ?? 0),
      distinctReporters: Number(row?.distinctreporters ?? 0),
    };
  }
}
