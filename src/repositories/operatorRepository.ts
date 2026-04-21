// Phase 7 — Repository layer pour l'abstraction operator (pg async port, Phase 12B).
//
// Un operator est une entité logique qui regroupe des ressources (nodes LN,
// endpoints HTTP, services) sous une même identité cryptographique. Les
// ownerships (3 tables séparées node/endpoint/service) sont lookup-only
// depuis l'operator_id.
//
// Tous les reads agrègent via les PK composites pour rester indexés ; aucun
// scan de table n'est nécessaire dans le hot path.
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export type OperatorStatus = 'verified' | 'pending' | 'rejected';
export type IdentityType = 'ln_pubkey' | 'nip05' | 'dns';

export interface OperatorRow {
  operator_id: string;
  first_seen: number;
  last_activity: number;
  verification_score: number;
  status: OperatorStatus;
  created_at: number;
}

export interface OperatorIdentityRow {
  operator_id: string;
  identity_type: IdentityType;
  identity_value: string;
  verified_at: number | null;
  verification_proof: string | null;
}

export interface OperatorOwnership {
  operator_id: string;
  claimed_at: number;
  verified_at: number | null;
}

export class OperatorRepository {
  constructor(private db: Queryable) {}

  /** Crée un operator pending s'il n'existe pas. No-op si déjà présent. */
  async upsertPending(operatorId: string, now: number = Math.floor(Date.now() / 1000)): Promise<void> {
    await this.db.query(
      `
      INSERT INTO operators (operator_id, first_seen, last_activity, verification_score, status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (operator_id) DO NOTHING
      `,
      [operatorId, now, now, 0, 'pending', now],
    );
  }

  async touch(operatorId: string, now: number = Math.floor(Date.now() / 1000)): Promise<void> {
    await this.db.query(
      'UPDATE operators SET last_activity = $1 WHERE operator_id = $2',
      [now, operatorId],
    );
  }

  /** Met à jour le score de vérification + statut. La règle dure 2/3 convergent
   *  est appliquée côté service (operatorService), pas ici. Le repository accepte
   *  les valeurs déjà calculées — garde la persistence agnostique. */
  async updateVerification(operatorId: string, verificationScore: number, status: OperatorStatus): Promise<void> {
    await this.db.query(
      'UPDATE operators SET verification_score = $1, status = $2 WHERE operator_id = $3',
      [verificationScore, status, operatorId],
    );
  }

  async findById(operatorId: string): Promise<OperatorRow | null> {
    const { rows } = await this.db.query<OperatorRow>(
      'SELECT * FROM operators WHERE operator_id = $1',
      [operatorId],
    );
    return rows[0] ?? null;
  }

  async findAll(filters: { status?: OperatorStatus; limit?: number; offset?: number } = {}): Promise<OperatorRow[]> {
    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;
    const status = filters.status ?? null;
    const { rows } = await this.db.query<OperatorRow>(
      `
      SELECT * FROM operators
      WHERE ($1::text IS NULL OR status = $2::text)
      ORDER BY last_activity DESC
      LIMIT $3 OFFSET $4
      `,
      [status, status, limit, offset],
    );
    return rows;
  }

  async countByStatus(): Promise<Record<OperatorStatus, number>> {
    const { rows } = await this.db.query<{ status: OperatorStatus; c: string }>(
      'SELECT status, COUNT(*)::text as c FROM operators GROUP BY status',
    );
    const out: Record<OperatorStatus, number> = { verified: 0, pending: 0, rejected: 0 };
    for (const r of rows) out[r.status] = Number(r.c);
    return out;
  }

  /** Total d'operators matchant le filtre status (ou tous si status=undefined).
   *  Utilisé pour la pagination côté liste. */
  async countFiltered(status?: OperatorStatus): Promise<number> {
    if (status) {
      const { rows } = await this.db.query<{ c: string }>(
        'SELECT COUNT(*)::text as c FROM operators WHERE status = $1',
        [status],
      );
      return Number(rows[0]?.c ?? 0);
    }
    const { rows } = await this.db.query<{ c: string }>(
      'SELECT COUNT(*)::text as c FROM operators',
    );
    return Number(rows[0]?.c ?? 0);
  }
}

export class OperatorIdentityRepository {
  constructor(private db: Queryable) {}

  async claim(operatorId: string, type: IdentityType, value: string): Promise<void> {
    await this.db.query(
      `
      INSERT INTO operator_identities (operator_id, identity_type, identity_value, verified_at, verification_proof)
      VALUES ($1, $2, $3, NULL, NULL)
      ON CONFLICT (operator_id, identity_type, identity_value) DO NOTHING
      `,
      [operatorId, type, value],
    );
  }

  /** Marque une identité comme vérifiée avec la preuve fournie (e.g. signature hex). */
  async markVerified(
    operatorId: string,
    type: IdentityType,
    value: string,
    proof: string,
    now: number = Math.floor(Date.now() / 1000),
  ): Promise<void> {
    await this.db.query(
      `
      UPDATE operator_identities
      SET verified_at = $1, verification_proof = $2
      WHERE operator_id = $3 AND identity_type = $4 AND identity_value = $5
      `,
      [now, proof, operatorId, type, value],
    );
  }

