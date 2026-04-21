#!/usr/bin/env tsx
// Phase 3 C12 — cron retention pour les tables Bayesian streaming + buckets.
//
// Usage :
//   npx tsx src/scripts/pruneBayesianRetention.ts
//   npm run prune:bayesian             # alias
//
// Env vars :
//   BUCKET_RETENTION_DAYS_OVERRIDE   (défaut 30 — défini dans bayesianConfig)
//   STREAMING_STALE_DAYS_OVERRIDE    (défaut 90 — décroissance exp(-90/7) ≈ 2.6e-6)
//
// Ce que le script fait :
//   1. Prune les 5 tables `*_daily_buckets` des rows avec day < (today - 30d).
//      Les buckets sont display-only (recent_activity 24h/7d/30d + risk_profile)
//      et ne servent jamais au-delà de leur fenêtre — rétention stricte.
//   2. Prune les 5 tables `*_streaming_posteriors` des rows non mises à jour
//      depuis plus de 90 jours. Le posterior d'une row dormante a déjà décayé
//      vers le prior flat (exp(-90/7) ≈ 0) — garder la row ne contribue plus
//      d'information au verdict mais coûte en espace + bloat index.
//
// Idempotence : relancer produit zéro changement si tout est déjà propre.
//
// Safety :
//   - transaction SQL par table (atomique)
//   - logs jamais truncated (on veut savoir combien de rows ont été purgées)
//   - exit 0 en succès, 1 en erreur. Si une table échoue les autres continuent
//     (goal is best-effort propreté, pas all-or-nothing).

import type { Pool } from 'pg';
import { getCrawlerPool, closePools } from '../database/connection';
import { runMigrations } from '../database/migrations';
import {
  EndpointDailyBucketsRepository,
  NodeDailyBucketsRepository,
  ServiceDailyBucketsRepository,
  OperatorDailyBucketsRepository,
  RouteDailyBucketsRepository,
  dayKeyUTC,
} from '../repositories/dailyBucketsRepository';
import {
  EndpointStreamingPosteriorRepository,
  NodeStreamingPosteriorRepository,
  ServiceStreamingPosteriorRepository,
  OperatorStreamingPosteriorRepository,
  RouteStreamingPosteriorRepository,
} from '../repositories/streamingPosteriorRepository';
import { BUCKET_RETENTION_DAYS } from '../config/bayesianConfig';

/** Seuil par défaut pour purger les rows streaming dormantes. Rationale :
 *  à τ=7d, exp(-90/7) ≈ 2.6e-6 — l'évidence excédentaire a totalement fondu.
 *  La row est sémantiquement équivalente au prior flat, donc supprimer est
 *  safe (le verdict retombera sur DEFAULT_PRIOR_ALPHA/BETA naturellement). */
export const DEFAULT_STREAMING_STALE_DAYS = 90;

export interface PruneOptions {
  pool: Pool;
  /** Override le seuil de rétention buckets (défaut BUCKET_RETENTION_DAYS). */
  bucketRetentionDays?: number;
  /** Override le seuil streaming dormant (défaut 90). */
  streamingStaleDays?: number;
  /** Référence temporelle — injectable pour tests reproductibles. */
  nowSec?: number;
}

export interface PruneResult {
  buckets: {
    endpoint: number;
    service: number;
    operator: number;
    node: number;
    route: number;
    total: number;
  };
  streaming: {
    endpoint: number;
    service: number;
    operator: number;
    node: number;
    route: number;
    total: number;
  };
  bucketCutoffDay: string;
  streamingCutoffTs: number;
  errors: number;
}

export async function runPrune(opts: PruneOptions): Promise<PruneResult> {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const bucketDays = opts.bucketRetentionDays ?? BUCKET_RETENTION_DAYS;
  const streamingDays = opts.streamingStaleDays ?? DEFAULT_STREAMING_STALE_DAYS;

  const bucketCutoffDay = dayKeyUTC(now - bucketDays * 86400);
  const streamingCutoffTs = now - streamingDays * 86400;

  const result: PruneResult = {
    buckets: { endpoint: 0, service: 0, operator: 0, node: 0, route: 0, total: 0 },
    streaming: { endpoint: 0, service: 0, operator: 0, node: 0, route: 0, total: 0 },
    bucketCutoffDay,
    streamingCutoffTs,
    errors: 0,
  };

  const bucketRepos = {
    endpoint: new EndpointDailyBucketsRepository(opts.pool),
    service: new ServiceDailyBucketsRepository(opts.pool),
    operator: new OperatorDailyBucketsRepository(opts.pool),
    node: new NodeDailyBucketsRepository(opts.pool),
    route: new RouteDailyBucketsRepository(opts.pool),
  };
  for (const [name, repo] of Object.entries(bucketRepos)) {
    try {
      const n = await repo.pruneOlderThan(bucketCutoffDay);
      result.buckets[name as keyof typeof bucketRepos] = n;
      result.buckets.total += n;
    } catch (err) {
      result.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[prune-bayesian] bucket ${name} failed: ${msg}\n`);
    }
  }

  const streamingRepos = {
    endpoint: new EndpointStreamingPosteriorRepository(opts.pool),
    service: new ServiceStreamingPosteriorRepository(opts.pool),
    operator: new OperatorStreamingPosteriorRepository(opts.pool),
    node: new NodeStreamingPosteriorRepository(opts.pool),
    route: new RouteStreamingPosteriorRepository(opts.pool),
  };
  for (const [name, repo] of Object.entries(streamingRepos)) {
    try {
      const n = await repo.pruneStale(streamingCutoffTs);
      result.streaming[name as keyof typeof streamingRepos] = n;
      result.streaming.total += n;
    } catch (err) {
      result.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[prune-bayesian] streaming ${name} failed: ${msg}\n`);
    }
  }

  return result;
}

// --- CLI entry point ---
const isMain =
  typeof require !== 'undefined' &&
  typeof module !== 'undefined' &&
  require.main === module;

async function main(): Promise<void> {
  const bucketOverride = process.env.BUCKET_RETENTION_DAYS_OVERRIDE;
  const streamingOverride = process.env.STREAMING_STALE_DAYS_OVERRIDE;
  const bucketRetentionDays = bucketOverride ? Number(bucketOverride) : undefined;
  const streamingStaleDays = streamingOverride ? Number(streamingOverride) : undefined;

  const pool = getCrawlerPool();
  await runMigrations(pool);

  const result = await runPrune({ pool, bucketRetentionDays, streamingStaleDays });
  const line = [
    `cutoff_day=${result.bucketCutoffDay}`,
    `buckets_total=${result.buckets.total}`,
    `streaming_total=${result.streaming.total}`,
    `errors=${result.errors}`,
  ].join(' ');
  process.stdout.write(`[prune-bayesian] ${line}\n`);
  await closePools();
  process.exit(result.errors === 0 ? 0 : 1);
}

if (isMain) {
  main().catch(async (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[prune-bayesian] FATAL: ${msg}\n`);
    await closePools();
    process.exit(1);
  });
}
