// Realistic data generator for SatRank
// 50 agents, 2000 transactions, 800 attestations, including suspect agents
import { v4 as uuid } from 'uuid';
import { getDatabase } from './connection';
import { runMigrations } from './migrations';
import { sha256 } from '../utils/crypto';
import type { Agent, Transaction, Attestation, AgentSource, AmountBucket, TransactionStatus, PaymentProtocol } from '../types';

// Utilities
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function weightedPick<T>(items: T[], weights: number[]): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

// Time window: 6 months before now
const NOW = Math.floor(Date.now() / 1000);
const SIX_MONTHS = 180 * 86400;
const START = NOW - SIX_MONTHS;

// Agent profiles — each tells a story
interface AgentProfile {
  alias: string | null;
  source: AgentSource;
  ageRatio: number;       // 0-1, proportion of the 6-month window the agent has been active
  activityLevel: number;  // 0-1, relative activity frequency
  reliability: number;    // 0-1, proportion of verified transactions
  isSuspect: boolean;
}

const profiles: AgentProfile[] = [
  // === Veteran highly-active agents (top performers) ===
  { alias: 'atlas-prime', source: 'observer_protocol', ageRatio: 1.0, activityLevel: 1.0, reliability: 0.98, isSuspect: false },
  { alias: 'sentinel-42', source: 'observer_protocol', ageRatio: 0.95, activityLevel: 0.9, reliability: 0.97, isSuspect: false },
  { alias: 'nexus-alpha', source: '4tress', ageRatio: 0.9, activityLevel: 0.85, reliability: 0.96, isSuspect: false },
  { alias: 'oracle-one', source: 'lightning_graph', ageRatio: 0.88, activityLevel: 0.8, reliability: 0.95, isSuspect: false },
  { alias: 'phantom-net', source: 'observer_protocol', ageRatio: 0.85, activityLevel: 0.75, reliability: 0.94, isSuspect: false },

  // === Active and reliable agents (mid-tier) ===
  { alias: 'bolt-runner', source: '4tress', ageRatio: 0.7, activityLevel: 0.6, reliability: 0.92, isSuspect: false },
  { alias: 'spark-agent', source: 'observer_protocol', ageRatio: 0.65, activityLevel: 0.55, reliability: 0.90, isSuspect: false },
  { alias: 'lumen-pay', source: 'lightning_graph', ageRatio: 0.6, activityLevel: 0.5, reliability: 0.91, isSuspect: false },
  { alias: 'circuit-x', source: '4tress', ageRatio: 0.55, activityLevel: 0.5, reliability: 0.89, isSuspect: false },
  { alias: 'relay-hub', source: 'observer_protocol', ageRatio: 0.5, activityLevel: 0.45, reliability: 0.88, isSuspect: false },
  { alias: 'node-forge', source: 'lightning_graph', ageRatio: 0.6, activityLevel: 0.4, reliability: 0.90, isSuspect: false },
  { alias: 'pulse-ai', source: 'observer_protocol', ageRatio: 0.55, activityLevel: 0.35, reliability: 0.87, isSuspect: false },
  { alias: 'echo-pay', source: '4tress', ageRatio: 0.5, activityLevel: 0.35, reliability: 0.85, isSuspect: false },
  { alias: 'vector-9', source: 'observer_protocol', ageRatio: 0.45, activityLevel: 0.3, reliability: 0.86, isSuspect: false },
  { alias: 'sigma-trade', source: 'lightning_graph', ageRatio: 0.4, activityLevel: 0.3, reliability: 0.84, isSuspect: false },

  // === Regular but less active agents ===
  { alias: 'delta-flow', source: '4tress', ageRatio: 0.7, activityLevel: 0.2, reliability: 0.92, isSuspect: false },
  { alias: 'micro-sat', source: 'observer_protocol', ageRatio: 0.6, activityLevel: 0.15, reliability: 0.88, isSuspect: false },
  { alias: 'neon-link', source: 'lightning_graph', ageRatio: 0.5, activityLevel: 0.15, reliability: 0.85, isSuspect: false },
  { alias: 'hexa-route', source: '4tress', ageRatio: 0.45, activityLevel: 0.12, reliability: 0.83, isSuspect: false },
  { alias: 'swift-chan', source: 'observer_protocol', ageRatio: 0.4, activityLevel: 0.1, reliability: 0.80, isSuspect: false },

  // === New agents (recently onboarded) ===
  { alias: 'nova-2024', source: 'observer_protocol', ageRatio: 0.1, activityLevel: 0.4, reliability: 0.82, isSuspect: false },
  { alias: 'fresh-bolt', source: '4tress', ageRatio: 0.08, activityLevel: 0.3, reliability: 0.78, isSuspect: false },
  { alias: 'zap-start', source: 'lightning_graph', ageRatio: 0.05, activityLevel: 0.25, reliability: 0.75, isSuspect: false },
  { alias: 'init-agent', source: 'observer_protocol', ageRatio: 0.04, activityLevel: 0.2, reliability: 0.70, isSuspect: false },
  { alias: 'baby-node', source: 'manual', ageRatio: 0.03, activityLevel: 0.15, reliability: 0.65, isSuspect: false },

  // === Dormant agents (active then silent) ===
  { alias: 'ghost-sat', source: 'observer_protocol', ageRatio: 0.8, activityLevel: 0.02, reliability: 0.75, isSuspect: false },
  { alias: 'sleep-net', source: '4tress', ageRatio: 0.7, activityLevel: 0.01, reliability: 0.70, isSuspect: false },
  { alias: 'idle-one', source: 'lightning_graph', ageRatio: 0.6, activityLevel: 0.01, reliability: 0.68, isSuspect: false },

  // === Irregular agents (activity bursts) ===
  { alias: 'burst-pay', source: 'observer_protocol', ageRatio: 0.5, activityLevel: 0.3, reliability: 0.60, isSuspect: false },
  { alias: 'spike-run', source: '4tress', ageRatio: 0.4, activityLevel: 0.25, reliability: 0.55, isSuspect: false },

  // === Suspect agents — mutual attestation loops ===
  { alias: 'shill-alpha', source: 'manual', ageRatio: 0.3, activityLevel: 0.5, reliability: 0.50, isSuspect: true },
  { alias: 'shill-beta', source: 'manual', ageRatio: 0.3, activityLevel: 0.5, reliability: 0.48, isSuspect: true },
  { alias: 'shill-gamma', source: 'manual', ageRatio: 0.25, activityLevel: 0.45, reliability: 0.45, isSuspect: true },
  { alias: 'wash-trader', source: 'manual', ageRatio: 0.2, activityLevel: 0.6, reliability: 0.40, isSuspect: true },

  // === Agents with little data ===
  { alias: 'anon-001', source: 'lightning_graph', ageRatio: 0.15, activityLevel: 0.05, reliability: 0.50, isSuspect: false },
  { alias: 'anon-002', source: 'lightning_graph', ageRatio: 0.1, activityLevel: 0.03, reliability: 0.45, isSuspect: false },
  { alias: null, source: 'lightning_graph', ageRatio: 0.2, activityLevel: 0.08, reliability: 0.55, isSuspect: false },
  { alias: null, source: 'lightning_graph', ageRatio: 0.12, activityLevel: 0.04, reliability: 0.50, isSuspect: false },
  { alias: null, source: 'observer_protocol', ageRatio: 0.08, activityLevel: 0.02, reliability: 0.40, isSuspect: false },

  // === Additional agents to reach 50 ===
  { alias: 'grid-sync', source: 'observer_protocol', ageRatio: 0.35, activityLevel: 0.2, reliability: 0.82, isSuspect: false },
  { alias: 'flux-pay', source: '4tress', ageRatio: 0.3, activityLevel: 0.18, reliability: 0.79, isSuspect: false },
  { alias: 'core-beam', source: 'lightning_graph', ageRatio: 0.25, activityLevel: 0.15, reliability: 0.76, isSuspect: false },
  { alias: 'arc-light', source: 'observer_protocol', ageRatio: 0.4, activityLevel: 0.22, reliability: 0.84, isSuspect: false },
  { alias: 'turbo-sat', source: '4tress', ageRatio: 0.35, activityLevel: 0.2, reliability: 0.81, isSuspect: false },
  { alias: 'deep-route', source: 'lightning_graph', ageRatio: 0.5, activityLevel: 0.25, reliability: 0.86, isSuspect: false },
  { alias: 'hyper-node', source: 'observer_protocol', ageRatio: 0.45, activityLevel: 0.22, reliability: 0.83, isSuspect: false },
  { alias: 'quantum-ln', source: '4tress', ageRatio: 0.38, activityLevel: 0.18, reliability: 0.80, isSuspect: false },
  { alias: 'zero-hop', source: 'lightning_graph', ageRatio: 0.33, activityLevel: 0.15, reliability: 0.77, isSuspect: false },
  { alias: 'edge-agent', source: 'observer_protocol', ageRatio: 0.28, activityLevel: 0.12, reliability: 0.74, isSuspect: false },
  { alias: 'proto-sat', source: '4tress', ageRatio: 0.22, activityLevel: 0.1, reliability: 0.72, isSuspect: false },
];

