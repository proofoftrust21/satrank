// Phase 7 — tests unitaires des repositories operator.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, type TestDb } from './helpers/testDatabase';
import {
  OperatorRepository,
  OperatorIdentityRepository,
  OperatorOwnershipRepository,
} from '../repositories/operatorRepository';
let testDb: TestDb;

describe('OperatorRepository', async () => {
  let db: Pool;
  let repo: OperatorRepository;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    repo = new OperatorRepository(db);
  });

  afterEach(async () => { await teardownTestPool(testDb); });

  it('upsertPending crée un operator en status pending avec score 0', async () => {
    await repo.upsertPending('op1', 1000);
    const row = await repo.findById('op1');
    expect(row).not.toBeNull();
    expect(row!.status).toBe('pending');
    expect(row!.verification_score).toBe(0);
    expect(row!.first_seen).toBe(1000);
    expect(row!.last_activity).toBe(1000);
  });

  it('upsertPending est idempotent (ON CONFLICT DO NOTHING)', async () => {
    await repo.upsertPending('op1', 1000);
    await repo.upsertPending('op1', 2000);
    const row = await repo.findById('op1');
    expect(row!.first_seen).toBe(1000); // pas écrasé
  });

  it('touch met à jour last_activity sans changer first_seen', async () => {
    await repo.upsertPending('op1', 1000);
    await repo.touch('op1', 5000);
    const row = await repo.findById('op1');
    expect(row!.first_seen).toBe(1000);
    expect(row!.last_activity).toBe(5000);
  });

  it('updateVerification persiste score et status', async () => {
    await repo.upsertPending('op1', 1000);
    await repo.updateVerification('op1', 2, 'verified');
    const row = await repo.findById('op1');
    expect(row!.verification_score).toBe(2);
    expect(row!.status).toBe('verified');
  });

  it('findAll filtre par status', async () => {
    await repo.upsertPending('op1', 1000);
    await repo.upsertPending('op2', 2000);
    await repo.updateVerification('op1', 2, 'verified');
    const verified = await repo.findAll({ status: 'verified' });
    const pending = await repo.findAll({ status: 'pending' });
    expect(verified).toHaveLength(1);
    expect(verified[0].operator_id).toBe('op1');
    expect(pending).toHaveLength(1);
    expect(pending[0].operator_id).toBe('op2');
  });

  it('findAll ordonne par last_activity DESC et pagine', async () => {
    await repo.upsertPending('op-old', 1000);
    await repo.upsertPending('op-new', 3000);
    await repo.upsertPending('op-mid', 2000);
    const all = await repo.findAll({ limit: 2, offset: 0 });
    expect(all.map((r) => r.operator_id)).toEqual(['op-new', 'op-mid']);
    const page2 = await repo.findAll({ limit: 2, offset: 2 });
    expect(page2.map((r) => r.operator_id)).toEqual(['op-old']);
  });

  it('countByStatus renvoie les totaux par statut', async () => {
    await repo.upsertPending('a', 1);
    await repo.upsertPending('b', 2);
    await repo.upsertPending('c', 3);
    await repo.updateVerification('a', 3, 'verified');
    await repo.updateVerification('b', 0, 'rejected');
    const counts = await repo.countByStatus();
    expect(counts.verified).toBe(1);
    expect(counts.rejected).toBe(1);
    expect(counts.pending).toBe(1);
  });

  it('findById renvoie null pour un operator inconnu', async () => {
    expect(await repo.findById('inexistant')).toBeNull();
  });
});

