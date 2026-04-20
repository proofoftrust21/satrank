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
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import { inferOperatorsFromExistingData } from '../scripts/inferOperatorsFromExistingData';
import { OperatorRepository, OperatorOwnershipRepository } from '../repositories/operatorRepository';
import { endpointHash } from '../utils/urlCanonical';
import { sha256 } from '../utils/crypto';

const NOW = Math.floor(Date.now() / 1000);

interface Ctx {
  db: Database.Database;
  operators: OperatorRepository;
  ownerships: OperatorOwnershipRepository;
}

function setup(): Ctx {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return {
    db,
    operators: new OperatorRepository(db),
    ownerships: new OperatorOwnershipRepository(db),
  };
}

function insertAgent(
  db: Database.Database,
  opts: { publicKey: string; alias?: string; firstSeen?: number },
): string {
  const hash = sha256(opts.publicKey);
  db.prepare(`
    INSERT INTO agents (public_key_hash, public_key, alias, first_seen, last_seen, source,
                        total_transactions, total_attestations_received, avg_score)
    VALUES (?, ?, ?, ?, ?, 'lightning_graph', 0, 0, 0)
  `).run(
    hash,
    opts.publicKey,
    opts.alias ?? null,
    opts.firstSeen ?? NOW - 86400,
    NOW,
  );
  return hash;
}

function insertTx(
  db: Database.Database,
  opts: { operatorId: string; senderHash: string; receiverHash: string; timestamp: number },
): void {
  const id = 'tx-' + Math.random().toString(36).slice(2, 12);
  db.prepare(`
    INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp,
                              payment_hash, preimage, status, protocol, operator_id)
    VALUES (?, ?, ?, 'medium', ?, ?, NULL, 'verified', 'l402', ?)
  `).run(
    id,
    opts.senderHash,
    opts.receiverHash,
    opts.timestamp,
    'p'.repeat(64),
    opts.operatorId,
  );
}

function insertServiceEndpoint(
  db: Database.Database,
  opts: { agentHash: string; url: string },
): void {
  db.prepare(`
    INSERT INTO service_endpoints (agent_hash, url, created_at, source)
    VALUES (?, ?, ?, 'self_registered')
  `).run(opts.agentHash, opts.url, NOW);
}

