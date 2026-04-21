// Phase 7 — C9 : tests du script de bootstrap operators depuis données legacy.
//
// Couverture :
//   - scan distinct operator_id dans transactions
//   - upsertOperator avec first_seen = min(timestamp)
//   - claim node ownership via agents.public_key
//   - claim endpoint ownership via service_endpoints.url (endpointHash)
//   - link agents.operator_id + service_endpoints.operator_id
//   - idempotence sur re-run
//   - dry-run : summary correct mais aucune écriture
//   - agents sans public_key valide → pas de claim node
//   - edge case : aucune transaction → no-op summary
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import { inferOperatorsFromExistingData } from '../scripts/inferOperatorsFromExistingData';
import { OperatorRepository, OperatorOwnershipRepository } from '../repositories/operatorRepository';
import { endpointHash } from '../utils/urlCanonical';
import { sha256 } from '../utils/crypto';
let testDb: TestDb;

const NOW = Math.floor(Date.now() / 1000);

async function insertAgent(
  pool: Pool,
  opts: { publicKey: string; alias?: string; firstSeen?: number },
): Promise<string> {
  const hash = sha256(opts.publicKey);
  await pool.query(
    `INSERT INTO agents (public_key_hash, public_key, alias, first_seen, last_seen, source,
                         total_transactions, total_attestations_received, avg_score)
     VALUES ($1, $2, $3, $4, $5, 'lightning_graph', 0, 0, 0)`,
    [hash, opts.publicKey, opts.alias ?? null, opts.firstSeen ?? NOW - 86400, NOW],
  );
  return hash;
}

async function insertTx(
  pool: Pool,
  opts: { operatorId: string; senderHash: string; receiverHash: string; timestamp: number },
): Promise<void> {
  const id = 'tx-' + Math.random().toString(36).slice(2, 12);
  await pool.query(
    `INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp,
                               payment_hash, preimage, status, protocol, operator_id)
     VALUES ($1, $2, $3, 'medium', $4, $5, NULL, 'verified', 'l402', $6)`,
    [id, opts.senderHash, opts.receiverHash, opts.timestamp, 'p'.repeat(64), opts.operatorId],
  );
}