function generateAgents(): Agent[] {
  return profiles.map((p, i) => {
    const firstSeen = START + Math.floor((1 - p.ageRatio) * SIX_MONTHS);
    const lastSeen = p.activityLevel < 0.03
      ? firstSeen + Math.floor(p.ageRatio * SIX_MONTHS * 0.3) // Dormant: stops early
      : NOW - randomInt(0, 3 * 86400); // Recently active

    return {
      public_key_hash: sha256(`agent-${i}-${p.alias || 'anon'}`),
      alias: p.alias || null,
      first_seen: firstSeen,
      last_seen: lastSeen,
      source: p.source,
      total_transactions: 0,
      total_attestations_received: 0,
      avg_score: 0,
      capacity_sats: null,
    };
  });
}

function generateTransactions(agents: Agent[]): Transaction[] {
  const transactions: Transaction[] = [];
  // Realistic distribution: more active agents generate more transactions
  const activityWeights = profiles.map(p => p.activityLevel);

  for (let i = 0; i < 2000; i++) {
    const senderIdx = weightedPickIndex(activityWeights);
    let receiverIdx = weightedPickIndex(activityWeights);
    // Avoid self-transaction
    while (receiverIdx === senderIdx) {
      receiverIdx = weightedPickIndex(activityWeights);
    }

    const sender = agents[senderIdx];
    const receiver = agents[receiverIdx];
    const profile = profiles[senderIdx];

    // Realistic timestamp within the agent's activity window
    const txWindow = Math.min(sender.last_seen, NOW) - sender.first_seen;
    const timestamp = sender.first_seen + randomInt(0, Math.max(txWindow, 1));

    // Status weighted by profile reliability
    const statusRoll = Math.random();
    let status: TransactionStatus;
    if (statusRoll < profile.reliability) status = 'verified';
    else if (statusRoll < profile.reliability + 0.05) status = 'pending';
    else if (statusRoll < profile.reliability + 0.08) status = 'failed';
    else status = 'disputed';

    const tx: Transaction = {
      tx_id: uuid(),
      sender_hash: sender.public_key_hash,
      receiver_hash: receiver.public_key_hash,
      amount_bucket: weightedPick<AmountBucket>(
        ['micro', 'small', 'medium', 'large'],
        [40, 35, 20, 5],
      ),
      timestamp,
      payment_hash: sha256(`payment-${i}-${timestamp}`),
      preimage: status === 'verified' ? sha256(`preimage-${i}`) : null,
      status,
      protocol: weightedPick<PaymentProtocol>(['l402', 'keysend', 'bolt11'], [50, 30, 20]),
    };
    transactions.push(tx);
  }

  return transactions;
}

