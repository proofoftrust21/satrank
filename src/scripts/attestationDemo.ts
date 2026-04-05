#!/usr/bin/env tsx
// End-to-end attestation demo — shows score impact of an attestation
// Usage: npx tsx src/scripts/attestationDemo.ts

import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { ScoringService } from '../services/scoringService';
import { AttestationService } from '../services/attestationService';
import { sha256 } from '../utils/crypto';
import type { Agent, Transaction } from '../types';

// --- Setup: in-memory DB ---

const db = new Database(':memory:');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
runMigrations(db);

const agentRepo = new AgentRepository(db);
const txRepo = new TransactionRepository(db);
const attestationRepo = new AttestationRepository(db);
const snapshotRepo = new SnapshotRepository(db);
const scoring = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo);
const attestationService = new AttestationService(attestationRepo, agentRepo, txRepo, db);

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

// --- Create Alice and Bob ---

const alice: Agent = {
  public_key_hash: sha256('alice-demo-pubkey'),
  public_key: 'alice-demo-pubkey',
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
  query_count: 0,
};

const bob: Agent = {
  public_key_hash: sha256('bob-demo-pubkey'),
  public_key: 'bob-demo-pubkey',
  alias: 'Bob',
  first_seen: NOW - 60 * DAY,
  last_seen: NOW - 2 * DAY,
  source: 'observer_protocol',
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
  query_count: 0,
};

agentRepo.insert(alice);
agentRepo.insert(bob);

// Create a verified transaction between Alice (sender) and Bob (receiver)
const txId = uuid();
const tx: Transaction = {
  tx_id: txId,
  sender_hash: alice.public_key_hash,
  receiver_hash: bob.public_key_hash,
  amount_bucket: 'medium',
  timestamp: NOW - 5 * DAY,
  payment_hash: sha256('demo-payment-hash'),
  preimage: sha256('demo-preimage'),
  status: 'verified',
  protocol: 'l402',
};
txRepo.insert(tx);

console.log('=== SatRank Attestation Demo ===\n');
console.log(`Alice: ${alice.alias} (${alice.public_key_hash.slice(0, 16)}...)`);
console.log(`Bob:   ${bob.alias} (${bob.public_key_hash.slice(0, 16)}...)`);
console.log(`Transaction: ${txId} (Alice → Bob, medium, verified)\n`);

// --- Score BEFORE attestation ---

const scoreBefore = scoring.computeScore(bob.public_key_hash);
console.log('--- Bob\'s score BEFORE attestation ---');
console.log(`  Total: ${scoreBefore.total}`);
console.log(`  Components:`);
console.log(`    Volume:     ${scoreBefore.components.volume}`);
console.log(`    Reputation: ${scoreBefore.components.reputation}`);
console.log(`    Seniority:  ${scoreBefore.components.seniority}`);
console.log(`    Regularity: ${scoreBefore.components.regularity}`);
console.log(`    Diversity:  ${scoreBefore.components.diversity}`);

// --- Alice attests Bob ---

console.log('\n--- Alice attests Bob (score: 85, tags: ["reliable", "fast"]) ---');

const attestation = attestationService.create({
  txId,
  attesterHash: alice.public_key_hash,
  subjectHash: bob.public_key_hash,
  score: 85,
  tags: ['reliable', 'fast'],
});

console.log(`  Attestation ID: ${attestation.attestation_id}`);
console.log(`  Timestamp: ${new Date(attestation.timestamp * 1000).toISOString()}`);

// --- Score AFTER attestation ---

const scoreAfter = scoring.computeScore(bob.public_key_hash);
console.log('\n--- Bob\'s score AFTER attestation ---');
console.log(`  Total: ${scoreAfter.total}`);
console.log(`  Components:`);
console.log(`    Volume:     ${scoreAfter.components.volume}`);
console.log(`    Reputation: ${scoreAfter.components.reputation}`);
console.log(`    Seniority:  ${scoreAfter.components.seniority}`);
console.log(`    Regularity: ${scoreAfter.components.regularity}`);
console.log(`    Diversity:  ${scoreAfter.components.diversity}`);

// --- Delta ---

const delta = scoreAfter.total - scoreBefore.total;
console.log(`\n--- Delta ---`);
console.log(`  Score change: ${scoreBefore.total} → ${scoreAfter.total} (${delta >= 0 ? '+' : ''}${delta})`);

const repDelta = scoreAfter.components.reputation - scoreBefore.components.reputation;
if (repDelta !== 0) {
  console.log(`  Reputation component: ${scoreBefore.components.reputation} → ${scoreAfter.components.reputation} (${repDelta >= 0 ? '+' : ''}${repDelta})`);
}

console.log('\nDone.\n');
db.close();