  async findByOperator(operatorId: string): Promise<OperatorIdentityRow[]> {
    const { rows } = await this.db.query<OperatorIdentityRow>(
      `
      SELECT * FROM operator_identities WHERE operator_id = $1
      ORDER BY identity_type, identity_value
      `,
      [operatorId],
    );
    return rows;
  }

  /** Utilisé pour détecter des collisions (même value revendiquée par plusieurs operators). */
  async findByValue(value: string): Promise<OperatorIdentityRow[]> {
    const { rows } = await this.db.query<OperatorIdentityRow>(
      'SELECT * FROM operator_identities WHERE identity_value = $1',
      [value],
    );
    return rows;
  }

  async remove(operatorId: string, type: IdentityType, value: string): Promise<void> {
    await this.db.query(
      `
      DELETE FROM operator_identities
      WHERE operator_id = $1 AND identity_type = $2 AND identity_value = $3
      `,
      [operatorId, type, value],
    );
  }
}

export class OperatorOwnershipRepository {
  constructor(private db: Queryable) {}

  async claimNode(operatorId: string, nodePubkey: string, now: number = Math.floor(Date.now() / 1000)): Promise<void> {
    await this.db.query(
      `
      INSERT INTO operator_owns_node (operator_id, node_pubkey, claimed_at)
      VALUES ($1, $2, $3) ON CONFLICT (operator_id, node_pubkey) DO NOTHING
      `,
      [operatorId, nodePubkey, now],
    );
  }
  async claimEndpoint(operatorId: string, urlHash: string, now: number = Math.floor(Date.now() / 1000)): Promise<void> {
    await this.db.query(
      `
      INSERT INTO operator_owns_endpoint (operator_id, url_hash, claimed_at)
      VALUES ($1, $2, $3) ON CONFLICT (operator_id, url_hash) DO NOTHING
      `,
      [operatorId, urlHash, now],
    );
  }
  async claimService(operatorId: string, serviceHash: string, now: number = Math.floor(Date.now() / 1000)): Promise<void> {
    await this.db.query(
      `
      INSERT INTO operator_owns_service (operator_id, service_hash, claimed_at)
      VALUES ($1, $2, $3) ON CONFLICT (operator_id, service_hash) DO NOTHING
      `,
      [operatorId, serviceHash, now],
    );
  }

  async verifyNode(operatorId: string, nodePubkey: string, now: number = Math.floor(Date.now() / 1000)): Promise<void> {
    await this.db.query(
      `
      UPDATE operator_owns_node SET verified_at = $1
      WHERE operator_id = $2 AND node_pubkey = $3
      `,
      [now, operatorId, nodePubkey],
    );
  }
  async verifyEndpoint(operatorId: string, urlHash: string, now: number = Math.floor(Date.now() / 1000)): Promise<void> {
    await this.db.query(
      `
      UPDATE operator_owns_endpoint SET verified_at = $1
      WHERE operator_id = $2 AND url_hash = $3
      `,
      [now, operatorId, urlHash],
    );
  }
  async verifyService(operatorId: string, serviceHash: string, now: number = Math.floor(Date.now() / 1000)): Promise<void> {
    await this.db.query(
      `
      UPDATE operator_owns_service SET verified_at = $1
      WHERE operator_id = $2 AND service_hash = $3
      `,
      [now, operatorId, serviceHash],
    );
  }

  async listNodes(operatorId: string): Promise<Array<{ node_pubkey: string; claimed_at: number; verified_at: number | null }>> {
    const { rows } = await this.db.query<{ node_pubkey: string; claimed_at: number; verified_at: number | null }>(
      `
      SELECT node_pubkey, claimed_at, verified_at
      FROM operator_owns_node WHERE operator_id = $1
      `,
      [operatorId],
    );
    return rows;
  }
  async listEndpoints(operatorId: string): Promise<Array<{ url_hash: string; claimed_at: number; verified_at: number | null }>> {
    const { rows } = await this.db.query<{ url_hash: string; claimed_at: number; verified_at: number | null }>(
      `
      SELECT url_hash, claimed_at, verified_at
      FROM operator_owns_endpoint WHERE operator_id = $1
      `,
      [operatorId],
    );
    return rows;
  }
  async listServices(operatorId: string): Promise<Array<{ service_hash: string; claimed_at: number; verified_at: number | null }>> {
    const { rows } = await this.db.query<{ service_hash: string; claimed_at: number; verified_at: number | null }>(
      `
      SELECT service_hash, claimed_at, verified_at
      FROM operator_owns_service WHERE operator_id = $1
      `,
      [operatorId],
    );
    return rows;
  }

  /** Reverse-lookup : utilisé pour enrichir /api/agent/:hash/verdict et
   *  /api/endpoint/:url_hash avec l'operator_id correspondant. */
  async findOperatorForNode(nodePubkey: string): Promise<OperatorOwnership | null> {
    const { rows } = await this.db.query<OperatorOwnership>(
      `
      SELECT operator_id, claimed_at, verified_at
      FROM operator_owns_node WHERE node_pubkey = $1
      `,
      [nodePubkey],
    );
    return rows[0] ?? null;
  }
  async findOperatorForEndpoint(urlHash: string): Promise<OperatorOwnership | null> {
    const { rows } = await this.db.query<OperatorOwnership>(
      `
      SELECT operator_id, claimed_at, verified_at
      FROM operator_owns_endpoint WHERE url_hash = $1
      `,
      [urlHash],
    );
    return rows[0] ?? null;
  }
}
