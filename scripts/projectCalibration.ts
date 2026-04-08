#!/usr/bin/env tsx
// Dry-run projection of the v15 scoring calibration against the live SQLite DB.
//
// Reads current agents + components + probe_results, computes the NEW scores
// (multi-axis regularity, peer-based diversity, no probe bonuses), and emits
// a full before/after report without modifying the DB.
//
// Usage (run on the server, inside the crawler container or with a copy of the DB):
//   npx tsx scripts/projectCalibration.ts /var/lib/.../satrank.db /path/to/describegraph.json
//
// Arg 1: path to the SQLite file (read-only).
// Arg 2: path to a `lncli describegraph` JSON dump (used to derive unique_peers
//        for every node without touching the DB). The existing LND client in
//        the repo can produce this if you prefer — we just need the raw graph.
//
// Output:
//   1. Score histogram (0-100 bucketed) before vs after
//   2. Verdict band counts before vs after (SAFE ≥60, RISKY 30-59, UNKNOWN <30)
//   3. Top 20 nodes with old/new components + old/new totals
//   4. Largest negative deltas in the 30-60 stratum (regression check)
//   5. Count of agents at score=100 before vs after
//
// The script is deliberately standalone: no imports from the app's services
// so it runs without spinning up the full DI graph.
import Database from 'better-sqlite3';
import fs from 'node:fs';

// ---- CLI args ----
const dbPath = process.argv[2];
const graphPath = process.argv[3]; // optional
if (!dbPath) {
  console.error('Usage: projectCalibration.ts <satrank.db> [describegraph.json]');
  process.exit(1);
}

// ---- Formula constants (must match src/config/scoring.ts + scoringService) ----
const WEIGHTS = { volume: 0.25, reputation: 0.30, seniority: 0.15, regularity: 0.15, diversity: 0.15 };
const SATS_PER_BTC = 100_000_000;
const LN_DIVERSITY_LOG_BASE = 1001;
const LN_DIVERSITY_BTC_MULTIPLIER = 10;
const POPULARITY_BONUS_CAP = 10;
const POPULARITY_LOG_MULTIPLIER = 2;
const LNPLUS_BONUS_CAP = 8;
const PROBE_UNREACHABLE_PENALTY = 10;
const PROBE_FRESHNESS_TTL = 86_400;

// ---- Helpers ----
function popularityBonus(queryCount: number): number {
  if (queryCount <= 0) return 0;
  return Math.min(POPULARITY_BONUS_CAP, Math.round(Math.log2(queryCount + 1) * POPULARITY_LOG_MULTIPLIER));
}

function lnplusBonus(pos: number, neg: number): number {
  if (pos <= 0) return 0;
  const ratingsRatio = pos / (pos + neg + 1);
  return Math.min(LNPLUS_BONUS_CAP, Math.round(Math.log2(pos + 1) * ratingsRatio * 3));
}

// ---- Load unique_peers map (optional) ----
let uniquePeersByPubkey: Map<string, number> = new Map();
if (graphPath && fs.existsSync(graphPath)) {
  console.log(`Loading LND graph from ${graphPath}...`);
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8')) as {
    nodes?: Array<{ pub_key: string }>;
    edges?: Array<{ node1_pub: string; node2_pub: string }>;
  };
  const peers = new Map<string, Set<string>>();
  for (const edge of graph.edges ?? []) {
    if (!peers.has(edge.node1_pub)) peers.set(edge.node1_pub, new Set());
    if (!peers.has(edge.node2_pub)) peers.set(edge.node2_pub, new Set());
    peers.get(edge.node1_pub)!.add(edge.node2_pub);
    peers.get(edge.node2_pub)!.add(edge.node1_pub);
  }
  for (const [pub, set] of peers) uniquePeersByPubkey.set(pub, set.size);
  console.log(`Loaded unique_peers for ${uniquePeersByPubkey.size} nodes`);
} else {
  console.log('No graph dump provided — diversity will stay on the legacy BTC fallback for projection.');
}

// ---- Open DB (read-only) ----
const db = new Database(dbPath, { readonly: true });

