#!/usr/bin/env tsx
// Phase 3 C11 — rebuild streaming_posteriors + daily_buckets tables depuis
// la table transactions (source de vérité post-migration v31).
//
// Usage :
//   npx tsx src/scripts/rebuildStreamingPosteriors.ts [options]
//
// Options (env-var / CLI) :
//   --truncate         : TRUNCATE les 5 tables streaming + 5 tables buckets avant
//   --dry-run          : compte ce qui serait ingéré, sans écrire
//   --chunk-size=N     : nombre de rows par chunk SQL (défaut 10_000)
//   --from-ts=UNIX     : rebuild seulement les rows avec timestamp >= UNIX
//   --reporter-tier=X  : tier par défaut pour source='report' (low|medium|high|nip98)
//                        défaut 'medium' (weight 0.5). Les tiers originaux ne sont
//                        pas stockés dans transactions — on perd cette granularité
//                        au rebuild (conservative par défaut).
//
// Quand l'utiliser :
//   - après un DROP / restore qui aurait perdu les streaming tables
//   - après une bump de version de schema qui touche le modèle (p. ex. changement
//     de weight_base ou de TAU_SECONDS)
//   - en forensics, pour vérifier qu'un state reconstruit match le live state
//
// Propriété critique — ordre chronologique :
//   Les rows sont streamées ORDER BY timestamp ASC pour reproduire exactement
//   la trajectoire de décroissance live. Si on itérait dans l'ordre `tx_id`
//   (hash-aléatoire), le handler out-of-order du repo compenserait mais ça
//   ajoute du bruit mathématique — autant être strict.
//
// Idempotence :
//   --truncate + rescan complet produit un state déterministe. Sans --truncate,
//   le script *ajoute* à l'état existant — utile pour un replay incrémental
//   depuis un `--from-ts` donné, mais risque de double-compter si lancé
//   deux fois avec les mêmes bornes.
//
// Contrat de sources :
//   - 'probe'  → streaming + buckets (weight 1.0)
//   - 'paid'   → streaming + buckets (weight 2.0)  ← pas de source 'paid' dans
//     transactions aujourd'hui (les paid probes utilisent source='probe' avec
//     une autre route de metering), mais le code est en place pour quand la
//     distinction sera matérialisée.
//   - 'report' → streaming + buckets (weight selon tier défaut, voir --reporter-tier)
//   - 'observer' → buckets only (CHECK constraint SQL sur streaming)
//   - 'intent' → skip complet (contrat Phase 3 : intents = token_query_log, pas d'obs)
//   - source IS NULL → skip (legacy pré-v31, sans enrichment)
//
// Exit codes : 0 = success, 1 = erreur fatale.

import type { Pool } from 'pg';
import { getCrawlerPool, closePools } from '../database/connection';
import { runMigrations } from '../database/migrations';
import { withTransaction } from '../database/transaction';
import {
  BayesianScoringService,
  type StreamingIngestionInput,
} from '../services/bayesianScoringService';
import {
  EndpointStreamingPosteriorRepository,
  ServiceStreamingPosteriorRepository,
  OperatorStreamingPosteriorRepository,
  NodeStreamingPosteriorRepository,
  RouteStreamingPosteriorRepository,
} from '../repositories/streamingPosteriorRepository';
import {
  EndpointDailyBucketsRepository,
  ServiceDailyBucketsRepository,
  OperatorDailyBucketsRepository,
  NodeDailyBucketsRepository,
  RouteDailyBucketsRepository,
} from '../repositories/dailyBucketsRepository';
import type { ReportTier } from '../services/bayesianScoringService';

/** Tables à réinitialiser quand --truncate est passé. Listées dans cet ordre
 *  pour préserver l'idempotence même si une row orpheline existe. */
const STREAMING_TABLES = [
  'endpoint_streaming_posteriors',
  'node_streaming_posteriors',
  'service_streaming_posteriors',
  'operator_streaming_posteriors',
  'route_streaming_posteriors',
];
const BUCKET_TABLES = [
  'endpoint_daily_buckets',
  'node_daily_buckets',
  'service_daily_buckets',
  'operator_daily_buckets',
  'route_daily_buckets',
];

export interface RebuildOptions {
  pool: Pool;
  truncate?: boolean;
  dryRun?: boolean;
  chunkSize?: number;
  fromTs?: number;
  /** Tier par défaut pour les rows source='report' (défaut 'medium'). */
  reporterTier?: ReportTier;
}

export interface RebuildResult {
  scanned: number;
  ingested: number;
  skippedNoSource: number;
  skippedIntent: number;
  perSource: {
    probe: number;
    report: number;
    paid: number;
    observer: number;
    intent: number;
  };
  errors: number;
}

interface TxRow {
  tx_id: string;
  timestamp: number;
  status: 'verified' | 'failed';
  endpoint_hash: string | null;
  operator_id: string | null;
  source: 'probe' | 'report' | 'paid' | 'observer' | 'intent' | null;
}