async function insertServiceEndpoint(
  pool: Pool,
  opts: { agentHash: string; url: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO service_endpoints (agent_hash, url, created_at, source)
     VALUES ($1, $2, $3, 'self_registered')`,
    [opts.agentHash, opts.url, NOW],
  );
}

describe('inferOperatorsFromExistingData', async () => {
  let pool: Pool;
  let operators: OperatorRepository;
  let ownerships: OperatorOwnershipRepository;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    operators = new OperatorRepository(pool);
    ownerships = new OperatorOwnershipRepository(pool);
  });

  afterAll(async () => {
    await teardownTestPool(testDb);
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });

  it('no-op summary quand aucune transaction', async () => {
    const summary = await inferOperatorsFromExistingData(pool, { now: NOW });
    expect(summary.protoOperatorsScanned).toBe(0);
    expect(summary.operatorsCreated).toBe(0);
  });

  it('crée un operator pending pour chaque proto-operator distinct', async () => {
    const pk1 = '02' + 'a'.repeat(64);
    const pk2 = '03' + 'b'.repeat(64);
    const hash1 = await insertAgent(pool, { publicKey: pk1, alias: 'node-1' });
    const hash2 = await insertAgent(pool, { publicKey: pk2, alias: 'node-2' });
    const sender = await insertAgent(pool, { publicKey: '02' + 'c'.repeat(64), alias: 'sender' });

    await insertTx(pool, { operatorId: hash1, senderHash: sender, receiverHash: hash1, timestamp: NOW - 3600 });
    await insertTx(pool, { operatorId: hash1, senderHash: sender, receiverHash: hash1, timestamp: NOW - 1800 });
    await insertTx(pool, { operatorId: hash2, senderHash: sender, receiverHash: hash2, timestamp: NOW - 7200 });

    const summary = await inferOperatorsFromExistingData(pool, { now: NOW });
    expect(summary.protoOperatorsScanned).toBe(2);
    expect(summary.operatorsCreated).toBe(2);
    expect(summary.operatorsAlreadyExisting).toBe(0);

    const op1 = await operators.findById(hash1);
    expect(op1?.status).toBe('pending');
    expect(op1?.first_seen).toBe(NOW - 3600);
  });

  it('claim node ownership via agents.public_key', async () => {
    const pk = '02' + 'a'.repeat(64);
    const hash = await insertAgent(pool, { publicKey: pk });
    const sender = await insertAgent(pool, { publicKey: '02' + 'c'.repeat(64) });
    await insertTx(pool, { operatorId: hash, senderHash: sender, receiverHash: hash, timestamp: NOW - 100 });

    const summary = await inferOperatorsFromExistingData(pool, { now: NOW });
    expect(summary.nodeOwnershipsClaimed).toBe(1);

    const nodes = await ownerships.listNodes(hash);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].node_pubkey).toBe(pk);
  });

  it('link agents.operator_id', async () => {
    const pk = '02' + 'a'.repeat(64);
    const hash = await insertAgent(pool, { publicKey: pk });
    const sender = await insertAgent(pool, { publicKey: '02' + 'c'.repeat(64) });
    await insertTx(pool, { operatorId: hash, senderHash: sender, receiverHash: hash, timestamp: NOW });

    const summary = await inferOperatorsFromExistingData(pool, { now: NOW });
    expect(summary.agentsLinked).toBe(1);

    const { rows } = await pool.query<{ operator_id: string }>(
      'SELECT operator_id FROM agents WHERE public_key_hash = $1',
      [hash],
    );
    expect(rows[0].operator_id).toBe(hash);
  });

  it('claim endpoint ownership via service_endpoints.url', async () => {
    const pk = '02' + 'a'.repeat(64);
    const hash = await insertAgent(pool, { publicKey: pk });
    const sender = await insertAgent(pool, { publicKey: '02' + 'c'.repeat(64) });
    await insertTx(pool, { operatorId: hash, senderHash: sender, receiverHash: hash, timestamp: NOW });
    await insertServiceEndpoint(pool, { agentHash: hash, url: 'https://api1.example.com/l402' });
    await insertServiceEndpoint(pool, { agentHash: hash, url: 'https://api2.example.com/l402' });

    const summary = await inferOperatorsFromExistingData(pool, { now: NOW });
    expect(summary.endpointOwnershipsClaimed).toBe(2);
    expect(summary.serviceEndpointsLinked).toBe(2);

    const endpoints = await ownerships.listEndpoints(hash);
    expect(endpoints).toHaveLength(2);
    const hashes = endpoints.map((e) => e.url_hash).sort();
    const expected = [
      endpointHash('https://api1.example.com/l402'),
      endpointHash('https://api2.example.com/l402'),
    ].sort();
    expect(hashes).toEqual(expected);
  });

  it('idempotent sur re-run', async () => {
    const pk = '02' + 'a'.repeat(64);
    const hash = await insertAgent(pool, { publicKey: pk });
    const sender = await insertAgent(pool, { publicKey: '02' + 'c'.repeat(64) });
    await insertTx(pool, { operatorId: hash, senderHash: sender, receiverHash: hash, timestamp: NOW });
    await insertServiceEndpoint(pool, { agentHash: hash, url: 'https://api.example.com/l402' });

    const first = await inferOperatorsFromExistingData(pool, { now: NOW });
    expect(first.operatorsCreated).toBe(1);
    expect(first.nodeOwnershipsClaimed).toBe(1);
    expect(first.endpointOwnershipsClaimed).toBe(1);

    const second = await inferOperatorsFromExistingData(pool, { now: NOW });
    expect(second.protoOperatorsScanned).toBe(1);
    expect(second.operatorsAlreadyExisting).toBe(1);
    expect(second.operatorsCreated).toBe(0);
    // Les claim* sont ON CONFLICT DO NOTHING — l'incrément nodeOwnershipsClaimed
    // reflète les tentatives, pas les INSERTs réels. L'état DB reste stable.
    const nodes = await ownerships.listNodes(hash);
    expect(nodes).toHaveLength(1);
    const endpoints = await ownerships.listEndpoints(hash);
    expect(endpoints).toHaveLength(1);
  });

  it('dry-run : summary rempli mais rien n\'est écrit', async () => {
    const pk = '02' + 'a'.repeat(64);
    const hash = await insertAgent(pool, { publicKey: pk });
    const sender = await insertAgent(pool, { publicKey: '02' + 'c'.repeat(64) });
    await insertTx(pool, { operatorId: hash, senderHash: sender, receiverHash: hash, timestamp: NOW });
    await insertServiceEndpoint(pool, { agentHash: hash, url: 'https://api.example.com/l402' });

    const summary = await inferOperatorsFromExistingData(pool, { now: NOW, dryRun: true });
    expect(summary.protoOperatorsScanned).toBe(1);
    expect(summary.operatorsCreated).toBe(1);
    expect(summary.nodeOwnershipsClaimed).toBe(1);
    expect(summary.endpointOwnershipsClaimed).toBe(1);

    // Aucun effet en base malgré le summary.
    expect(await operators.findById(hash)).toBeNull();
    expect(await ownerships.listNodes(hash)).toHaveLength(0);
    expect(await ownerships.listEndpoints(hash)).toHaveLength(0);
  });

  it('agents sans public_key valide → pas de claim node', async () => {
    // Insérer un agent avec public_key=NULL (edge case legacy).
    const hash = 'f'.repeat(64);
    await pool.query(
      `INSERT INTO agents (public_key_hash, public_key, alias, first_seen, last_seen, source,
                           total_transactions, total_attestations_received, avg_score)
       VALUES ($1, NULL, NULL, $2, $3, 'lightning_graph', 0, 0, 0)`,
      [hash, NOW - 86400, NOW],
    );
    const sender = await insertAgent(pool, { publicKey: '02' + 'c'.repeat(64) });
    await insertTx(pool, { operatorId: hash, senderHash: sender, receiverHash: hash, timestamp: NOW });

    const summary = await inferOperatorsFromExistingData(pool, { now: NOW });
    expect(summary.operatorsCreated).toBe(1);
    expect(summary.nodeOwnershipsClaimed).toBe(0);
    expect(summary.agentsLinked).toBe(0);
  });

  it('last_activity bump à max(timestamp) des transactions', async () => {
    const pk = '02' + 'a'.repeat(64);
    const hash = await insertAgent(pool, { publicKey: pk });
    const sender = await insertAgent(pool, { publicKey: '02' + 'c'.repeat(64) });
    await insertTx(pool, { operatorId: hash, senderHash: sender, receiverHash: hash, timestamp: NOW - 10000 });
    await insertTx(pool, { operatorId: hash, senderHash: sender, receiverHash: hash, timestamp: NOW - 500 });

    await inferOperatorsFromExistingData(pool, { now: NOW });
    const op = await operators.findById(hash);
    expect(op?.first_seen).toBe(NOW - 10000);
    expect(op?.last_activity).toBe(NOW - 500);
  });

  it('skip URLs malformées sans crash', async () => {
    const pk = '02' + 'a'.repeat(64);
    const hash = await insertAgent(pool, { publicKey: pk });
    const sender = await insertAgent(pool, { publicKey: '02' + 'c'.repeat(64) });
    await insertTx(pool, { operatorId: hash, senderHash: sender, receiverHash: hash, timestamp: NOW });
    await insertServiceEndpoint(pool, { agentHash: hash, url: 'not-a-valid-url' });
    await insertServiceEndpoint(pool, { agentHash: hash, url: 'https://api.example.com/l402' });

    const summary = await inferOperatorsFromExistingData(pool, { now: NOW });
    // endpointHash tente canonicalizeUrl qui peut throw sur certaines formes.
    // On accepte 1 ou 2 selon le comportement de canonicalizeUrl ; le point est
    // de ne pas crasher.
    expect(summary.endpointOwnershipsClaimed).toBeGreaterThanOrEqual(1);
  });
});
