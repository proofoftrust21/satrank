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
import type Database from 'better-sqlite3';

export interface ReportBonusRow {
  reporter_hash: string;
  utc_day: string;
  eligible_count: number;
  bonuses_credited: number;
  total_sats_credited: number;
  last_credit_at: number | null;
}

export class ReportBonusRepository {
  constructor(private db: Database.Database) {}

  /** Return the existing row for the key, or null. */
  findToday(reporterHash: string, utcDay: string): ReportBonusRow | null {
    const row = this.db.prepare(
      'SELECT * FROM report_bonus_log WHERE reporter_hash = ? AND utc_day = ?',
    ).get(reporterHash, utcDay) as ReportBonusRow | undefined;
    return row ?? null;
  }

  /** Upsert a row and increment `eligible_count` by 1. Returns the new count.
   *  The caller is responsible for deciding, outside this method, whether the
   *  new count crosses a bonus threshold. */
  incrementEligibleCount(reporterHash: string, utcDay: string): number {
    this.db.prepare(`
      INSERT INTO report_bonus_log (reporter_hash, utc_day, eligible_count)
      VALUES (?, ?, 1)
      ON CONFLICT(reporter_hash, utc_day) DO UPDATE
        SET eligible_count = eligible_count + 1
    `).run(reporterHash, utcDay);
    const row = this.findToday(reporterHash, utcDay);
    return row?.eligible_count ?? 0;
  }

  /** Record that a bonus has been credited. Caller supplies sats paid out.
   *  Atomic with the token_balance UPDATE when wrapped in a transaction. */
  recordBonusCredit(reporterHash: string, utcDay: string, satsCredited: number, nowUnix: number): void {
    this.db.prepare(`
      UPDATE report_bonus_log
      SET bonuses_credited = bonuses_credited + 1,
          total_sats_credited = total_sats_credited + ?,
          last_credit_at = ?
      WHERE reporter_hash = ? AND utc_day = ?
    `).run(satsCredited, nowUnix, reporterHash, utcDay);
  }

  /** Aggregate counters for the monitoring dashboard. Always bounded by the
   *  `since_day` cutoff so we don't scan the whole table. */
  summarySince(utcDaySince: string): { totalBonuses: number; totalSats: number; distinctReporters: number } {
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(bonuses_credited), 0) AS totalBonuses,
        COALESCE(SUM(total_sats_credited), 0) AS totalSats,
        COUNT(DISTINCT reporter_hash) AS distinctReporters
      FROM report_bonus_log
      WHERE utc_day >= ?
    `).get(utcDaySince) as { totalBonuses: number; totalSats: number; distinctReporters: number };
    return row;
  }
}