// ---- Pull all active scored agents with their latest components ----
interface AgentRow {
  public_key_hash: string;
  public_key: string | null;
  alias: string | null;
  source: string;
  avg_score: number;
  total_transactions: number;
  capacity_sats: number | null;
  positive_ratings: number;
  negative_ratings: number;
  query_count: number;
  first_seen: number;
  last_seen: number;
  old_volume: number;
  old_reputation: number;
  old_seniority: number;
  old_regularity: number;
  old_diversity: number;
}

const rows = db.prepare(`
  SELECT
    a.public_key_hash,
    a.public_key,
    a.alias,
    a.source,
    a.avg_score,
    a.total_transactions,
    a.capacity_sats,
    a.positive_ratings,
    a.negative_ratings,
    a.query_count,
    a.first_seen,
    a.last_seen,
    CAST(json_extract(s.components, '$.volume') AS INTEGER) AS old_volume,
    CAST(json_extract(s.components, '$.reputation') AS INTEGER) AS old_reputation,
    CAST(json_extract(s.components, '$.seniority') AS INTEGER) AS old_seniority,
    CAST(json_extract(s.components, '$.regularity') AS INTEGER) AS old_regularity,
    CAST(json_extract(s.components, '$.diversity') AS INTEGER) AS old_diversity
  FROM agents a
  JOIN score_snapshots s
    ON s.agent_hash = a.public_key_hash
    AND s.computed_at = (SELECT MAX(computed_at) FROM score_snapshots WHERE agent_hash = a.public_key_hash)
  WHERE a.stale = 0 AND a.avg_score > 0
`).all() as AgentRow[];

console.log(`Loaded ${rows.length} scored active agents`);

// ---- Pull probe stats per agent (last 7 days) ----
const WINDOW = 7 * 86400;
const now = Math.floor(Date.now() / 1000);
const cutoff = now - WINDOW;

const probeAggRows = db.prepare(`
  SELECT
    target_hash,
    COUNT(*) AS total,
    SUM(CASE WHEN reachable = 1 THEN 1 ELSE 0 END) AS reachable_count,
    AVG(CASE WHEN reachable = 1 THEN latency_ms END) AS latency_mean,
    AVG(CASE WHEN reachable = 1 THEN latency_ms * latency_ms END) AS latency_mean_sq,
    COUNT(CASE WHEN reachable = 1 AND latency_ms IS NOT NULL THEN 1 END) AS latency_count,
    AVG(CASE WHEN reachable = 1 THEN hops END) AS hop_mean,
    AVG(CASE WHEN reachable = 1 THEN hops * hops END) AS hop_mean_sq,
    COUNT(CASE WHEN reachable = 1 AND hops IS NOT NULL THEN 1 END) AS hop_count
  FROM probe_results
  WHERE probed_at >= ?
  GROUP BY target_hash
`).all(cutoff) as Array<{
  target_hash: string;
  total: number;
  reachable_count: number;
  latency_mean: number | null;
  latency_mean_sq: number | null;
  latency_count: number;
  hop_mean: number | null;
  hop_mean_sq: number | null;
  hop_count: number;
}>;

const probesByTarget = new Map<string, typeof probeAggRows[0]>();
for (const r of probeAggRows) probesByTarget.set(r.target_hash, r);
console.log(`Loaded probe stats for ${probesByTarget.size} targets`);

// ---- Latest probe per agent (for unreachable penalty) ----
const latestProbeRows = db.prepare(`
  SELECT p.target_hash, p.probed_at, p.reachable
  FROM probe_results p
  JOIN (SELECT target_hash, MAX(probed_at) AS max_at FROM probe_results GROUP BY target_hash) l
    ON l.target_hash = p.target_hash AND l.max_at = p.probed_at
`).all() as Array<{ target_hash: string; probed_at: number; reachable: number }>;
const latestProbeByTarget = new Map<string, { probed_at: number; reachable: number }>();
for (const r of latestProbeRows) latestProbeByTarget.set(r.target_hash, r);

