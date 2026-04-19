// Phase 7 — tests unitaires des repositories operator.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import {
  OperatorRepository,
  OperatorIdentityRepository,
  OperatorOwnershipRepository,
} from '../repositories/operatorRepository';

describe('OperatorRepository', () => {
  let db: Database.Database;
  let repo: OperatorRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    repo = new OperatorRepository(db);
  });

  afterEach(() => db.close());

  it('upsertPending crée un operator en status pending avec score 0', () => {
    repo.upsertPending('op1', 1000);
    const row = repo.findById('op1');
    expect(row).not.toBeNull();
    expect(row!.status).toBe('pending');
    expect(row!.verification_score).toBe(0);
    expect(row!.first_seen).toBe(1000);
    expect(row!.last_activity).toBe(1000);
  });

  it('upsertPending est idempotent (ON CONFLICT DO NOTHING)', () => {
    repo.upsertPending('op1', 1000);
    repo.upsertPending('op1', 2000);
    const row = repo.findById('op1');
    expect(row!.first_seen).toBe(1000); // pas écrasé
  });

  it('touch met à jour last_activity sans changer first_seen', () => {
    repo.upsertPending('op1', 1000);
    repo.touch('op1', 5000);
    const row = repo.findById('op1');
    expect(row!.first_seen).toBe(1000);
    expect(row!.last_activity).toBe(5000);
  });

  it('updateVerification persiste score et status', () => {
    repo.upsertPending('op1', 1000);
    repo.updateVerification('op1', 2, 'verified');
    const row = repo.findById('op1');
    expect(row!.verification_score).toBe(2);
    expect(row!.status).toBe('verified');
  });

  it('findAll filtre par status', () => {
    repo.upsertPending('op1', 1000);
    repo.upsertPending('op2', 2000);
    repo.updateVerification('op1', 2, 'verified');
    const verified = repo.findAll({ status: 'verified' });
    const pending = repo.findAll({ status: 'pending' });
    expect(verified).toHaveLength(1);
    expect(verified[0].operator_id).toBe('op1');
    expect(pending).toHaveLength(1);
    expect(pending[0].operator_id).toBe('op2');
  });

  it('findAll ordonne par last_activity DESC et pagine', () => {
    repo.upsertPending('op-old', 1000);
    repo.upsertPending('op-new', 3000);
    repo.upsertPending('op-mid', 2000);
    const all = repo.findAll({ limit: 2, offset: 0 });
    expect(all.map((r) => r.operator_id)).toEqual(['op-new', 'op-mid']);
    const page2 = repo.findAll({ limit: 2, offset: 2 });
    expect(page2.map((r) => r.operator_id)).toEqual(['op-old']);
  });

  it('countByStatus renvoie les totaux par statut', () => {
    repo.upsertPending('a', 1);
    repo.upsertPending('b', 2);
    repo.upsertPending('c', 3);
    repo.updateVerification('a', 3, 'verified');
    repo.updateVerification('b', 0, 'rejected');
    const counts = repo.countByStatus();
    expect(counts.verified).toBe(1);
    expect(counts.rejected).toBe(1);
    expect(counts.pending).toBe(1);
  });

  it('findById renvoie null pour un operator inconnu', () => {
    expect(repo.findById('inexistant')).toBeNull();
  });
});

