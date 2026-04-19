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
// Dry-run supporté : `--dry-run` compte ce qui *serait* créé sans écrire.
import Database from 'better-sqlite3';
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
export function inferOperatorsFromExistingData(
  db: Database.Database,
  options: InferenceOptions = {},
): InferenceSummary {
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

  // Repositories/services : instanciés ici pour rester découplés du hot path.
  const operators = new OperatorRepository(db);
  const identities = new OperatorIdentityRepository(db);
  const ownerships = new OperatorOwnershipRepository(db);
  const endpointPosteriors = new EndpointStreamingPosteriorRepository(db);
  const nodePosteriors = new NodeStreamingPosteriorRepository(db);
  const servicePosteriors = new ServiceStreamingPosteriorRepository(db);
  const service = new OperatorService(
    operators,
    identities,
    ownerships,
    endpointPosteriors,
    nodePosteriors,
    servicePosteriors,
  );

  // Étape 1 : collecter les proto-operators.
  //   - operator_id = sha256hex(node_pubkey) hérité de v31
  //   - first/last activity dérivés du min/max timestamp des transactions
  //   - tx_count pour diagnostic
  const protoRows = db
    .prepare(`
      SELECT operator_id, MIN(timestamp) as min_ts, MAX(timestamp) as max_ts, COUNT(*) as tx_count
      FROM transactions
      WHERE operator_id IS NOT NULL
      GROUP BY operator_id
    `)
    .all() as ProtoOperatorRow[];

  summary.protoOperatorsScanned = protoRows.length;

  if (summary.protoOperatorsScanned === 0) {
    logger.info('inferOperators: no proto-operators found in transactions');
    return summary;
  }

  logger.info(
    { protoOperators: summary.protoOperatorsScanned, dryRun },
    'inferOperators: starting reconciliation',
  );

  // Précharger les statements d'update pour minimiser les allocations.
  const linkAgentStmt = db.prepare(
    'UPDATE agents SET operator_id = ? WHERE public_key_hash = ? AND (operator_id IS NULL OR operator_id = ?)',
  );
  const linkServiceEndpointStmt = db.prepare(
    'UPDATE service_endpoints SET operator_id = ? WHERE agent_hash = ? AND (operator_id IS NULL OR operator_id = ?)',
  );
  const lookupAgent = db.prepare(
    'SELECT public_key, public_key_hash FROM agents WHERE public_key_hash = ?',
  );
  const lookupServiceEndpoints = db.prepare(
    'SELECT id, url FROM service_endpoints WHERE agent_hash = ?',
  );

  // Transaction unique pour l'intégralité du scan : soit tout passe, soit rien
  // n'est persisté. Dry-run contourne en ne commitant pas (simulate seulement).
  const applyAll = db.transaction((rows: ProtoOperatorRow[]) => {
    for (const row of rows) {
      const operatorId = row.operator_id;
      const firstSeen = Math.min(row.min_ts, now);
      // Bornage cohérent : last_activity reflète la dernière tx observée dans
      // l'existant, pas l'instant du script. Ça préserve le signal "recency"
      // pour le tri de GET /api/operators après bootstrap.
      const maxActivity = Math.min(row.max_ts, now);

      // Création de l'operator (ON CONFLICT DO NOTHING).
      const existed = operators.findById(operatorId) !== null;
      if (existed) {
        summary.operatorsAlreadyExisting += 1;
      } else {
        service.upsertOperator(operatorId, firstSeen);
        summary.operatorsCreated += 1;
      }

      // Rattachement du node : operator_id est sha256hex(node_pubkey). On cherche
      // le pubkey LN littéral dans agents et on claim l'ownership.
      const agent = lookupAgent.get(operatorId) as { public_key: string | null; public_key_hash: string } | undefined;
      if (agent && typeof agent.public_key === 'string' && /^(02|03)[0-9a-f]{64}$/i.test(agent.public_key)) {
        service.claimOwnership(operatorId, 'node', agent.public_key.toLowerCase(), maxActivity);
        summary.nodeOwnershipsClaimed += 1;

        const linkRes = linkAgentStmt.run(operatorId, agent.public_key_hash, operatorId);
        if (linkRes.changes > 0) summary.agentsLinked += 1;
      }

      // Rattachement des endpoints : service_endpoints.agent_hash = operator_id.
      // Claim un par URL distincte via endpointHash(canonical_url).
      const seRows = lookupServiceEndpoints.all(operatorId) as Array<{ id: number; url: string }>;
      const seenHashes = new Set<string>();
      for (const se of seRows) {
        try {
          const hash = endpointHash(se.url);
          if (seenHashes.has(hash)) continue;
          seenHashes.add(hash);
          service.claimOwnership(operatorId, 'endpoint', hash, maxActivity);
          summary.endpointOwnershipsClaimed += 1;
        } catch (err: unknown) {
          logger.debug(
            { operatorId, url: se.url, error: err instanceof Error ? err.message : String(err) },
            'inferOperators: endpointHash failed for URL, skipping',
          );
        }
      }
      if (seRows.length > 0) {
        const linkRes = linkServiceEndpointStmt.run(operatorId, operatorId, operatorId);
        summary.serviceEndpointsLinked += linkRes.changes;
      }

      // Final touch : figer last_activity au max des tx observées (les
      // claim* ci-dessus ont pu laisser last_activity à une tx intermédiaire
      // selon l'ordre de listing).
      operators.touch(operatorId, maxActivity);
    }

    // Dry-run rollback : throw pour déclencher rollback implicite de db.transaction.
    if (dryRun) {
      throw new DryRunRollback();
    }
  });

  try {
    applyAll(protoRows);
  } catch (err: unknown) {
    if (err instanceof DryRunRollback) {
      logger.info(
        { ...summary, dryRun: true },
        'inferOperators: dry-run complete — changes rolled back',
      );
      return summary;
    }
    throw err;
  }

  logger.info(
    { ...summary },
    'inferOperators: reconciliation complete',
  );
  return summary;
}

class DryRunRollback extends Error {
  constructor() {
    super('dry-run');
    this.name = 'DryRunRollback';
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const dbPath = process.env.SQLITE_PATH ?? './satrank.db';
  const dryRun = process.argv.includes('--dry-run');

  logger.info({ dbPath, dryRun }, 'inferOperatorsFromExistingData: CLI invocation');

  const db = new Database(dbPath);
  try {
    db.pragma('foreign_keys = ON');
    const summary = inferOperatorsFromExistingData(db, { dryRun });
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    db.close();
  }
}

// Guard compatible tsx + dist/ CJS (pattern aligné sur les autres scripts de la
// suite — cf. compareLegacyVsBayesian.ts, rebuildStreamingPosteriors.ts).
const isMain =
  typeof require !== 'undefined' &&
  typeof module !== 'undefined' &&
  require.main === module;

if (isMain) {
  main().catch((err: unknown) => {
    logger.error({ err }, 'inferOperatorsFromExistingData failed');
    process.exit(1);
  });
}