// ---- Compute NEW components for each agent ----
function computeNewRegularity(hash: string, lastSeen: number): number {
  const stats = probesByTarget.get(hash);
  if (stats && stats.total >= 3) {
    const uptime = stats.reachable_count / stats.total;

    let latencyConsistency = 0.5;
    if (stats.latency_count >= 3 && stats.latency_mean && stats.latency_mean > 0 && stats.latency_mean_sq !== null) {
      const variance = Math.max(0, stats.latency_mean_sq - stats.latency_mean * stats.latency_mean);
      const stddev = Math.sqrt(variance);
      const cv = stddev / stats.latency_mean;
      latencyConsistency = Math.exp(-cv);
    }

    let hopStability = 0.5;
    if (stats.hop_count >= 3 && stats.hop_mean !== null && stats.hop_mean_sq !== null) {
      const variance = Math.max(0, stats.hop_mean_sq - stats.hop_mean * stats.hop_mean);
      const stddev = Math.sqrt(variance);
      hopStability = 1 - Math.min(1, stddev / 3);
    }

    return Math.min(100, Math.round(uptime * 70 + latencyConsistency * 20 + hopStability * 10));
  }
  // Gossip fallback
  const days = (now - lastSeen) / 86400;
  if (days <= 0) return 100;
  return Math.min(100, Math.round(100 * Math.exp(-days / 90)));
}

function computeNewDiversity(capacitySats: number | null, uniquePeers: number | undefined): number {
  if (uniquePeers !== undefined && uniquePeers > 0) {
    return Math.min(100, Math.round(Math.log(uniquePeers + 1) / Math.log(501) * 100));
  }
  if (!capacitySats || capacitySats <= 0) return 0;
  const btc = capacitySats / SATS_PER_BTC;
  const score = (Math.log10(btc * LN_DIVERSITY_BTC_MULTIPLIER + 1) / Math.log10(LN_DIVERSITY_LOG_BASE)) * 100;
  return Math.min(100, Math.round(score));
}

interface Projected {
  hash: string;
  alias: string | null;
  source: string;
  old_total: number;
  old_components: { volume: number; reputation: number; seniority: number; regularity: number; diversity: number };
  new_total: number;
  new_components: { volume: number; reputation: number; seniority: number; regularity: number; diversity: number };
  unique_peers: number | undefined;
}

const projected: Projected[] = [];
for (const row of rows) {
  const unique_peers = row.public_key ? uniquePeersByPubkey.get(row.public_key) : undefined;
  const isLightning = row.source === 'lightning_graph';

  const old_components = {
    volume: row.old_volume,
    reputation: row.old_reputation,
    seniority: row.old_seniority,
    regularity: row.old_regularity,
    diversity: row.old_diversity,
  };

  // For observer_protocol / manual / 4tress agents, this calibration is a no-op.
  // Their regularity uses tx interval CV and their diversity uses unique counterparties;
  // neither is affected by v15. The probe crawler only probes lightning_graph agents,
  // so they can't even get the old probe bonuses we removed. new_total = old_total.
  if (!isLightning) {
    projected.push({
      hash: row.public_key_hash,
      alias: row.alias,
      source: row.source,
      old_total: row.avg_score,
      old_components,
      new_total: row.avg_score,
      new_components: old_components,
      unique_peers: undefined,
    });
    continue;
  }

  // Lightning graph path — the one this calibration changes
  const new_regularity = computeNewRegularity(row.public_key_hash, row.last_seen);
  const new_diversity = computeNewDiversity(row.capacity_sats, unique_peers);
  const new_components = {
    volume: row.old_volume,
    reputation: row.old_reputation,
    seniority: row.old_seniority,
    regularity: new_regularity,
    diversity: new_diversity,
  };

  let new_total = Math.round(
    new_components.volume * WEIGHTS.volume +
    new_components.reputation * WEIGHTS.reputation +
    new_components.seniority * WEIGHTS.seniority +
    new_components.regularity * WEIGHTS.regularity +
    new_components.diversity * WEIGHTS.diversity,
  );

  // Bonuses that survive the calibration: popularity (+10), LN+ ratings (+8).
  // Removed: probe low-latency (+3) and probe short-hop (+2).
  new_total = Math.min(100, new_total + popularityBonus(row.query_count));
  new_total = Math.min(100, new_total + lnplusBonus(row.positive_ratings, row.negative_ratings));

  // Unreachable penalty (preserved)
  const latest = latestProbeByTarget.get(row.public_key_hash);
  if (latest && (now - latest.probed_at) < PROBE_FRESHNESS_TTL && latest.reachable === 0) {
    new_total = Math.max(0, new_total - PROBE_UNREACHABLE_PENALTY);
  }

  projected.push({
    hash: row.public_key_hash,
    alias: row.alias,
    source: row.source,
    old_total: row.avg_score,
    old_components,
    new_total,
    new_components,
    unique_peers,
  });
}

