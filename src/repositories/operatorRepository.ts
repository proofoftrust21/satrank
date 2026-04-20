// Phase 7 — Repository layer pour l'abstraction operator.
//
// Un operator est une entité logique qui regroupe des ressources (nodes LN,
// endpoints HTTP, services) sous une même identité cryptographique. Les
// ownerships (3 tables séparées node/endpoint/service) sont lookup-only
// depuis l'operator_id.
//
// Tous les reads agrègent via les PK composites pour rester indexés ; aucun
// scan de table n'est nécessaire dans le hot path.
import type Database from 'better-sqlite3';

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
  private stmtInsert;
  private stmtUpdateActivity;
  private stmtUpdateStatus;
  private stmtFindById;
  private stmtFindAll;
  private stmtCountByStatus;

  constructor(private db: Database.Database) {
    this.stmtInsert = db.prepare(`
      INSERT INTO operators (operator_id, first_seen, last_activity, verification_score, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(operator_id) DO NOTHING
    `);
    this.stmtUpdateActivity = db.prepare(`
      UPDATE operators SET last_activity = ? WHERE operator_id = ?
    `);
    this.stmtUpdateStatus = db.prepare(`
      UPDATE operators SET verification_score = ?, status = ? WHERE operator_id = ?
    `);
    this.stmtFindById = db.prepare('SELECT * FROM operators WHERE operator_id = ?');
    this.stmtFindAll = db.prepare(`
      SELECT * FROM operators
      WHERE (? IS NULL OR status = ?)
      ORDER BY last_activity DESC
      LIMIT ? OFFSET ?
    `);
    this.stmtCountByStatus = db.prepare('SELECT status, COUNT(*) as c FROM operators GROUP BY status');
  }

  /** Crée un operator pending s'il n'existe pas. No-op si déjà présent. */
  upsertPending(operatorId: string, now: number = Math.floor(Date.now() / 1000)): void {
    this.stmtInsert.run(operatorId, now, now, 0, 'pending', now);
  }

  touch(operatorId: string, now: number = Math.floor(Date.now() / 1000)): void {
    this.stmtUpdateActivity.run(now, operatorId);
  }

  /** Met à jour le score de vérification + statut. La règle dure 2/3 convergent
   *  est appliquée côté service (operatorService), pas ici. Le repository accepte
   *  les valeurs déjà calculées — garde la persistence agnostique. */
  updateVerification(operatorId: string, verificationScore: number, status: OperatorStatus): void {
    this.stmtUpdateStatus.run(verificationScore, status, operatorId);
  }

  findById(operatorId: string): OperatorRow | null {
    return (this.stmtFindById.get(operatorId) as OperatorRow | undefined) ?? null;
  }

  findAll(filters: { status?: OperatorStatus; limit?: number; offset?: number } = {}): OperatorRow[] {
    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;
    const status = filters.status ?? null;
    return this.stmtFindAll.all(status, status, limit, offset) as OperatorRow[];
  }

  countByStatus(): Record<OperatorStatus, number> {
    const rows = this.stmtCountByStatus.all() as Array<{ status: OperatorStatus; c: number }>;
    const out: Record<OperatorStatus, number> = { verified: 0, pending: 0, rejected: 0 };
    for (const r of rows) out[r.status] = r.c;
    return out;
  }

  /** Total d'operators matchant le filtre status (ou tous si status=undefined).
   *  Utilisé pour la pagination côté liste. */
  countFiltered(status?: OperatorStatus): number {
    const sql = status
      ? 'SELECT COUNT(*) as c FROM operators WHERE status = ?'
      : 'SELECT COUNT(*) as c FROM operators';
    const row = (status ? this.db.prepare(sql).get(status) : this.db.prepare(sql).get()) as { c: number };
    return row.c;
  }
}

export class OperatorIdentityRepository {
  private stmtInsert;
  private stmtMarkVerified;
  private stmtFindByOperator;
  private stmtFindByValue;
  private stmtDelete;

  constructor(private db: Database.Database) {
    this.stmtInsert = db.prepare(`
      INSERT INTO operator_identities (operator_id, identity_type, identity_value, verified_at, verification_proof)
      VALUES (?, ?, ?, NULL, NULL)
      ON CONFLICT(operator_id, identity_type, identity_value) DO NOTHING
    `);
    this.stmtMarkVerified = db.prepare(`
      UPDATE operator_identities
      SET verified_at = ?, verification_proof = ?
      WHERE operator_id = ? AND identity_type = ? AND identity_value = ?
    `);
    this.stmtFindByOperator = db.prepare(`
      SELECT * FROM operator_identities WHERE operator_id = ?
      ORDER BY identity_type, identity_value
    `);
    this.stmtFindByValue = db.prepare(`
      SELECT * FROM operator_identities WHERE identity_value = ?
    `);
    this.stmtDelete = db.prepare(`
      DELETE FROM operator_identities
      WHERE operator_id = ? AND identity_type = ? AND identity_value = ?
    `);
  }

  claim(operatorId: string, type: IdentityType, value: string): void {
    this.stmtInsert.run(operatorId, type, value);
  }

  /** Marque une identité comme vérifiée avec la preuve fournie (e.g. signature hex). */
  markVerified(
    operatorId: string,
    type: IdentityType,
    value: string,
    proof: string,
    now: number = Math.floor(Date.now() / 1000),
  ): void {
    this.stmtMarkVerified.run(now, proof, operatorId, type, value);
  }

  findByOperator(operatorId: string): OperatorIdentityRow[] {
    return this.stmtFindByOperator.all(operatorId) as OperatorIdentityRow[];
  }

