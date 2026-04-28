// Phase 6.4 — self-funding loop tracker.
//
// Logge revenue (paid L402 calls) et spending (paid probe runs), expose
// la balance via /api/oracle/budget pour observabilité publique. La
// philosophie : ne pas cacher l'économique de l'oracle. Les agents qui
// dépendent de SatRank doivent pouvoir vérifier que l'oracle est
// durablement financé (revenue >= spending sur un horizon raisonnable),
// sinon le moat de calibration n'a pas de support économique.
//
// Pure aggregation côté service ; la logique de hook (où le revenue/
// spending est généré) vit dans le caller.
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export type RevenueType = 'revenue' | 'spending';

export type RevenueSource =
  | 'fresh_query'
  | 'probe_query'
  | 'verdict_query'
  | 'profile_query'
  | 'paid_probe'
  | 'donation'
  | 'other';

export interface RevenueEvent {
  type: RevenueType;
  source: RevenueSource;
  amount_sats: number;
  observed_at?: number; // default = now
  metadata?: Record<string, unknown>;
  /** Security H1 — quand fourni sur un revenue event, l'INSERT est dedup
   *  via une UNIQUE partial index (oracle_revenue_log_payment_hash_unique).
   *  Une 2e tentative avec le même payment_hash → ON CONFLICT DO NOTHING.
   *  Empêche le double-logging sur race entre 2 first-use HTTP requests
   *  qui passent par onPaidCallSettled avant que token_balance auto-create
   *  finisse. Default null → comportement legacy non-deduppé. */
  payment_hash?: string | null;
}

export interface BudgetWindow {
  /** Fenêtre en secondes. NULL = lifetime. */
  windowSec?: number;
}

export interface BudgetSnapshot {
  window_sec: number | null;
  revenue_sats: number;
  spending_sats: number;
  balance_sats: number;
  /** Ratio revenue/spending. null quand spending = 0 (oracle non
   *  encore actif côté paid probe). */
  coverage_ratio: number | null;
  n_revenue_events: number;
  n_spending_events: number;
}

export class OracleBudgetService {
  constructor(private readonly db: Queryable) {}

  /** Logger un événement revenue ou spending. Security H1 — dedup partial
   *  unique index sur payment_hash empêche double revenue logging quand
   *  le même first-use payment_hash arrive 2× via race onPaidCallSettled. */
  async log(event: RevenueEvent): Promise<void> {
    const observedAt = event.observed_at ?? Math.floor(Date.now() / 1000);
    // Security H1 — `ON CONFLICT DO NOTHING` (sans target) déclenche sur
    // n'importe quel unique conflict. L'index partial
    // idx_oracle_revenue_log_payment_hash_unique couvre seulement
    // type='revenue' AND payment_hash IS NOT NULL : effet → dedup
    // automatique pour les revenues paid, libre pour spending et donations.
    await this.db.query(
      `INSERT INTO oracle_revenue_log (type, source, amount_sats, observed_at, metadata, payment_hash)
       VALUES ($1::text, $2::text, $3::bigint, $4::bigint, $5::jsonb, $6)
       ON CONFLICT DO NOTHING`,
      [
        event.type,
        event.source,
        event.amount_sats,
        observedAt,
        event.metadata ? JSON.stringify(event.metadata) : null,
        event.payment_hash ?? null,
      ],
    );
  }

  /** Convenience pour logger une revenue (montant positif assumé).
   *  paymentHash optional → dedup activé quand fourni (anti-race H1). */
  async logRevenue(
    source: RevenueSource,
    amountSats: number,
    metadata?: Record<string, unknown>,
    paymentHash?: string,
  ): Promise<void> {
    if (amountSats <= 0) return; // no-op pour les calls free
    await this.log({
      type: 'revenue',
      source,
      amount_sats: amountSats,
      metadata,
      payment_hash: paymentHash ?? null,
    });
  }

  /** Convenience pour logger une spending (montant positif). */
  async logSpending(source: RevenueSource, amountSats: number, metadata?: Record<string, unknown>): Promise<void> {
    if (amountSats <= 0) return;
    await this.log({ type: 'spending', source, amount_sats: amountSats, metadata });
  }

  /** Snapshot du budget sur une fenêtre. Retourne lifetime si windowSec
   *  absent. */
  async getBudget(opts: BudgetWindow = {}): Promise<BudgetSnapshot> {
    const params: unknown[] = [];
    let whereClause = '';
    if (opts.windowSec) {
      const cutoff = Math.floor(Date.now() / 1000) - opts.windowSec;
      whereClause = 'WHERE observed_at >= $1::bigint';
      params.push(cutoff);
    }
    const { rows } = await this.db.query<{
      type: string;
      total: string;
      n_events: string;
    }>(
      `SELECT type, SUM(amount_sats)::text AS total, COUNT(*)::text AS n_events
         FROM oracle_revenue_log
         ${whereClause}
        GROUP BY type`,
      params,
    );

    let revenue = 0;
    let spending = 0;
    let nRev = 0;
    let nSpend = 0;
    for (const r of rows) {
      const total = Number(r.total);
      const n = Number(r.n_events);
      if (r.type === 'revenue') {
        revenue = total;
        nRev = n;
      } else if (r.type === 'spending') {
        spending = total;
        nSpend = n;
      }
    }
    return {
      window_sec: opts.windowSec ?? null,
      revenue_sats: revenue,
      spending_sats: spending,
      balance_sats: revenue - spending,
      coverage_ratio: spending > 0 ? revenue / spending : null,
      n_revenue_events: nRev,
      n_spending_events: nSpend,
    };
  }

  /** Snapshots multi-fenêtres pour l'endpoint /api/oracle/budget. */
  async getBudgetMultiWindow(): Promise<{
    lifetime: BudgetSnapshot;
    last_30d: BudgetSnapshot;
    last_7d: BudgetSnapshot;
  }> {
    const [lifetime, last30d, last7d] = await Promise.all([
      this.getBudget(),
      this.getBudget({ windowSec: 30 * 86400 }),
      this.getBudget({ windowSec: 7 * 86400 }),
    ]);
    return { lifetime, last_30d: last30d, last_7d: last7d };
  }
}