/** Point d'entrée programmatique — utilisé par les tests et la CLI. */
export async function runRebuild(options: RebuildOptions): Promise<RebuildResult> {
  const chunkSize = options.chunkSize ?? 10_000;
  const reporterTier: ReportTier = options.reporterTier ?? 'medium';
  const fromTs = options.fromTs ?? 0;
  const dryRun = options.dryRun ?? false;

  const result: RebuildResult = {
    scanned: 0,
    ingested: 0,
    skippedNoSource: 0,
    skippedIntent: 0,
    perSource: { probe: 0, report: 0, paid: 0, observer: 0, intent: 0 },
    errors: 0,
  };

  if (options.truncate && !dryRun) {
    for (const table of [...STREAMING_TABLES, ...BUCKET_TABLES]) {
      await options.pool.query(`DELETE FROM ${table}`);
    }
  }

  // Paginate par timestamp ASC pour reproduire la trajectoire chronologique.
  // Cursor tuple (timestamp, tx_id) pour stabilité face à des rows au même ts.
  let cursorTs = fromTs;
  let cursorTxId = '';

  while (true) {
    const { rows } = await options.pool.query<TxRow>(
      `SELECT tx_id, timestamp, status, endpoint_hash, operator_id, source
         FROM transactions
        WHERE (timestamp > $1 OR (timestamp = $2 AND tx_id > $3))
          AND source IS NOT NULL
        ORDER BY timestamp ASC, tx_id ASC
        LIMIT $4`,
      [cursorTs, cursorTs, cursorTxId, chunkSize],
    );
    if (rows.length === 0) break;

    // Une transaction par chunk — préserve l'atomicité historique du
    // `db.transaction(fn)` better-sqlite3 tout en gardant la progression
    // du cursor en mémoire du process (pas dans la DB).
    await withTransaction(options.pool, async (client) => {
      const bayesian = new BayesianScoringService(
        new EndpointStreamingPosteriorRepository(client),
        new ServiceStreamingPosteriorRepository(client),
        new OperatorStreamingPosteriorRepository(client),
        new NodeStreamingPosteriorRepository(client),
        new RouteStreamingPosteriorRepository(client),
        new EndpointDailyBucketsRepository(client),
        new ServiceDailyBucketsRepository(client),
        new OperatorDailyBucketsRepository(client),
        new NodeDailyBucketsRepository(client),
        new RouteDailyBucketsRepository(client),
      );

      for (const row of rows) {
        result.scanned++;
        cursorTs = row.timestamp;
        cursorTxId = row.tx_id;

        if (!row.source) {
          result.skippedNoSource++;
          continue;
        }
        if (row.source === 'intent') {
          result.skippedIntent++;
          result.perSource.intent++;
          continue;
        }

        result.perSource[row.source]++;

        if (dryRun) {
          result.ingested++;
          continue;
        }

        try {
          const input: StreamingIngestionInput = {
            success: row.status === 'verified',
            timestamp: row.timestamp,
            source: row.source,
            endpointHash: row.endpoint_hash,
            operatorId: row.operator_id,
            nodePubkey: row.operator_id,
            tier: row.source === 'report' ? reporterTier : undefined,
          };
          await bayesian.ingestStreaming(input);
          result.ingested++;
        } catch (err) {
          result.errors++;
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[rebuild] tx=${row.tx_id.slice(0, 12)} source=${row.source} error=${msg}\n`,
          );
        }
      }
    });
  }

  return result;
}

// --- CLI entry point ---
const isMain =
  typeof require !== 'undefined' &&
  typeof module !== 'undefined' &&
  require.main === module;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string) => argv.includes(name);
  const value = (name: string): string | undefined => {
    const match = argv.find((a) => a.startsWith(`${name}=`));
    return match ? match.slice(name.length + 1) : undefined;
  };

  const truncate = flag('--truncate');
  const dryRun = flag('--dry-run');
  const chunkSize = Number(value('--chunk-size') ?? '10000');
  const fromTs = Number(value('--from-ts') ?? '0');
  const reporterTierRaw = value('--reporter-tier');
  const reporterTier: ReportTier =
    reporterTierRaw === 'low' || reporterTierRaw === 'medium' ||
    reporterTierRaw === 'high' || reporterTierRaw === 'nip98'
      ? reporterTierRaw
      : 'medium';

  const pool = getCrawlerPool();
  await runMigrations(pool);

  const result = await runRebuild({ pool, truncate, dryRun, chunkSize, fromTs, reporterTier });
  const line = [
    `scanned=${result.scanned}`,
    `ingested=${result.ingested}`,
    `errors=${result.errors}`,
    `probe=${result.perSource.probe}`,
    `report=${result.perSource.report}`,
    `paid=${result.perSource.paid}`,
    `observer=${result.perSource.observer}`,
    `intent_skipped=${result.skippedIntent}`,
    `no_source_skipped=${result.skippedNoSource}`,
  ].join(' ');
  process.stdout.write(
    `[rebuild-streaming] ${dryRun ? 'DRY-RUN ' : ''}${line}\n`,
  );
  await closePools();
  process.exit(result.errors === 0 ? 0 : 1);
}

if (isMain) {
  main().catch(async (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[rebuild-streaming] FATAL: ${msg}\n`);
    await closePools();
    process.exit(1);
  });
}