describe('OperatorIdentityRepository', () => {
  let db: Database.Database;
  let opRepo: OperatorRepository;
  let idRepo: OperatorIdentityRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    opRepo = new OperatorRepository(db);
    idRepo = new OperatorIdentityRepository(db);
    opRepo.upsertPending('op1', 1000);
  });

  afterEach(() => db.close());

  it('claim insère une identité non vérifiée', () => {
    idRepo.claim('op1', 'dns', 'example.com');
    const rows = idRepo.findByOperator('op1');
    expect(rows).toHaveLength(1);
    expect(rows[0].verified_at).toBeNull();
    expect(rows[0].verification_proof).toBeNull();
  });

  it('claim est idempotent sur la triple clé', () => {
    idRepo.claim('op1', 'dns', 'example.com');
    idRepo.claim('op1', 'dns', 'example.com');
    expect(idRepo.findByOperator('op1')).toHaveLength(1);
  });

  it('claim accepte plusieurs types pour le même operator', () => {
    idRepo.claim('op1', 'dns', 'example.com');
    idRepo.claim('op1', 'nip05', 'alice@example.com');
    idRepo.claim('op1', 'ln_pubkey', '02abc');
    expect(idRepo.findByOperator('op1')).toHaveLength(3);
  });

  it('markVerified pose verified_at + proof', () => {
    idRepo.claim('op1', 'dns', 'example.com');
    idRepo.markVerified('op1', 'dns', 'example.com', 'txt-proof', 5000);
    const rows = idRepo.findByOperator('op1');
    expect(rows[0].verified_at).toBe(5000);
    expect(rows[0].verification_proof).toBe('txt-proof');
  });

  it('findByValue détecte les collisions cross-operator', () => {
    opRepo.upsertPending('op2', 2000);
    idRepo.claim('op1', 'dns', 'shared.com');
    idRepo.claim('op2', 'dns', 'shared.com');
    const collisions = idRepo.findByValue('shared.com');
    expect(collisions).toHaveLength(2);
    expect(collisions.map((r) => r.operator_id).sort()).toEqual(['op1', 'op2']);
  });

  it('remove supprime une identité précise', () => {
    idRepo.claim('op1', 'dns', 'a.com');
    idRepo.claim('op1', 'dns', 'b.com');
    idRepo.remove('op1', 'dns', 'a.com');
    const rows = idRepo.findByOperator('op1');
    expect(rows.map((r) => r.identity_value)).toEqual(['b.com']);
  });

  it('CASCADE supprime les identités quand l\'operator est supprimé', () => {
    idRepo.claim('op1', 'dns', 'a.com');
    db.prepare('DELETE FROM operators WHERE operator_id = ?').run('op1');
    expect(idRepo.findByOperator('op1')).toHaveLength(0);
  });
});

describe('OperatorOwnershipRepository', () => {
  let db: Database.Database;
  let opRepo: OperatorRepository;
  let ownRepo: OperatorOwnershipRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    opRepo = new OperatorRepository(db);
    ownRepo = new OperatorOwnershipRepository(db);
    opRepo.upsertPending('op1', 1000);
  });

  afterEach(() => db.close());

  it('claimNode/Endpoint/Service insère un lien avec verified_at=NULL', () => {
    ownRepo.claimNode('op1', 'pk1', 1000);
    ownRepo.claimEndpoint('op1', 'h1', 1000);
    ownRepo.claimService('op1', 's1', 1000);
    expect(ownRepo.listNodes('op1')).toHaveLength(1);
    expect(ownRepo.listEndpoints('op1')).toHaveLength(1);
    expect(ownRepo.listServices('op1')).toHaveLength(1);
    expect(ownRepo.listNodes('op1')[0].verified_at).toBeNull();
  });

  it('claim est idempotent', () => {
    ownRepo.claimNode('op1', 'pk1', 1000);
    ownRepo.claimNode('op1', 'pk1', 2000);
    expect(ownRepo.listNodes('op1')).toHaveLength(1);
  });

  it('verifyNode pose verified_at', () => {
    ownRepo.claimNode('op1', 'pk1', 1000);
    ownRepo.verifyNode('op1', 'pk1', 5000);
    const nodes = ownRepo.listNodes('op1');
    expect(nodes[0].verified_at).toBe(5000);
  });

  it('findOperatorForNode retourne l\'ownership existant', () => {
    ownRepo.claimNode('op1', 'pk1', 1000);
    ownRepo.verifyNode('op1', 'pk1', 2000);
    const own = ownRepo.findOperatorForNode('pk1');
    expect(own).not.toBeNull();
    expect(own!.operator_id).toBe('op1');
    expect(own!.verified_at).toBe(2000);
  });

  it('findOperatorForNode retourne null quand absent', () => {
    expect(ownRepo.findOperatorForNode('pk-inexistant')).toBeNull();
  });

  it('findOperatorForEndpoint idem', () => {
    ownRepo.claimEndpoint('op1', 'h1', 1000);
    const own = ownRepo.findOperatorForEndpoint('h1');
    expect(own).not.toBeNull();
    expect(own!.operator_id).toBe('op1');
  });

  it('CASCADE supprime les ownerships quand l\'operator est supprimé', () => {
    ownRepo.claimNode('op1', 'pk1', 1000);
    ownRepo.claimEndpoint('op1', 'h1', 1000);
    ownRepo.claimService('op1', 's1', 1000);
    db.prepare('DELETE FROM operators WHERE operator_id = ?').run('op1');
    expect(ownRepo.listNodes('op1')).toHaveLength(0);
    expect(ownRepo.listEndpoints('op1')).toHaveLength(0);
    expect(ownRepo.listServices('op1')).toHaveLength(0);
  });
});