describe('OperatorIdentityRepository', async () => {
  let db: Pool;
  let opRepo: OperatorRepository;
  let idRepo: OperatorIdentityRepository;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    opRepo = new OperatorRepository(db);
    idRepo = new OperatorIdentityRepository(db);
    await opRepo.upsertPending('op1', 1000);
  });

  afterEach(async () => { await teardownTestPool(testDb); });

  it('claim insère une identité non vérifiée', async () => {
    await idRepo.claim('op1', 'dns', 'example.com');
    const rows = await idRepo.findByOperator('op1');
    expect(rows).toHaveLength(1);
    expect(rows[0].verified_at).toBeNull();
    expect(rows[0].verification_proof).toBeNull();
  });

  it('claim est idempotent sur la triple clé', async () => {
    await idRepo.claim('op1', 'dns', 'example.com');
    await idRepo.claim('op1', 'dns', 'example.com');
    expect(await idRepo.findByOperator('op1')).toHaveLength(1);
  });

  it('claim accepte plusieurs types pour le même operator', async () => {
    await idRepo.claim('op1', 'dns', 'example.com');
    await idRepo.claim('op1', 'nip05', 'alice@example.com');
    await idRepo.claim('op1', 'ln_pubkey', '02abc');
    expect(await idRepo.findByOperator('op1')).toHaveLength(3);
  });

  it('markVerified pose verified_at + proof', async () => {
    await idRepo.claim('op1', 'dns', 'example.com');
    await idRepo.markVerified('op1', 'dns', 'example.com', 'txt-proof', 5000);
    const rows = await idRepo.findByOperator('op1');
    expect(rows[0].verified_at).toBe(5000);
    expect(rows[0].verification_proof).toBe('txt-proof');
  });

  it('findByValue détecte les collisions cross-operator', async () => {
    await opRepo.upsertPending('op2', 2000);
    await idRepo.claim('op1', 'dns', 'shared.com');
    await idRepo.claim('op2', 'dns', 'shared.com');
    const collisions = await idRepo.findByValue('shared.com');
    expect(collisions).toHaveLength(2);
    expect(collisions.map((r) => r.operator_id).sort()).toEqual(['op1', 'op2']);
  });

  it('remove supprime une identité précise', async () => {
    await idRepo.claim('op1', 'dns', 'a.com');
    await idRepo.claim('op1', 'dns', 'b.com');
    await idRepo.remove('op1', 'dns', 'a.com');
    const rows = await idRepo.findByOperator('op1');
    expect(rows.map((r) => r.identity_value)).toEqual(['b.com']);
  });

  it('CASCADE supprime les identités quand l\'operator est supprimé', async () => {
    await idRepo.claim('op1', 'dns', 'a.com');
    await db.query('DELETE FROM operators WHERE operator_id = $1', ['op1']);
    expect(await idRepo.findByOperator('op1')).toHaveLength(0);
  });
});

describe('OperatorOwnershipRepository', async () => {
  let db: Pool;
  let opRepo: OperatorRepository;
  let ownRepo: OperatorOwnershipRepository;

  beforeEach(async () => {
    testDb = await setupTestPool();

    db = testDb.pool;
    opRepo = new OperatorRepository(db);
    ownRepo = new OperatorOwnershipRepository(db);
    await opRepo.upsertPending('op1', 1000);
  });

  afterEach(async () => { await teardownTestPool(testDb); });

  it('claimNode/Endpoint/Service insère un lien avec verified_at=NULL', async () => {
    await ownRepo.claimNode('op1', 'pk1', 1000);
    await ownRepo.claimEndpoint('op1', 'h1', 1000);
    await ownRepo.claimService('op1', 's1', 1000);
    expect(await ownRepo.listNodes('op1')).toHaveLength(1);
    expect(await ownRepo.listEndpoints('op1')).toHaveLength(1);
    expect(await ownRepo.listServices('op1')).toHaveLength(1);
    const nodes = await ownRepo.listNodes('op1');
    expect(nodes[0].verified_at).toBeNull();
  });

  it('claim est idempotent', async () => {
    await ownRepo.claimNode('op1', 'pk1', 1000);
    await ownRepo.claimNode('op1', 'pk1', 2000);
    expect(await ownRepo.listNodes('op1')).toHaveLength(1);
  });

  it('verifyNode pose verified_at', async () => {
    await ownRepo.claimNode('op1', 'pk1', 1000);
    await ownRepo.verifyNode('op1', 'pk1', 5000);
    const nodes = await ownRepo.listNodes('op1');
    expect(nodes[0].verified_at).toBe(5000);
  });

  it('findOperatorForNode retourne l\'ownership existant', async () => {
    await ownRepo.claimNode('op1', 'pk1', 1000);
    await ownRepo.verifyNode('op1', 'pk1', 2000);
    const own = await ownRepo.findOperatorForNode('pk1');
    expect(own).not.toBeNull();
    expect(own!.operator_id).toBe('op1');
    expect(own!.verified_at).toBe(2000);
  });

  it('findOperatorForNode retourne null quand absent', async () => {
    expect(await ownRepo.findOperatorForNode('pk-inexistant')).toBeNull();
  });

  it('findOperatorForEndpoint idem', async () => {
    await ownRepo.claimEndpoint('op1', 'h1', 1000);
    const own = await ownRepo.findOperatorForEndpoint('h1');
    expect(own).not.toBeNull();
    expect(own!.operator_id).toBe('op1');
  });

  it('CASCADE supprime les ownerships quand l\'operator est supprimé', async () => {
    await ownRepo.claimNode('op1', 'pk1', 1000);
    await ownRepo.claimEndpoint('op1', 'h1', 1000);
    await ownRepo.claimService('op1', 's1', 1000);
    await db.query('DELETE FROM operators WHERE operator_id = $1', ['op1']);
    expect(await ownRepo.listNodes('op1')).toHaveLength(0);
    expect(await ownRepo.listEndpoints('op1')).toHaveLength(0);
    expect(await ownRepo.listServices('op1')).toHaveLength(0);
  });
});
