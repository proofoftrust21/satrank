// SatRank V3 — Bayesian scoring.
//
// Beta(α,β) per (endpoint, stage). On every observation:
//   success → α += 1
//   failure → β += 1
// p_success = α / (α+β). 95% credible interval via the inverse-Beta CDF
// approximation due to Wilson (close-form, no special functions).
//
// End-to-end success = ∏ stage_means (assumes stage independence — true
// enough since stages are sequential and distinct failure modes).

import type { PoolClient } from 'pg';
import { pool } from './db.js';
import { config } from './config.js';
import { STAGES, type Stage, type Posterior, type EndpointScore, type Observation } from './types.js';

/** Beta(1,1) prior — uniform. Updated to (α+s, β+f) on observations. */
const PRIOR = 1.0;

/** Wilson interval for the Beta posterior's mean.
 *  p̂ = α/(α+β), n_eff = α+β.
 *  Returns [low, high] with 95% credibility. Closed-form, no GSL needed. */
function ci95(alpha: number, beta: number): [number, number] {
  const n = alpha + beta;
  if (n <= 0) return [0, 1];
  const p = alpha / n;
  const z = 1.959963984540054; // 97.5th percentile of standard normal
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function posteriorOf(alpha: number, beta: number): Posterior {
  const n_eff = alpha + beta;
  const mean = n_eff > 0 ? alpha / n_eff : 0;
  return {
    alpha,
    beta,
    mean,
    ci95: ci95(alpha, beta),
    n: Math.max(0, Math.round(alpha + beta - 2 * PRIOR)),
  };
}

/** Update the Beta posterior in DB for one (url_hash, stage) on a single observation.
 *  Idempotent at the row level (UPSERT). Caller passes a transaction client. */
async function updateStage(
  client: PoolClient,
  url_hash: string,
  stage: Stage,
  success: boolean,
  observed_at: number,
): Promise<void> {
  await client.query(
    `INSERT INTO endpoint_posteriors (url_hash, stage, alpha, beta, n_obs, updated_at)
     VALUES ($1, $2, $3, $4, 1, $5)
     ON CONFLICT (url_hash, stage) DO UPDATE SET
       alpha = endpoint_posteriors.alpha + EXCLUDED.alpha - $6,
       beta  = endpoint_posteriors.beta  + EXCLUDED.beta  - $6,
       n_obs = endpoint_posteriors.n_obs + 1,
       updated_at = EXCLUDED.updated_at`,
    [
      url_hash,
      stage,
      PRIOR + (success ? 1 : 0),
      PRIOR + (success ? 0 : 1),
      observed_at,
      PRIOR, // strip the prior on update so we add only the increment
    ],
  );
}

/** Append one observation and update all 5 posteriors atomically. */
export async function ingestObservation(obs: Observation): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO endpoint_observations
        (url_hash, observed_at, challenge_ok, invoice_ok, payment_ok, delivery_ok, quality_ok, latency_ms, http_status, body_sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        obs.url_hash, obs.observed_at,
        obs.challenge_ok, obs.invoice_ok,
        obs.payment_ok, obs.delivery_ok, obs.quality_ok,
        obs.latency_ms, obs.http_status, obs.body_sha256,
      ],
    );
    // Each stage updates only when it's reached. A 401-without-challenge means
    // the endpoint isn't even L402 → only challenge_ok=false is recorded.
    await updateStage(client, obs.url_hash, 'challenge', obs.challenge_ok, obs.observed_at);
    if (obs.challenge_ok) {
      await updateStage(client, obs.url_hash, 'invoice', obs.invoice_ok, obs.observed_at);
    }
    if (obs.invoice_ok && obs.payment_ok !== null) {
      await updateStage(client, obs.url_hash, 'payment', obs.payment_ok, obs.observed_at);
    }
    if (obs.payment_ok && obs.delivery_ok !== null) {
      await updateStage(client, obs.url_hash, 'delivery', obs.delivery_ok, obs.observed_at);
    }
    if (obs.delivery_ok && obs.quality_ok !== null) {
      await updateStage(client, obs.url_hash, 'quality', obs.quality_ok, obs.observed_at);
    }
    await client.query(
      `UPDATE service_endpoints SET last_probe_at = $1 WHERE url_hash = $2`,
      [obs.observed_at, obs.url_hash],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Read all 5 posteriors for an endpoint. Returns Beta(1,1) defaults
 *  for stages with no row yet. */
export async function loadStages(url_hash: string): Promise<Record<Stage, Posterior>> {
  const { rows } = await pool.query<{ stage: Stage; alpha: number; beta: number }>(
    `SELECT stage, alpha, beta FROM endpoint_posteriors WHERE url_hash = $1`,
    [url_hash],
  );
  const map = new Map(rows.map((r) => [r.stage, posteriorOf(Number(r.alpha), Number(r.beta))]));
  const out: Partial<Record<Stage, Posterior>> = {};
  for (const s of STAGES) {
    out[s] = map.get(s) ?? posteriorOf(PRIOR, PRIOR);
  }
  return out as Record<Stage, Posterior>;
}

/** Median latency from the last 50 observations (cheap, accurate enough). */
async function medianLatency(url_hash: string): Promise<number | null> {
  const { rows } = await pool.query<{ latency_ms: number }>(
    `SELECT latency_ms FROM endpoint_observations
       WHERE url_hash = $1 AND latency_ms > 0
       ORDER BY observed_at DESC LIMIT 50`,
    [url_hash],
  );
  if (rows.length === 0) return null;
  const sorted = rows.map((r) => Number(r.latency_ms)).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Compute the full score for one endpoint URL.
 *  Returns null when the endpoint isn't in the catalogue. */
export async function scoreEndpoint(url_hash: string): Promise<EndpointScore | null> {
  const { rows } = await pool.query<{
    url: string; category: string; price_sats: number; last_probe_at: number | null;
  }>(
    `SELECT url, category, price_sats, last_probe_at
       FROM service_endpoints WHERE url_hash = $1`,
    [url_hash],
  );
  if (rows.length === 0) return null;
  const stages = await loadStages(url_hash);
  const p_e2e = STAGES.reduce((acc, s) => acc * stages[s].mean, 1);
  const n_obs = Math.max(...STAGES.map((s) => stages[s].n));
  const min_n = config.MEANINGFUL_N_OBS_MIN;
  // Sim 3 finding: requiring every stage n ≥ min_n means is_meaningful
  // stays false for endpoints with broken delivery/quality (very common
  // in the wild) — even though we DO know reliably whether the endpoint
  // L402-challenges and how often delivery breaks. The challenge stage
  // is observed on every probe (free or paid), so its n_obs converges
  // fastest. Treat is_meaningful as "we have enough challenge-stage
  // evidence to say something about this endpoint" — p_e2e remains
  // the honest end-to-end product separately.
  const is_meaningful = stages.challenge.n >= min_n;
  return {
    url: rows[0].url,
    url_hash,
    category: rows[0].category,
    stages,
    p_e2e,
    n_obs,
    is_meaningful,
    median_latency_ms: await medianLatency(url_hash),
    last_probe_at: rows[0].last_probe_at !== null ? Number(rows[0].last_probe_at) : null,
    price_sats: Number(rows[0].price_sats),
  };
}

/** Resolve a category into the top-k ranked endpoints.
 *  Filtering: budget cap, latency cap. Sort: by `optimize` axis. */
export interface RankRequest {
  category: string;
  budget_sats?: number;
  max_latency_ms?: number;
  optimize?: 'p_success' | 'latency' | 'cost';
  limit?: number;
}

export async function rank(req: RankRequest): Promise<EndpointScore[]> {
  // Match against the full category_tags array (GIN-indexed) — a service
  // tagged ['video','streaming','content'] surfaces for any of those queries.
  const { rows } = await pool.query<{ url_hash: string }>(
    `SELECT url_hash FROM service_endpoints
       WHERE $1 = ANY(category_tags)
         AND ($2::int IS NULL OR price_sats <= $2)
       LIMIT 200`,
    [req.category, req.budget_sats ?? null],
  );
  const scores = (await Promise.all(rows.map((r) => scoreEndpoint(r.url_hash)))).filter(
    (s): s is EndpointScore => s !== null,
  );
  const filtered = req.max_latency_ms !== undefined
    ? scores.filter((s) => s.median_latency_ms === null || s.median_latency_ms <= req.max_latency_ms!)
    : scores;
  const optimize = req.optimize ?? 'p_success';
  filtered.sort((a, b) => {
    if (optimize === 'p_success') return b.p_e2e - a.p_e2e;
    if (optimize === 'latency')  return (a.median_latency_ms ?? Infinity) - (b.median_latency_ms ?? Infinity);
    if (optimize === 'cost')     return a.price_sats - b.price_sats;
    return 0;
  });
  return filtered.slice(0, req.limit ?? 10);
}