  /** Utilisé pour détecter des collisions (même value revendiquée par plusieurs operators). */
  findByValue(value: string): OperatorIdentityRow[] {
    return this.stmtFindByValue.all(value) as OperatorIdentityRow[];
  }

  remove(operatorId: string, type: IdentityType, value: string): void {
    this.stmtDelete.run(operatorId, type, value);
  }
}

export class OperatorOwnershipRepository {
  private stmtClaimNode;
  private stmtClaimEndpoint;
  private stmtClaimService;
  private stmtVerifyNode;
  private stmtVerifyEndpoint;
  private stmtVerifyService;
  private stmtListNodes;
  private stmtListEndpoints;
  private stmtListServices;
  private stmtFindNodeOperator;
  private stmtFindEndpointOperator;

  constructor(private db: Database.Database) {
    this.stmtClaimNode = db.prepare(`
      INSERT INTO operator_owns_node (operator_id, node_pubkey, claimed_at)
      VALUES (?, ?, ?) ON CONFLICT(operator_id, node_pubkey) DO NOTHING
    `);
    this.stmtClaimEndpoint = db.prepare(`
      INSERT INTO operator_owns_endpoint (operator_id, url_hash, claimed_at)
      VALUES (?, ?, ?) ON CONFLICT(operator_id, url_hash) DO NOTHING
    `);
    this.stmtClaimService = db.prepare(`
      INSERT INTO operator_owns_service (operator_id, service_hash, claimed_at)
      VALUES (?, ?, ?) ON CONFLICT(operator_id, service_hash) DO NOTHING
    `);
    this.stmtVerifyNode = db.prepare(`
      UPDATE operator_owns_node SET verified_at = ?
      WHERE operator_id = ? AND node_pubkey = ?
    `);
    this.stmtVerifyEndpoint = db.prepare(`
      UPDATE operator_owns_endpoint SET verified_at = ?
      WHERE operator_id = ? AND url_hash = ?
    `);
    this.stmtVerifyService = db.prepare(`
      UPDATE operator_owns_service SET verified_at = ?
      WHERE operator_id = ? AND service_hash = ?
    `);
    this.stmtListNodes = db.prepare(`
      SELECT node_pubkey, claimed_at, verified_at
      FROM operator_owns_node WHERE operator_id = ?
    `);
    this.stmtListEndpoints = db.prepare(`
      SELECT url_hash, claimed_at, verified_at
      FROM operator_owns_endpoint WHERE operator_id = ?
    `);
    this.stmtListServices = db.prepare(`
      SELECT service_hash, claimed_at, verified_at
      FROM operator_owns_service WHERE operator_id = ?
    `);
    this.stmtFindNodeOperator = db.prepare(`
      SELECT operator_id, claimed_at, verified_at
      FROM operator_owns_node WHERE node_pubkey = ?
    `);
    this.stmtFindEndpointOperator = db.prepare(`
      SELECT operator_id, claimed_at, verified_at
      FROM operator_owns_endpoint WHERE url_hash = ?
    `);
  }

  claimNode(operatorId: string, nodePubkey: string, now: number = Math.floor(Date.now() / 1000)): void {
    this.stmtClaimNode.run(operatorId, nodePubkey, now);
  }
  claimEndpoint(operatorId: string, urlHash: string, now: number = Math.floor(Date.now() / 1000)): void {
    this.stmtClaimEndpoint.run(operatorId, urlHash, now);
  }
  claimService(operatorId: string, serviceHash: string, now: number = Math.floor(Date.now() / 1000)): void {
    this.stmtClaimService.run(operatorId, serviceHash, now);
  }

  verifyNode(operatorId: string, nodePubkey: string, now: number = Math.floor(Date.now() / 1000)): void {
    this.stmtVerifyNode.run(now, operatorId, nodePubkey);
  }
  verifyEndpoint(operatorId: string, urlHash: string, now: number = Math.floor(Date.now() / 1000)): void {
    this.stmtVerifyEndpoint.run(now, operatorId, urlHash);
  }
  verifyService(operatorId: string, serviceHash: string, now: number = Math.floor(Date.now() / 1000)): void {
    this.stmtVerifyService.run(now, operatorId, serviceHash);
  }

  listNodes(operatorId: string): Array<{ node_pubkey: string; claimed_at: number; verified_at: number | null }> {
    return this.stmtListNodes.all(operatorId) as Array<{ node_pubkey: string; claimed_at: number; verified_at: number | null }>;
  }
  listEndpoints(operatorId: string): Array<{ url_hash: string; claimed_at: number; verified_at: number | null }> {
    return this.stmtListEndpoints.all(operatorId) as Array<{ url_hash: string; claimed_at: number; verified_at: number | null }>;
  }
  listServices(operatorId: string): Array<{ service_hash: string; claimed_at: number; verified_at: number | null }> {
    return this.stmtListServices.all(operatorId) as Array<{ service_hash: string; claimed_at: number; verified_at: number | null }>;
  }

  /** Reverse-lookup : utilisé pour enrichir /api/agent/:hash/verdict et
   *  /api/endpoint/:url_hash avec l'operator_id correspondant. */
  findOperatorForNode(nodePubkey: string): OperatorOwnership | null {
    const row = this.stmtFindNodeOperator.get(nodePubkey) as OperatorOwnership | undefined;
    return row ?? null;
  }
  findOperatorForEndpoint(urlHash: string): OperatorOwnership | null {
    const row = this.stmtFindEndpointOperator.get(urlHash) as OperatorOwnership | undefined;
    return row ?? null;
  }
}
