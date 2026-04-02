#!/usr/bin/env tsx
// Calibration report — scores all agents, prints distribution and anomalies
// Usage: npx tsx src/scripts/calibrationReport.ts

import Database from 'better-sqlite3';
import path from 'path';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { ScoringService } from '../services/scoringService';
import type { Agent } from '../types';

// --- Setup ---

const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'satrank.db');

let db: Database.Database;
try {
  db = new Database(dbPath);
} catch (err) {
  console.error(`Cannot open database at ${dbPath}`);
  console.error('Set DB_PATH or run from the project root with a seeded database.');
  process.exit(1);
}

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
runMigrations(db);

const agentRepo = new AgentRepository(db);
const txRepo = new TransactionRepository(db);
const attestationRepo = new AttestationRepository(db);
const snapshotRepo = new SnapshotRepository(db);
const scoring = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo);

// --- Load all agents ---

const allAgents = db.prepare('SELECT * FROM agents ORDER BY avg_score DESC').all() as Agent[];
console.log(`\nLoaded ${allAgents.length} agents from ${dbPath}\n`);

if (allAgents.length === 0) {
  console.log('No agents found. Run `npm run seed` first.');
  db.close();
  process.exit(0);
}

// --- Score all agents ---

interface AgentScore {
  rank: number;
  alias: string;
  score: number;
  volume: number;
  reputation: number;
  seniority: number;
  regularity: number;
  diversity: number;
  source: string;
  channels: number;
  lnpRank: number;
  hash: string;
}

const scored: AgentScore[] = [];

for (const agent of allAgents) {
  const result = scoring.computeScore(agent.public_key_hash);
  scored.push({
    rank: 0,
    alias: agent.alias || agent.public_key_hash.slice(0, 12) + '...',
    score: result.total,
    volume: result.components.volume,
    reputation: result.components.reputation,
    seniority: result.components.seniority,
    regularity: result.components.regularity,
    diversity: result.components.diversity,
    source: agent.source,
    channels: agent.total_transactions,
    lnpRank: agent.lnplus_rank,
    hash: agent.public_key_hash,
  });
}

// Sort by score descending
scored.sort((a, b) => b.score - a.score);
scored.forEach((s, i) => { s.rank = i + 1; });

// --- Print table ---

function pad(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + ' '.repeat(len - str.length);
}

function padR(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : ' '.repeat(len - str.length) + str;
}

const header = [
  padR('#', 4),
  pad('Alias', 20),
  padR('Score', 6),
  padR('Vol', 5),
  padR('Rep', 5),
  padR('Sen', 5),
  padR('Reg', 5),
  padR('Div', 5),
  pad('Source', 16),
  padR('Ch', 6),
  padR('LN+', 4),
].join(' | ');

console.log('='.repeat(header.length));
console.log(header);
console.log('-'.repeat(header.length));

for (const s of scored) {
  console.log([
    padR(String(s.rank), 4),
    pad(s.alias, 20),
    padR(String(s.score), 6),
    padR(String(s.volume), 5),
    padR(String(s.reputation), 5),
    padR(String(s.seniority), 5),
    padR(String(s.regularity), 5),
    padR(String(s.diversity), 5),
    pad(s.source, 16),
    padR(String(s.channels), 6),
    padR(String(s.lnpRank), 4),
  ].join(' | '));
}

console.log('='.repeat(header.length));

// --- Distribution ---

const buckets = [0, 0, 0, 0, 0]; // 0-20, 20-40, 40-60, 60-80, 80-100
for (const s of scored) {
  const idx = Math.min(4, Math.floor(s.score / 20));
  buckets[idx]++;
}

console.log('\n--- Score Distribution ---');
const labels = ['0-19', '20-39', '40-59', '60-79', '80-100'];
for (let i = 0; i < 5; i++) {
  const bar = '#'.repeat(Math.round(buckets[i] / Math.max(1, allAgents.length) * 50));
  console.log(`  ${labels[i]}: ${padR(String(buckets[i]), 4)} ${bar}`);
}
console.log(`  Total: ${allAgents.length}`);
console.log(`  Mean:  ${(scored.reduce((sum, a) => sum + a.score, 0) / scored.length).toFixed(1)}`);
console.log(`  Median: ${scored[Math.floor(scored.length / 2)].score}`);

// --- Anomalies ---

console.log('\n--- Anomalies ---');

const highScoreLowChannels = scored.filter(s => s.score > 80 && s.channels < 50);
if (highScoreLowChannels.length > 0) {
  console.log('\n  Score > 80 but < 50 channels:');
  for (const a of highScoreLowChannels) {
    console.log(`    #${a.rank} ${a.alias} — score ${a.score}, channels ${a.channels}`);
  }
} else {
  console.log('  Score > 80 but < 50 channels: none');
}

const lowScoreHighRank = scored.filter(s => s.score < 30 && s.lnpRank >= 7);
if (lowScoreHighRank.length > 0) {
  console.log('\n  Score < 30 but LN+ rank >= 7:');
  for (const a of lowScoreHighRank) {
    console.log(`    #${a.rank} ${a.alias} — score ${a.score}, LN+ rank ${a.lnpRank}`);
  }
} else {
  console.log('  Score < 30 but LN+ rank >= 7: none');
}

// Detect agents with identical scores but very different profiles
const scoreGroups = new Map<number, AgentScore[]>();
for (const s of scored) {
  const group = scoreGroups.get(s.score) || [];
  group.push(s);
  scoreGroups.set(s.score, group);
}

const duplicateScores: { score: number; agents: AgentScore[] }[] = [];
for (const [score, group] of scoreGroups) {
  if (group.length < 2) continue;
  // Check if profiles differ significantly (volume diff > 50 or reputation diff > 30)
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      const a = group[i];
      const b = group[j];
      if (Math.abs(a.volume - b.volume) > 50 || Math.abs(a.reputation - b.reputation) > 30) {
        duplicateScores.push({ score, agents: [a, b] });
      }
    }
  }
}

if (duplicateScores.length > 0) {
  console.log('\n  Identical scores with very different profiles:');
  for (const d of duplicateScores.slice(0, 10)) {
    const [a, b] = d.agents;
    console.log(`    Score ${d.score}: ${a.alias} (vol=${a.volume}, rep=${a.reputation}) vs ${b.alias} (vol=${b.volume}, rep=${b.reputation})`);
  }
} else {
  console.log('  Identical scores with very different profiles: none');
}

console.log('\nDone.\n');

db.close();
