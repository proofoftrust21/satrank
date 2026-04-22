#!/usr/bin/env tsx
// End-to-end attestation demo — shows score impact of an attestation
// Usage: npx tsx src/scripts/attestationDemo.ts
//
// Phase 12B: runs against the Postgres pool configured via DATABASE_URL.
// The demo inserts its own fixtures (Alice, Bob, one transaction) and
// cleans them up at the end so it can be replayed idempotently.

import { v4 as uuid } from 'uuid';
import { getPool, closePools } from '../database/connection';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { ScoringService } from '../services/scoringService';
import { AttestationService } from '../services/attestationService';
import { sha256 } from '../utils/crypto';
import type { Agent, Transaction } from '../types';

async function main(): Promise<void> {
  const pool = getPool();
  await runMigrations(pool);

  const agentRepo = new AgentRepository(pool);
  const txRepo = new TransactionRepository(pool);
  const attestationRepo = new AttestationRepository(pool);
  const snapshotRepo = new SnapshotRepository(pool);
  const scoring = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo, pool);
  const attestationService = new AttestationService(attestationRepo, agentRepo, txRepo, pool);

  const NOW = Math.floor(Date.now() / 1000);
  const DAY = 86400;

  // Seed: Alice and Bob. Use a per-run suffix so we never collide with
  // an existing fixture from a previous invocation or from tests.
  const runTag = `demo-${Date.now().toString(36)}`;
  const alice: Agent = {
    public_key_hash: sha256(`alice-${runTag}`),
    public_key: `alice-${runTag}-pubkey`,
    alias: 'Alice',
    first_seen: NOW - 120 * DAY,
    last_seen: NOW - DAY,
    source: 'lightning_graph',
    total_transactions: 200,
    total_attestations_received: 0,
    avg_score: 0,
    capacity_sats: 2_000_000_000,
    positive_ratings: 15,
    negative_ratings: 1,
    lnplus_rank: 6,
    hubness_rank: 20,
    betweenness_rank: 40,
    hopness_rank: 10,
    unique_peers: null,
    last_queried_at: null,
    query_count: 0,
  };

  const bob: Agent = {
    public_key_hash: sha256(`bob-${runTag}`),
    public_key: `bob-${runTag}-pubkey`,
    alias: 'Bob',
    first_seen: NOW - 60 * DAY,
    last_seen: NOW - 2 * DAY,
    source: 'attestation',
    total_transactions: 30,
    total_attestations_received: 0,
    avg_score: 0,
    capacity_sats: 500_000_000,
    positive_ratings: 3,
    negative_ratings: 0,
    lnplus_rank: 3,
    hubness_rank: 5,
    betweenness_rank: 8,
    hopness_rank: 2,
    unique_peers: null,
    last_queried_at: null,
    query_count: 0,
  };

  await agentRepo.insert(alice);
  await agentRepo.insert(bob);

  const txId = uuid();
  const tx: Transaction = {
    tx_id: txId,
    sender_hash: alice.public_key_hash,
    receiver_hash: bob.public_key_hash,
    amount_bucket: 'medium',
    timestamp: NOW - 5 * DAY,
    payment_hash: sha256(`demo-payment-${runTag}`),
    preimage: sha256(`demo-preimage-${runTag}`),
    status: 'verified',
    protocol: 'l402',
  };
  await txRepo.insert(tx);

  console.log('=== SatRank Attestation Demo ===\n');
  console.log(`Alice: ${alice.alias} (${alice.public_key_hash.slice(0, 16)}...)`);
  console.log(`Bob:   ${bob.alias} (${bob.public_key_hash.slice(0, 16)}...)`);
  console.log(`Transaction: ${txId} (Alice → Bob, medium, verified)\n`);

  const scoreBefore = await scoring.computeScore(bob.public_key_hash);
  console.log('--- Bob\'s score BEFORE attestation ---');
  console.log(`  Total: ${scoreBefore.total}`);
  console.log(`  Components:`);
  console.log(`    Volume:     ${scoreBefore.components.volume}`);
  console.log(`    Reputation: ${scoreBefore.components.reputation}`);
  console.log(`    Seniority:  ${scoreBefore.components.seniority}`);
  console.log(`    Regularity: ${scoreBefore.components.regularity}`);
  console.log(`    Diversity:  ${scoreBefore.components.diversity}`);

  console.log('\n--- Alice attests Bob (score: 85, tags: ["reliable", "fast"]) ---');

  const attestation = await attestationService.create({
    txId,
    attesterHash: alice.public_key_hash,
    subjectHash: bob.public_key_hash,
    score: 85,
    tags: ['reliable', 'fast'],
  });

  console.log(`  Attestation ID: ${attestation.attestation_id}`);
  console.log(`  Timestamp: ${new Date(attestation.timestamp * 1000).toISOString()}`);

  const scoreAfter = await scoring.computeScore(bob.public_key_hash);
  console.log('\n--- Bob\'s score AFTER attestation ---');
  console.log(`  Total: ${scoreAfter.total}`);
  console.log(`  Components:`);
  console.log(`    Volume:     ${scoreAfter.components.volume}`);
  console.log(`    Reputation: ${scoreAfter.components.reputation}`);
  console.log(`    Seniority:  ${scoreAfter.components.seniority}`);
  console.log(`    Regularity: ${scoreAfter.components.regularity}`);
  console.log(`    Diversity:  ${scoreAfter.components.diversity}`);

  const delta = scoreAfter.total - scoreBefore.total;
  console.log('\n--- Delta ---');
  console.log(`  Score change: ${scoreBefore.total} → ${scoreAfter.total} (${delta >= 0 ? '+' : ''}${delta})`);

  const repDelta = scoreAfter.components.reputation - scoreBefore.components.reputation;
  if (repDelta !== 0) {
    console.log(`  Reputation component: ${scoreBefore.components.reputation} → ${scoreAfter.components.reputation} (${repDelta >= 0 ? '+' : ''}${repDelta})`);
  }

  // Cleanup — demo keeps the DB clean so it can be re-run idempotently.
  await pool.query(
    'DELETE FROM attestations WHERE attester_hash = $1 OR subject_hash = $2',
    [alice.public_key_hash, bob.public_key_hash],
  );
  await pool.query('DELETE FROM transactions WHERE tx_id = $1', [txId]);
  await pool.query(
    'DELETE FROM agents WHERE public_key_hash IN ($1, $2)',
    [alice.public_key_hash, bob.public_key_hash],
  );

  console.log('\nDone.\n');
  await closePools();
}

main().catch(async (err) => {
  console.error(err);
  await closePools();
  process.exit(1);
});
