#!/usr/bin/env tsx
// Phase 7 — C9 : bootstrap des operators depuis les données pré-existantes.
//
// Contexte : v31 a introduit `transactions.operator_id = sha256hex(node_pubkey)`
// comme un proto-operator mono-node. v37 instaure la vraie table `operators`.
// Ce script réconcilie : pour chaque proto-operator observé (distinct operator_id
// dans transactions), on crée un entry dans `operators` en status='pending' et
// on rattache les ressources connues (node via agents, endpoint via service_endpoints).
//
// Aucune identité cryptographique n'est inférée — l'opérateur reste pending tant
// qu'il ne prouve pas lui-même 2/3 identités via POST /api/operator/register ou
// un event kind 30385. Cette étape crée uniquement le *container* pour que le
// ranking bayésien puisse déjà agréger l'évidence multi-ressources d'un même
// nœud proto-operator.
//
// Idempotent : upsertOperator + claim* utilisent ON CONFLICT DO NOTHING. Le script
// peut tourner plusieurs fois sans effets secondaires.
//
// Dry-run supporté : `--dry-run` compte ce qui *serait* créé sans écrire
// (BEGIN/ROLLBACK côté pg — tout le travail est fait, puis annulé).
//
// Phase 12B : porté vers pg async. La "transaction unique qui throw un sentinel
// error pour rollback" du port SQLite est remplacée par un ROLLBACK explicite
// dans la branche dry-run.

import type { Pool, PoolClient } from 'pg';
import { getCrawlerPool, closePools } from '../database/connection';
import { runMigrations } from '../database/migrations';
import {
  OperatorRepository,
  OperatorIdentityRepository,
  OperatorOwnershipRepository,
} from '../repositories/operatorRepository';
import { OperatorService } from '../services/operatorService';
import {
  EndpointStreamingPosteriorRepository,
  NodeStreamingPosteriorRepository,
  ServiceStreamingPosteriorRepository,
} from '../repositories/streamingPosteriorRepository';
import { endpointHash } from '../utils/urlCanonical';
import { logger } from '../logger';

export interface InferenceSummary {
  protoOperatorsScanned: number;
  operatorsCreated: number;
  operatorsAlreadyExisting: number;
  nodeOwnershipsClaimed: number;
  endpointOwnershipsClaimed: number;
  agentsLinked: number;
  serviceEndpointsLinked: number;
}

export interface InferenceOptions {
  dryRun?: boolean;
  /** Timestamp d'ingestion (par défaut now()). Exposé pour tests. */
  now?: number;
}

interface ProtoOperatorRow {
  operator_id: string;
  min_ts: number;
  max_ts: number;
  tx_count: number;
}

/** Scan les proto-operators observés dans transactions et crée les entries
 *  dans la nouvelle abstraction. Retourne un summary détaillé ; logue
 *  chaque étape via pino pour audit. */