function weightedPickIndex(weights: number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

function generateAttestations(agents: Agent[], transactions: Transaction[]): Attestation[] {
  const attestations: Attestation[] = [];
  const suspectIndices = profiles.map((p, i) => p.isSuspect ? i : -1).filter(i => i >= 0);

  // Track (tx_id, attester_hash) pairs to respect the UNIQUE constraint
  const seen = new Set<string>();
  function isDuplicate(txId: string, attesterHash: string): boolean {
    const key = `${txId}:${attesterHash}`;
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  }

  // Normal attestations: based on real transactions
  const verifiedTxs = transactions.filter(t => t.status === 'verified');
  for (let i = 0; i < verifiedTxs.length && attestations.length < 650; i++) {
    const tx = verifiedTxs[i];

    // Receiver attests sender (or vice versa)
    const isReceiverAttesting = Math.random() > 0.3;
    const attesterHash = isReceiverAttesting ? tx.receiver_hash : tx.sender_hash;
    const subjectHash = isReceiverAttesting ? tx.sender_hash : tx.receiver_hash;

    if (isDuplicate(tx.tx_id, attesterHash)) continue;

    const baseScore = randomInt(65, 100);
    const tags = [];
    if (baseScore > 90) tags.push('reliable');
    if (Math.random() > 0.5) tags.push('fast');
    if (Math.random() > 0.7) tags.push('accurate');

    attestations.push({
      attestation_id: uuid(),
      tx_id: tx.tx_id,
      attester_hash: attesterHash,
      subject_hash: subjectHash,
      score: baseScore,
      tags: JSON.stringify(tags),
      evidence_hash: Math.random() > 0.3 ? sha256(`evidence-${i}`) : null,
      timestamp: tx.timestamp + randomInt(60, 86400),
    });
  }

  // Some negative attestations (unhappy agents)
  for (let i = 0; i < 50; i++) {
    const tx = verifiedTxs[randomInt(0, verifiedTxs.length - 1)];
    if (isDuplicate(tx.tx_id, tx.receiver_hash)) continue;

    attestations.push({
      attestation_id: uuid(),
      tx_id: tx.tx_id,
      attester_hash: tx.receiver_hash,
      subject_hash: tx.sender_hash,
      score: randomInt(5, 35),
      tags: JSON.stringify(['slow', 'unreliable']),
      evidence_hash: sha256(`negative-evidence-${i}`),
      timestamp: tx.timestamp + randomInt(60, 86400),
    });
  }

  // Mutual attestation loops — suspect agents inflating each other
  // shill-alpha <-> shill-beta <-> shill-gamma <-> wash-trader (closed loop)
  const suspectTxs = transactions.filter(t =>
    suspectIndices.some(idx => t.sender_hash === agents[idx].public_key_hash || t.receiver_hash === agents[idx].public_key_hash)
  );

  for (let i = 0; i < suspectTxs.length && i < 100; i++) {
    const fromIdx = suspectIndices[i % suspectIndices.length];
    const toIdx = suspectIndices[(i + 1) % suspectIndices.length];
    const tx = suspectTxs[i];
    const attesterHash = agents[fromIdx].public_key_hash;

    if (isDuplicate(tx.tx_id, attesterHash)) continue;

    attestations.push({
      attestation_id: uuid(),
      tx_id: tx.tx_id,
      attester_hash: attesterHash,
      subject_hash: agents[toIdx].public_key_hash,
      score: randomInt(90, 100), // Artificially high scores
      tags: JSON.stringify(['reliable', 'fast', 'accurate']),
      evidence_hash: null, // No evidence — suspicious
      timestamp: tx.timestamp + randomInt(10, 300), // Very fast — suspicious
    });
  }

  return attestations;
}

function updateAgentStats(agents: Agent[], transactions: Transaction[], attestations: Attestation[]): void {
  for (const agent of agents) {
    const h = agent.public_key_hash;
    agent.total_transactions = transactions.filter(
      t => (t.sender_hash === h || t.receiver_hash === h) && t.status === 'verified'
    ).length;
    agent.total_attestations_received = attestations.filter(a => a.subject_hash === h).length;

    const scores = attestations.filter(a => a.subject_hash === h).map(a => a.score);
    agent.avg_score = scores.length > 0
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10
      : 0;
  }
}

// === Seed execution ===
console.log('Generating SatRank data...');

const db = getDatabase();
runMigrations(db);

// Cleanup
db.exec('DELETE FROM score_snapshots');
db.exec('DELETE FROM attestations');
db.exec('DELETE FROM transactions');
db.exec('DELETE FROM agents');

const agents = generateAgents();
const transactions = generateTransactions(agents);
const attestations = generateAttestations(agents, transactions);
updateAgentStats(agents, transactions, attestations);

console.log(`  → ${agents.length} agents`);
console.log(`  → ${transactions.length} transactions`);
console.log(`  → ${attestations.length} attestations`);

// Batch insert with SQLite transactions
const insertAgent = db.prepare(`
  INSERT INTO agents (public_key_hash, alias, first_seen, last_seen, source, total_transactions, total_attestations_received, avg_score)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertTx = db.prepare(`
  INSERT INTO transactions (tx_id, sender_hash, receiver_hash, amount_bucket, timestamp, payment_hash, preimage, status, protocol)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertAttestation = db.prepare(`
  INSERT INTO attestations (attestation_id, tx_id, attester_hash, subject_hash, score, tags, evidence_hash, timestamp)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertAll = db.transaction(() => {
  for (const a of agents) {
    insertAgent.run(a.public_key_hash, a.alias, a.first_seen, a.last_seen, a.source, a.total_transactions, a.total_attestations_received, a.avg_score);
  }
  for (const t of transactions) {
    insertTx.run(t.tx_id, t.sender_hash, t.receiver_hash, t.amount_bucket, t.timestamp, t.payment_hash, t.preimage, t.status, t.protocol);
  }
  for (const att of attestations) {
    insertAttestation.run(att.attestation_id, att.tx_id, att.attester_hash, att.subject_hash, att.score, att.tags, att.evidence_hash, att.timestamp);
  }
});

insertAll();

console.log('Seed completed successfully');

// Show some stats
const suspectAliases = profiles.filter(p => p.isSuspect).map(p => p.alias);
console.log(`\nSuspect agents (mutual loops): ${suspectAliases.join(', ')}`);
console.log(`Run 'npm run dev' then query GET /agents/top to see the leaderboard`);