// ---- Report ----
function histogram(values: number[], label: string): void {
  const buckets: Record<string, number> = {
    '100 (exact)': 0, '95-99': 0, '90-94': 0, '85-89': 0, '80-84': 0,
    '70-79': 0, '60-69': 0, '50-59': 0, '40-49': 0, '30-39': 0,
    '20-29': 0, '10-19': 0, '1-9': 0, '0': 0,
  };
  for (const v of values) {
    if (v === 100) buckets['100 (exact)']++;
    else if (v >= 95) buckets['95-99']++;
    else if (v >= 90) buckets['90-94']++;
    else if (v >= 85) buckets['85-89']++;
    else if (v >= 80) buckets['80-84']++;
    else if (v >= 70) buckets['70-79']++;
    else if (v >= 60) buckets['60-69']++;
    else if (v >= 50) buckets['50-59']++;
    else if (v >= 40) buckets['40-49']++;
    else if (v >= 30) buckets['30-39']++;
    else if (v >= 20) buckets['20-29']++;
    else if (v >= 10) buckets['10-19']++;
    else if (v > 0) buckets['1-9']++;
    else buckets['0']++;
  }
  console.log(`\n${label}`);
  for (const [key, value] of Object.entries(buckets)) {
    console.log(`  ${key.padEnd(12)} ${String(value).padStart(6)}`);
  }
}

const oldScores = projected.map(p => p.old_total);
const newScores = projected.map(p => p.new_total);

histogram(oldScores, 'BEFORE — score distribution');
histogram(newScores, 'AFTER  — score distribution');

function verdicts(values: number[]): { safe: number; risky: number; unknown: number } {
  let safe = 0, risky = 0, unknown = 0;
  for (const v of values) {
    if (v >= 60) safe++;
    else if (v >= 30) risky++;
    else unknown++;
  }
  return { safe, risky, unknown };
}

const oldV = verdicts(oldScores);
const newV = verdicts(newScores);
console.log('\nVerdict bands');
console.log(`  SAFE    (≥60): ${oldV.safe} → ${newV.safe}  (${newV.safe - oldV.safe >= 0 ? '+' : ''}${newV.safe - oldV.safe})`);
console.log(`  RISKY (30-59): ${oldV.risky} → ${newV.risky}  (${newV.risky - oldV.risky >= 0 ? '+' : ''}${newV.risky - oldV.risky})`);
console.log(`  UNKNOWN (<30): ${oldV.unknown} → ${newV.unknown}  (${newV.unknown - oldV.unknown >= 0 ? '+' : ''}${newV.unknown - oldV.unknown})`);

const atCapBefore = oldScores.filter(s => s === 100).length;
const atCapAfter = newScores.filter(s => s === 100).length;
console.log(`\nAgents at score=100: ${atCapBefore} → ${atCapAfter}`);

// ---- Top 20 spread (by OLD score, to see what happens to the old leaderboard) ----
const top20 = [...projected].sort((a, b) => b.old_total - a.old_total || b.new_total - a.new_total).slice(0, 20);
console.log('\nTop 20 — before and after');
console.log('alias                            old   new   Δ    old(V/R/S/Reg/D)        new(V/R/S/Reg/D)        peers');
for (const p of top20) {
  const delta = p.new_total - p.old_total;
  const deltaStr = (delta >= 0 ? '+' : '') + delta;
  const old = p.old_components;
  const nw = p.new_components;
  const alias = (p.alias ?? p.hash.slice(0, 12)).padEnd(32).slice(0, 32);
  const peers = p.unique_peers ?? '-';
  console.log(
    `${alias} ${String(p.old_total).padStart(3)}   ${String(p.new_total).padStart(3)}   ${deltaStr.padStart(4)}  ` +
    `${String(old.volume).padStart(3)}/${String(old.reputation).padStart(3)}/${String(old.seniority).padStart(3)}/${String(old.regularity).padStart(3)}/${String(old.diversity).padStart(3)}  ` +
    `${String(nw.volume).padStart(3)}/${String(nw.reputation).padStart(3)}/${String(nw.seniority).padStart(3)}/${String(nw.regularity).padStart(3)}/${String(nw.diversity).padStart(3)}  ` +
    `${String(peers).padStart(5)}`,
  );
}

