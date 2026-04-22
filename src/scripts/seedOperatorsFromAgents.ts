#!/usr/bin/env tsx
// Phase 13C — seedOperatorsFromAgents : fallback Option A.
//
// Contexte : le script legacy inferOperatorsFromExistingData dérive les operators
// depuis transactions.operator_id, mais le cut-over Phase 12B a laissé ces colonnes
// NULL (backfillTransactionsV31 jamais rejoué post-migration). Résultat : 0
// proto-operators trouvés → aucun operator créé en prod.
//
// Ce script contourne le blocage en sourçant directement depuis la table agents :
// pour chaque agent ayant un public_key LN valide (02/03 + 64 hex), il crée un
// operator pending (id = public_key_hash) et claim l'ownership du node. Les
// service_endpoints observés avec le même agent_hash sont aussi claim (utile pour
// les 11 distinct agents repeuplés en Phase B/C).
//
// Idempotent : upsertOperator + claimOwnership utilisent ON CONFLICT DO NOTHING.
// Dry-run supporté (BEGIN/ROLLBACK), pattern aligné sur inferOperatorsFromExistingData.
//
// Ce script ne crée AUCUNE identité cryptographique. Les operators restent
// pending jusqu'à preuve 2/3 (kind 30385 ou POST /api/operator/register).

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

export interface SeedSummary {
  agentsScanned: number;
  agentsSkipped: number;
  operatorsCreated: number;
  operatorsAlreadyExisting: number;
  nodeOwnershipsClaimed: number;
  endpointOwnershipsClaimed: number;
  agentsLinked: number;
  serviceEndpointsLinked: number;
}

export interface SeedOptions {
  dryRun?: boolean;
  now?: number;
}

interface AgentRow {
  public_key: string | null;
  public_key_hash: string;
  first_seen: number | null;
  last_seen: number | null;
}

const PUBKEY_RE = /^(02|03)[0-9a-f]{64}$/i;

export async function seedOperatorsFromAgents(
  pool: Pool,
  options: SeedOptions = {},
): Promise<SeedSummary> {
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? Math.floor(Date.now() / 1000);

  const summary: SeedSummary = {
    agentsScanned: 0,
    agentsSkipped: 0,
    operatorsCreated: 0,
    operatorsAlreadyExisting: 0,
    nodeOwnershipsClaimed: 0,
    endpointOwnershipsClaimed: 0,
    agentsLinked: 0,
    serviceEndpointsLinked: 0,
  };

  const { rows: agentRowsRaw } = await pool.query<{
    public_key: string | null;
    public_key_hash: string;
    first_seen: string | null;
    last_seen: string | null;
  }>(
    `SELECT public_key, public_key_hash, first_seen::text AS first_seen, last_seen::text AS last_seen
       FROM agents
      ORDER BY public_key_hash`,
  );
  const agentRows: AgentRow[] = agentRowsRaw.map((r) => ({
    public_key: r.public_key,
    public_key_hash: r.public_key_hash,
    first_seen: r.first_seen !== null ? Number(r.first_seen) : null,
    last_seen: r.last_seen !== null ? Number(r.last_seen) : null,
  }));

  summary.agentsScanned = agentRows.length;

  if (summary.agentsScanned === 0) {
    logger.info('seedOperatorsFromAgents: no agents found');
    return summary;
  }

  logger.info(
    { agents: summary.agentsScanned, dryRun },
    'seedOperatorsFromAgents: starting seeding',
  );

  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');

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

    for (const agent of agentRows) {
      if (typeof agent.public_key !== 'string' || !PUBKEY_RE.test(agent.public_key)) {
        summary.agentsSkipped += 1;
        continue;
      }
      const pubkey = agent.public_key.toLowerCase();
      const operatorId = agent.public_key_hash;
      const firstSeen = Math.min(agent.first_seen ?? now, now);
      const lastActivity = Math.min(agent.last_seen ?? now, now);

      const existed = (await operators.findById(operatorId)) !== null;
      if (existed) {
        summary.operatorsAlreadyExisting += 1;
      } else {
        await service.upsertOperator(operatorId, firstSeen);
        summary.operatorsCreated += 1;
      }

      await service.claimOwnership(operatorId, 'node', pubkey, lastActivity);
      summary.nodeOwnershipsClaimed += 1;

      const linkRes = await client.query(
        `UPDATE agents SET operator_id = $1
           WHERE public_key_hash = $2
             AND (operator_id IS NULL OR operator_id = $3)`,
        [operatorId, operatorId, operatorId],
      );
      if ((linkRes.rowCount ?? 0) > 0) summary.agentsLinked += 1;

      const seRes = await client.query<{ id: number; url: string }>(
        'SELECT id, url FROM service_endpoints WHERE agent_hash = $1',
        [operatorId],
      );
      const seenHashes = new Set<string>();
      for (const se of seRes.rows) {
        try {
          const hash = endpointHash(se.url);
          if (seenHashes.has(hash)) continue;
          seenHashes.add(hash);
          await service.claimOwnership(operatorId, 'endpoint', hash, lastActivity);
          summary.endpointOwnershipsClaimed += 1;
        } catch (err: unknown) {
          logger.debug(
            { operatorId, url: se.url, error: err instanceof Error ? err.message : String(err) },
            'seedOperatorsFromAgents: endpointHash failed, skipping',
          );
        }
      }
      if (seRes.rows.length > 0) {
        const seLink = await client.query(
          `UPDATE service_endpoints SET operator_id = $1
             WHERE agent_hash = $2
               AND (operator_id IS NULL OR operator_id = $3)`,
          [operatorId, operatorId, operatorId],
        );
        summary.serviceEndpointsLinked += seLink.rowCount ?? 0;
      }

      await operators.touch(operatorId, lastActivity);
    }

    if (dryRun) {
      await client.query('ROLLBACK');
      logger.info(
        { ...summary, dryRun: true },
        'seedOperatorsFromAgents: dry-run complete — changes rolled back',
      );
      return summary;
    }

    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // best-effort
    }
    throw err;
  } finally {
    client.release();
  }

  logger.info({ ...summary }, 'seedOperatorsFromAgents: seeding complete');
  return summary;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  logger.info({ dryRun }, 'seedOperatorsFromAgents: CLI invocation');

  const pool = getCrawlerPool();
  await runMigrations(pool);
  try {
    const summary = await seedOperatorsFromAgents(pool, { dryRun });
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } finally {
    await closePools();
  }
}

const isMain =
  typeof require !== 'undefined' &&
  typeof module !== 'undefined' &&
  require.main === module;

if (isMain) {
  main().catch(async (err: unknown) => {
    logger.error({ err }, 'seedOperatorsFromAgents failed');
    await closePools();
    process.exit(1);
  });
}