export async function inferOperatorsFromExistingData(
  pool: Pool,
  options: InferenceOptions = {},
): Promise<InferenceSummary> {
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? Math.floor(Date.now() / 1000);

  const summary: InferenceSummary = {
    protoOperatorsScanned: 0,
    operatorsCreated: 0,
    operatorsAlreadyExisting: 0,
    nodeOwnershipsClaimed: 0,
    endpointOwnershipsClaimed: 0,
    agentsLinked: 0,
    serviceEndpointsLinked: 0,
  };

  // Étape 1 : collecter les proto-operators (read-only, hors transaction).
  //   - operator_id = sha256hex(node_pubkey) hérité de v31
  //   - first/last activity dérivés du min/max timestamp des transactions
  //   - tx_count pour diagnostic
  const { rows: protoRowsRaw } = await pool.query<{
    operator_id: string;
    min_ts: string;
    max_ts: string;
    tx_count: string;
  }>(
    `SELECT operator_id, MIN(timestamp)::text AS min_ts, MAX(timestamp)::text AS max_ts,
            COUNT(*)::text AS tx_count
       FROM transactions
      WHERE operator_id IS NOT NULL
      GROUP BY operator_id`,
  );
  const protoRows: ProtoOperatorRow[] = protoRowsRaw.map((r) => ({
    operator_id: r.operator_id,
    min_ts: Number(r.min_ts),
    max_ts: Number(r.max_ts),
    tx_count: Number(r.tx_count),
  }));

  summary.protoOperatorsScanned = protoRows.length;

  if (summary.protoOperatorsScanned === 0) {
    logger.info('inferOperators: no proto-operators found in transactions');
    return summary;
  }

  logger.info(
    { protoOperators: summary.protoOperatorsScanned, dryRun },
    'inferOperators: starting reconciliation',
  );

  // Tout le travail se fait dans une transaction unique : soit on commit tout
  // (run nominal), soit on rollback tout (dry-run).
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');

    // Repositories et services bindés au client transactionnel.
    const operators = new OperatorRepository(client);
    const identities = new OperatorIdentityRepository(client);
    const ownerships = new OperatorOwnershipRepository(client);
    const endpointPosteriors = new EndpointStreamingPosteriorRepository(client);
    const nodePosteriors = new NodeStreamingPosteriorRepository(client);
    const servicePosteriors = new ServiceStreamingPosteriorRepository(client);
    const service = new OperatorService(
      operators,
      identities,
      ownerships,
      endpointPosteriors,
      nodePosteriors,
      servicePosteriors,
    );

    for (const row of protoRows) {
      const operatorId = row.operator_id;
      const firstSeen = Math.min(row.min_ts, now);
      // Bornage cohérent : last_activity reflète la dernière tx observée dans
      // l'existant, pas l'instant du script. Ça préserve le signal "recency"
      // pour le tri de GET /api/operators après bootstrap.
      const maxActivity = Math.min(row.max_ts, now);

      // Création de l'operator (ON CONFLICT DO NOTHING).
      const existed = (await operators.findById(operatorId)) !== null;
      if (existed) {
        summary.operatorsAlreadyExisting += 1;
      } else {
        await service.upsertOperator(operatorId, firstSeen);
        summary.operatorsCreated += 1;
      }

      // Rattachement du node : operator_id est sha256hex(node_pubkey). On cherche
      // le pubkey LN littéral dans agents et on claim l'ownership.
      const agentRes = await client.query<{ public_key: string | null; public_key_hash: string }>(
        'SELECT public_key, public_key_hash FROM agents WHERE public_key_hash = $1',
        [operatorId],
      );
      const agent = agentRes.rows[0];
      if (agent && typeof agent.public_key === 'string' && /^(02|03)[0-9a-f]{64}$/i.test(agent.public_key)) {
        await service.claimOwnership(operatorId, 'node', agent.public_key.toLowerCase(), maxActivity);
        summary.nodeOwnershipsClaimed += 1;

        const linkRes = await client.query(
          `UPDATE agents SET operator_id = $1
             WHERE public_key_hash = $2
               AND (operator_id IS NULL OR operator_id = $3)`,
          [operatorId, agent.public_key_hash, operatorId],
        );
        if ((linkRes.rowCount ?? 0) > 0) summary.agentsLinked += 1;
      }

      // Rattachement des endpoints : service_endpoints.agent_hash = operator_id.
      // Claim un par URL distincte via endpointHash(canonical_url).
      const seRes = await client.query<{ id: number; url: string }>(
        'SELECT id, url FROM service_endpoints WHERE agent_hash = $1',
        [operatorId],
      );
      const seRows = seRes.rows;
      const seenHashes = new Set<string>();
      for (const se of seRows) {
        try {
          const hash = endpointHash(se.url);
          if (seenHashes.has(hash)) continue;
          seenHashes.add(hash);
          await service.claimOwnership(operatorId, 'endpoint', hash, maxActivity);
          summary.endpointOwnershipsClaimed += 1;
        } catch (err: unknown) {
          logger.debug(
            { operatorId, url: se.url, error: err instanceof Error ? err.message : String(err) },
            'inferOperators: endpointHash failed for URL, skipping',
          );
        }
      }
      if (seRows.length > 0) {
        const linkRes = await client.query(
          `UPDATE service_endpoints SET operator_id = $1
             WHERE agent_hash = $2
               AND (operator_id IS NULL OR operator_id = $3)`,
          [operatorId, operatorId, operatorId],
        );
        summary.serviceEndpointsLinked += linkRes.rowCount ?? 0;
      }

      // Final touch : figer last_activity au max des tx observées (les
      // claim* ci-dessus ont pu laisser last_activity à une tx intermédiaire
      // selon l'ordre de listing).
      await operators.touch(operatorId, maxActivity);
    }

    if (dryRun) {
      await client.query('ROLLBACK');
      logger.info(
        { ...summary, dryRun: true },
        'inferOperators: dry-run complete — changes rolled back',
      );
      return summary;
    }

    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // best-effort, already failing
    }
    throw err;
  } finally {
    client.release();
  }

  logger.info(
    { ...summary },
    'inferOperators: reconciliation complete',
  );
  return summary;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  logger.info({ dryRun }, 'inferOperatorsFromExistingData: CLI invocation');

  const pool = getCrawlerPool();
  await runMigrations(pool);
  try {
    const summary = await inferOperatorsFromExistingData(pool, { dryRun });
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } finally {
    await closePools();
  }
}

// Guard compatible tsx + dist/ CJS (pattern aligné sur les autres scripts de la
// suite — cf. compareLegacyVsBayesian.ts, rebuildStreamingPosteriors.ts).
const isMain =
  typeof require !== 'undefined' &&
  typeof module !== 'undefined' &&
  require.main === module;

if (isMain) {
  main().catch(async (err: unknown) => {
    logger.error({ err }, 'inferOperatorsFromExistingData failed');
    await closePools();
    process.exit(1);
  });
}