// ---- Regression check: mid-stratum drops (30-60 range) ----
const mid = projected.filter(p => p.old_total >= 30 && p.old_total < 60);
const midDeltas = mid.map(p => p.new_total - p.old_total).sort((a, b) => a - b);
const avgMidDelta = midDeltas.reduce((a, b) => a + b, 0) / midDeltas.length;
const worstMidDrops = [...mid].sort((a, b) => (a.new_total - a.old_total) - (b.new_total - b.old_total)).slice(0, 10);
console.log(`\nMid stratum (30-59) regression check — n=${mid.length}`);
console.log(`  average delta: ${avgMidDelta.toFixed(1)}`);
console.log(`  min delta: ${midDeltas[0]}, max delta: ${midDeltas[midDeltas.length - 1]}`);
const midDrops = {
  '>10 drop': mid.filter(p => p.new_total - p.old_total <= -10).length,
  '6-10 drop': mid.filter(p => p.new_total - p.old_total < -5 && p.new_total - p.old_total > -10).length,
  '3-5 drop': mid.filter(p => p.new_total - p.old_total < -2 && p.new_total - p.old_total >= -5).length,
  '0-2 drop or gain': mid.filter(p => p.new_total - p.old_total >= -2).length,
};
console.log(`  drop histogram:`);
for (const [k, v] of Object.entries(midDrops)) console.log(`    ${k.padEnd(20)} ${v}`);
console.log(`  worst 10 drops:`);
for (const p of worstMidDrops) {
  console.log(`    ${(p.alias ?? p.hash.slice(0, 12)).padEnd(30).slice(0, 30)} ${p.old_total} → ${p.new_total}  (Δ${p.new_total - p.old_total})`);
}

// ---- Regression check: ALL lightning agents, not just mid stratum ----
const lnOnly = projected.filter(p => p.source === 'lightning_graph');
const lnDropBands = {
  'drop > 10': lnOnly.filter(p => p.new_total - p.old_total <= -10).length,
  'drop 6-10': lnOnly.filter(p => p.new_total - p.old_total < -5 && p.new_total - p.old_total > -10).length,
  'drop 3-5':  lnOnly.filter(p => p.new_total - p.old_total < -2 && p.new_total - p.old_total >= -5).length,
  'drop 1-2':  lnOnly.filter(p => p.new_total - p.old_total < 0  && p.new_total - p.old_total >= -2).length,
  'unchanged': lnOnly.filter(p => p.new_total === p.old_total).length,
  'gain':      lnOnly.filter(p => p.new_total > p.old_total).length,
};
console.log(`\nAll lightning agents — drop bands (n=${lnOnly.length})`);
for (const [k, v] of Object.entries(lnDropBands)) console.log(`  ${k.padEnd(14)} ${v}`);

// Threshold-sweep analysis so Romain can pick a new SAFE cut if the calibration
// really has compressed the top.
console.log(`\nVerdict threshold sensitivity (new scores)`);
for (const cut of [60, 58, 56, 55, 54, 52, 50]) {
  const safe = newScores.filter(s => s >= cut).length;
  console.log(`  SAFE ≥ ${cut}: ${safe}`);
}

// ---- Count of agents affected by each change ----
const regChanged = projected.filter(p => p.new_components.regularity !== p.old_components.regularity).length;
const divChanged = projected.filter(p => p.new_components.diversity !== p.old_components.diversity).length;
const totalChanged = projected.filter(p => p.new_total !== p.old_total).length;
console.log(`\nAgents whose components changed:`);
console.log(`  regularity: ${regChanged}`);
console.log(`  diversity:  ${divChanged}`);
console.log(`  total:      ${totalChanged}`);

db.close();
