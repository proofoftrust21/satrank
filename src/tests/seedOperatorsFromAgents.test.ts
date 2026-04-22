// Phase 13C — tests du script seedOperatorsFromAgents.
// Le script crée un operator pending par agent ayant un public_key LN valide,
// claim l'ownership du node et des service_endpoints observés.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import { seedOperatorsFromAgents } from '../scripts/seedOperatorsFromAgents';
import { OperatorRepository, OperatorOwnershipRepository } from '../repositories/operatorRepository';
import { endpointHash } from '../utils/urlCanonical';
import { sha256 } from '../utils/crypto';

let testDb: TestDb;
const NOW = Math.floor(Date.now() / 1000);

async function insertAgent(
  pool: Pool,
  opts: { publicKey: string | null; alias?: string; firstSeen?: number; lastSeen?: number },
): Promise<string> {
  const hash = opts.publicKey !== null ? sha256(opts.publicKey) : 'f'.repeat(64);
  await pool.query(
    `INSERT INTO agents (public_key_hash, public_key, alias, first_seen, last_seen, source,
                         total_transactions, total_attestations_received, avg_score)
     VALUES ($1, $2, $3, $4, $5, 'lightning_graph', 0, 0, 0)`,
    [hash, opts.publicKey, opts.alias ?? null, opts.firstSeen ?? NOW - 86400, opts.lastSeen ?? NOW],
  );
  return hash;
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

describe('seedOperatorsFromAgents', async () => {
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

  it('no-op summary quand aucun agent', async () => {
    const summary = await seedOperatorsFromAgents(pool, { now: NOW });
    expect(summary.agentsScanned).toBe(0);
    expect(summary.operatorsCreated).toBe(0);
  });

  it('crée un operator pending pour chaque agent avec public_key LN valide', async () => {
    const pk1 = '02' + 'a'.repeat(64);
    const pk2 = '03' + 'b'.repeat(64);
    const h1 = await insertAgent(pool, { publicKey: pk1, firstSeen: NOW - 100 });
    const h2 = await insertAgent(pool, { publicKey: pk2, firstSeen: NOW - 200 });

    const summary = await seedOperatorsFromAgents(pool, { now: NOW });

    expect(summary.agentsScanned).toBe(2);
    expect(summary.agentsSkipped).toBe(0);
    expect(summary.operatorsCreated).toBe(2);
    expect(summary.nodeOwnershipsClaimed).toBe(2);
    expect(summary.agentsLinked).toBe(2);

    const op1 = await operators.findById(h1);
    expect(op1?.status).toBe('pending');
    expect(op1?.first_seen).toBe(NOW - 100);

    const op2 = await operators.findById(h2);
    expect(op2?.status).toBe('pending');
    expect(op2?.first_seen).toBe(NOW - 200);
  });

  it('claim node ownership avec le public_key littéral', async () => {
    const pk = '02' + 'a'.repeat(64);
    const h = await insertAgent(pool, { publicKey: pk });

    await seedOperatorsFromAgents(pool, { now: NOW });

    const nodes = await ownerships.listNodes(h);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].node_pubkey).toBe(pk);
  });

  it('link agents.operator_id = public_key_hash', async () => {
    const pk = '02' + 'a'.repeat(64);
    const h = await insertAgent(pool, { publicKey: pk });

    await seedOperatorsFromAgents(pool, { now: NOW });

    const { rows } = await pool.query<{ operator_id: string }>(
      'SELECT operator_id FROM agents WHERE public_key_hash = $1',
      [h],
    );
    expect(rows[0].operator_id).toBe(h);
  });

  it('claim endpoint ownership via service_endpoints observés', async () => {
    const pk = '02' + 'a'.repeat(64);
    const h = await insertAgent(pool, { publicKey: pk });
    await insertServiceEndpoint(pool, { agentHash: h, url: 'https://api1.example.com/l402' });
    await insertServiceEndpoint(pool, { agentHash: h, url: 'https://api2.example.com/l402' });

    const summary = await seedOperatorsFromAgents(pool, { now: NOW });

    expect(summary.endpointOwnershipsClaimed).toBe(2);
    expect(summary.serviceEndpointsLinked).toBe(2);

    const endpoints = await ownerships.listEndpoints(h);
    expect(endpoints.map((e) => e.url_hash).sort()).toEqual(
      [
        endpointHash('https://api1.example.com/l402'),
        endpointHash('https://api2.example.com/l402'),
      ].sort(),
    );
  });

  it('skip agents avec public_key NULL ou format invalide', async () => {
    await insertAgent(pool, { publicKey: null });
    await insertAgent(pool, { publicKey: '02short' });
    const validHash = await insertAgent(pool, { publicKey: '02' + 'a'.repeat(64) });

    const summary = await seedOperatorsFromAgents(pool, { now: NOW });

    expect(summary.agentsScanned).toBe(3);
    expect(summary.agentsSkipped).toBe(2);
    expect(summary.operatorsCreated).toBe(1);
    expect(summary.nodeOwnershipsClaimed).toBe(1);

    const valid = await operators.findById(validHash);
    expect(valid).not.toBeNull();
  });

  it('idempotent sur re-run : 0 nouveaux operators', async () => {
    const pk = '02' + 'a'.repeat(64);
    const h = await insertAgent(pool, { publicKey: pk });
    await insertServiceEndpoint(pool, { agentHash: h, url: 'https://api.example.com/l402' });

    const first = await seedOperatorsFromAgents(pool, { now: NOW });
    expect(first.operatorsCreated).toBe(1);
    expect(first.operatorsAlreadyExisting).toBe(0);

    const second = await seedOperatorsFromAgents(pool, { now: NOW });
    expect(second.operatorsCreated).toBe(0);
    expect(second.operatorsAlreadyExisting).toBe(1);

    // État DB stable : 1 node, 1 endpoint.
    expect(await ownerships.listNodes(h)).toHaveLength(1);
    expect(await ownerships.listEndpoints(h)).toHaveLength(1);
  });

  it('dry-run : summary rempli, aucune écriture DB', async () => {
    const pk = '02' + 'a'.repeat(64);
    const h = await insertAgent(pool, { publicKey: pk });
    await insertServiceEndpoint(pool, { agentHash: h, url: 'https://api.example.com/l402' });

    const summary = await seedOperatorsFromAgents(pool, { now: NOW, dryRun: true });

    expect(summary.agentsScanned).toBe(1);
    expect(summary.operatorsCreated).toBe(1);
    expect(summary.nodeOwnershipsClaimed).toBe(1);
    expect(summary.endpointOwnershipsClaimed).toBe(1);

    expect(await operators.findById(h)).toBeNull();
    expect(await ownerships.listNodes(h)).toHaveLength(0);
    expect(await ownerships.listEndpoints(h)).toHaveLength(0);
  });

  it('first_seen/last_activity dérivés de agents.first_seen et last_seen', async () => {
    const pk = '02' + 'a'.repeat(64);
    const h = await insertAgent(pool, {
      publicKey: pk,
      firstSeen: NOW - 10000,
      lastSeen: NOW - 500,
    });

    await seedOperatorsFromAgents(pool, { now: NOW });

    const op = await operators.findById(h);
    expect(op?.first_seen).toBe(NOW - 10000);
    expect(op?.last_activity).toBe(NOW - 500);
  });

  it('skip URLs malformées sans crash', async () => {
    const pk = '02' + 'a'.repeat(64);
    const h = await insertAgent(pool, { publicKey: pk });
    await insertServiceEndpoint(pool, { agentHash: h, url: 'not-a-valid-url' });
    await insertServiceEndpoint(pool, { agentHash: h, url: 'https://api.example.com/l402' });

    const summary = await seedOperatorsFromAgents(pool, { now: NOW });

    expect(summary.endpointOwnershipsClaimed).toBeGreaterThanOrEqual(1);
    expect(summary.operatorsCreated).toBe(1);
  });
});