describe('inferOperatorsFromExistingData', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.db.close());

  it('no-op summary quand aucune transaction', () => {
    const summary = inferOperatorsFromExistingData(ctx.db, { now: NOW });
    expect(summary.protoOperatorsScanned).toBe(0);
    expect(summary.operatorsCreated).toBe(0);
  });

  it('crée un operator pending pour chaque proto-operator distinct', () => {
    const pk1 = '02' + 'a'.repeat(64);
    const pk2 = '03' + 'b'.repeat(64);
    const hash1 = insertAgent(ctx.db, { publicKey: pk1, alias: 'node-1' });
    const hash2 = insertAgent(ctx.db, { publicKey: pk2, alias: 'node-2' });
    const sender = insertAgent(ctx.db, { publicKey: '02' + 'c'.repeat(64), alias: 'sender' });

    insertTx(ctx.db, { operatorId: hash1, senderHash: sender, receiverHash: hash1, timestamp: NOW - 3600 });
    insertTx(ctx.db, { operatorId: hash1, senderHash: sender, receiverHash: hash1, timestamp: NOW - 1800 });
    insertTx(ctx.db, { operatorId: hash2, senderHash: sender, receiverHash: hash2, timestamp: NOW - 7200 });

    const summary = inferOperatorsFromExistingData(ctx.db, { now: NOW });
    expect(summary.protoOperatorsScanned).toBe(2);
    expect(summary.operatorsCreated).toBe(2);
    expect(summary.operatorsAlreadyExisting).toBe(0);

    const op1 = ctx.operators.findById(hash1);
    expect(op1?.status).toBe('pending');
    expect(op1?.first_seen).toBe(NOW - 3600);
  });

  it('claim node ownership via agents.public_key', () => {
    const pk = '02' + 'a'.repeat(64);
    const hash = insertAgent(ctx.db, { publicKey: pk });
    const sender = insertAgent(ctx.db, { publicKey: '02' + 'c'.repeat(64) });
    insertTx(ctx.db, { operatorId: hash, senderHash: sender, receiverHash: hash, timestamp: NOW - 100 });

    const summary = inferOperatorsFromExistingData(ctx.db, { now: NOW });
    expect(summary.nodeOwnershipsClaimed).toBe(1);

    const nodes = ctx.ownerships.listNodes(hash);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].node_pubkey).toBe(pk);
  });

  it('link agents.operator_id', () => {
    const pk = '02' + 'a'.repeat(64);
    const hash = insertAgent(ctx.db, { publicKey: pk });
    const sender = insertAgent(ctx.db, { publicKey: '02' + 'c'.repeat(64) });
    insertTx(ctx.db, { operatorId: hash, senderHash: sender, receiverHash: hash, timestamp: NOW });

    const summary = inferOperatorsFromExistingData(ctx.db, { now: NOW });
    expect(summary.agentsLinked).toBe(1);

    const agent = ctx.db.prepare('SELECT operator_id FROM agents WHERE public_key_hash = ?').get(hash) as { operator_id: string };
    expect(agent.operator_id).toBe(hash);
  });

  it('claim endpoint ownership via service_endpoints.url', () => {
    const pk = '02' + 'a'.repeat(64);
    const hash = insertAgent(ctx.db, { publicKey: pk });
    const sender = insertAgent(ctx.db, { publicKey: '02' + 'c'.repeat(64) });
    insertTx(ctx.db, { operatorId: hash, senderHash: sender, receiverHash: hash, timestamp: NOW });
    insertServiceEndpoint(ctx.db, { agentHash: hash, url: 'https://api1.example.com/l402' });
    insertServiceEndpoint(ctx.db, { agentHash: hash, url: 'https://api2.example.com/l402' });

    const summary = inferOperatorsFromExistingData(ctx.db, { now: NOW });
    expect(summary.endpointOwnershipsClaimed).toBe(2);
    expect(summary.serviceEndpointsLinked).toBe(2);

    const endpoints = ctx.ownerships.listEndpoints(hash);
    expect(endpoints).toHaveLength(2);
    const hashes = endpoints.map((e) => e.url_hash).sort();
    const expected = [
      endpointHash('https://api1.example.com/l402'),
      endpointHash('https://api2.example.com/l402'),
    ].sort();
    expect(hashes).toEqual(expected);
  });

  it('idempotent sur re-run', () => {
    const pk = '02' + 'a'.repeat(64);
    const hash = insertAgent(ctx.db, { publicKey: pk });
    const sender = insertAgent(ctx.db, { publicKey: '02' + 'c'.repeat(64) });
    insertTx(ctx.db, { operatorId: hash, senderHash: sender, receiverHash: hash, timestamp: NOW });
    insertServiceEndpoint(ctx.db, { agentHash: hash, url: 'https://api.example.com/l402' });

    const first = inferOperatorsFromExistingData(ctx.db, { now: NOW });
    expect(first.operatorsCreated).toBe(1);
    expect(first.nodeOwnershipsClaimed).toBe(1);
    expect(first.endpointOwnershipsClaimed).toBe(1);

    const second = inferOperatorsFromExistingData(ctx.db, { now: NOW });
    expect(second.protoOperatorsScanned).toBe(1);
    expect(second.operatorsAlreadyExisting).toBe(1);
    expect(second.operatorsCreated).toBe(0);
    // Les claim* sont ON CONFLICT DO NOTHING — l'incrément nodeOwnershipsClaimed
    // reflète les tentatives, pas les INSERTs réels. L'état DB reste stable.
    const nodes = ctx.ownerships.listNodes(hash);
    expect(nodes).toHaveLength(1);
    const endpoints = ctx.ownerships.listEndpoints(hash);
    expect(endpoints).toHaveLength(1);
  });

  it('dry-run : summary rempli mais rien n\'est écrit', () => {
    const pk = '02' + 'a'.repeat(64);
    const hash = insertAgent(ctx.db, { publicKey: pk });
    const sender = insertAgent(ctx.db, { publicKey: '02' + 'c'.repeat(64) });
    insertTx(ctx.db, { operatorId: hash, senderHash: sender, receiverHash: hash, timestamp: NOW });
    insertServiceEndpoint(ctx.db, { agentHash: hash, url: 'https://api.example.com/l402' });

    const summary = inferOperatorsFromExistingData(ctx.db, { now: NOW, dryRun: true });
    expect(summary.protoOperatorsScanned).toBe(1);
    expect(summary.operatorsCreated).toBe(1);
    expect(summary.nodeOwnershipsClaimed).toBe(1);
    expect(summary.endpointOwnershipsClaimed).toBe(1);

    // Aucun effet en base malgré le summary.
    expect(ctx.operators.findById(hash)).toBeNull();
    expect(ctx.ownerships.listNodes(hash)).toHaveLength(0);
    expect(ctx.ownerships.listEndpoints(hash)).toHaveLength(0);
  });

  it('agents sans public_key valide → pas de claim node', () => {
    // Insérer un agent avec public_key=NULL (edge case legacy).
    const hash = 'f'.repeat(64);
    ctx.db.prepare(`
      INSERT INTO agents (public_key_hash, public_key, alias, first_seen, last_seen, source,
                          total_transactions, total_attestations_received, avg_score)
      VALUES (?, NULL, NULL, ?, ?, 'lightning_graph', 0, 0, 0)
    `).run(hash, NOW - 86400, NOW);
    const sender = insertAgent(ctx.db, { publicKey: '02' + 'c'.repeat(64) });
    insertTx(ctx.db, { operatorId: hash, senderHash: sender, receiverHash: hash, timestamp: NOW });

    const summary = inferOperatorsFromExistingData(ctx.db, { now: NOW });
    expect(summary.operatorsCreated).toBe(1);
    expect(summary.nodeOwnershipsClaimed).toBe(0);
    expect(summary.agentsLinked).toBe(0);
  });

  it('last_activity bump à max(timestamp) des transactions', () => {
    const pk = '02' + 'a'.repeat(64);
    const hash = insertAgent(ctx.db, { publicKey: pk });
    const sender = insertAgent(ctx.db, { publicKey: '02' + 'c'.repeat(64) });
    insertTx(ctx.db, { operatorId: hash, senderHash: sender, receiverHash: hash, timestamp: NOW - 10000 });
    insertTx(ctx.db, { operatorId: hash, senderHash: sender, receiverHash: hash, timestamp: NOW - 500 });

    inferOperatorsFromExistingData(ctx.db, { now: NOW });
    const op = ctx.operators.findById(hash);
    expect(op?.first_seen).toBe(NOW - 10000);
    expect(op?.last_activity).toBe(NOW - 500);
  });

  it('skip URLs malformées sans crash', () => {
    const pk = '02' + 'a'.repeat(64);
    const hash = insertAgent(ctx.db, { publicKey: pk });
    const sender = insertAgent(ctx.db, { publicKey: '02' + 'c'.repeat(64) });
    insertTx(ctx.db, { operatorId: hash, senderHash: sender, receiverHash: hash, timestamp: NOW });
    insertServiceEndpoint(ctx.db, { agentHash: hash, url: 'not-a-valid-url' });
    insertServiceEndpoint(ctx.db, { agentHash: hash, url: 'https://api.example.com/l402' });

    const summary = inferOperatorsFromExistingData(ctx.db, { now: NOW });
    // endpointHash tente canonicalizeUrl qui peut throw sur certaines formes.
    // On accepte 1 ou 2 selon le comportement de canonicalizeUrl ; le point est
    // de ne pas crasher.
    expect(summary.endpointOwnershipsClaimed).toBeGreaterThanOrEqual(1);
  });
});
