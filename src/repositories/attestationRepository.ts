// Data access for the attestations table
import type Database from 'better-sqlite3';
import type { Attestation } from '../types';

export class AttestationRepository {
  constructor(private db: Database.Database) {}

  findBySubject(subjectHash: string, limit: number, offset: number): Attestation[] {
    return this.db.prepare(
      'SELECT * FROM attestations WHERE subject_hash = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?'
    ).all(subjectHash, limit, offset) as Attestation[];
  }

  // M3: hard cap to prevent unbounded memory usage for prolific attesters
  findByAttester(attesterHash: string, limit: number = 1000): Attestation[] {
    return this.db.prepare(
      'SELECT * FROM attestations WHERE attester_hash = ? ORDER BY timestamp DESC LIMIT ?'
    ).all(attesterHash, limit) as Attestation[];
  }

  countBySubject(subjectHash: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as count FROM attestations WHERE subject_hash = ?'
    ).get(subjectHash) as { count: number };
    return row.count;
  }

  avgScoreBySubject(subjectHash: string): number {
    const row = this.db.prepare(
      'SELECT AVG(score) as avg FROM attestations WHERE subject_hash = ?'
    ).get(subjectHash) as { avg: number | null };
    return row.avg ?? 0;
  }

  totalCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM attestations').get() as { count: number };
    return row.count;
  }

  // Detects direct mutual attestation loops (A attests B AND B attests A)
  findMutualAttestations(agentHash: string): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT a1.attester_hash as mutual_agent
      FROM attestations a1
      INNER JOIN attestations a2
        ON a1.attester_hash = a2.subject_hash
        AND a1.subject_hash = a2.attester_hash
      WHERE a1.subject_hash = ?
    `).all(agentHash) as { mutual_agent: string }[];
    return rows.map(r => r.mutual_agent);
  }

  // Detects circular clusters (A->B->C->A) up to depth 3
  // Returns agents that are part of a cycle passing through agentHash
  findCircularCluster(agentHash: string): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT a2.subject_hash as cluster_member
      FROM attestations a1
      INNER JOIN attestations a2 ON a1.attester_hash = a2.subject_hash
      INNER JOIN attestations a3 ON a2.attester_hash = a3.subject_hash
      WHERE a1.subject_hash = ?
        AND a3.attester_hash = ?
        AND a1.attester_hash != ?
        AND a2.attester_hash != ?
    `).all(agentHash, agentHash, agentHash, agentHash) as { cluster_member: string }[];

    // Also add direct intermediaries in the chain
    const rows2 = this.db.prepare(`
      SELECT DISTINCT a1.attester_hash as cluster_member
      FROM attestations a1
      INNER JOIN attestations a2 ON a1.attester_hash = a2.subject_hash
      INNER JOIN attestations a3 ON a2.attester_hash = a3.subject_hash
      WHERE a1.subject_hash = ?
        AND a3.attester_hash = ?
        AND a1.attester_hash != ?
    `).all(agentHash, agentHash, agentHash) as { cluster_member: string }[];

    const members = new Set([
      ...rows.map(r => r.cluster_member),
      ...rows2.map(r => r.cluster_member),
    ]);
    return Array.from(members);
  }

  // Detects cycles up to `maxDepth` hops using BFS (A→B→C→D→A for depth=4)
  // Returns all agents that are part of a cycle passing through agentHash
  findCycleMembers(agentHash: string, maxDepth: number = 4): string[] {
    if (maxDepth < 2) return [];

    // BFS: walk "who attested agents in the current layer" layer by layer.
    // If agentHash appears as an attester at any layer, we've found a cycle.
    const cycleMembers = new Set<string>();
    let currentLayer = new Set<string>();

    // Layer 0: direct attesters of agentHash (excluding self-attestation)
    const directAttesters = this.db.prepare(
      'SELECT DISTINCT attester_hash FROM attestations WHERE subject_hash = ? AND attester_hash != ?'
    ).all(agentHash, agentHash) as { attester_hash: string }[];

    for (const row of directAttesters) {
      currentLayer.add(row.attester_hash);
    }

    const visited = new Set<string>([agentHash]);
    const layerHistory: Set<string>[] = [currentLayer];

    for (let depth = 2; depth <= maxDepth; depth++) {
      if (currentLayer.size === 0) break;

      const nextLayer = new Set<string>();
      const hashes = Array.from(currentLayer);

      const batchSize = 100;
      for (let i = 0; i < hashes.length; i += batchSize) {
        const batch = hashes.slice(i, i + batchSize);
        const placeholders = batch.map(() => '?').join(',');
        // Do NOT exclude agentHash — we need to detect when it closes the cycle
        const rows = this.db.prepare(
          `SELECT DISTINCT attester_hash, subject_hash FROM attestations WHERE subject_hash IN (${placeholders})`
        ).all(...batch) as { attester_hash: string; subject_hash: string }[];

        for (const row of rows) {
          if (row.attester_hash === agentHash) {
            // Cycle found! All agents visited so far are cycle members
            for (const layer of layerHistory) {
              for (const member of layer) cycleMembers.add(member);
            }
          } else if (!visited.has(row.attester_hash)) {
            nextLayer.add(row.attester_hash);
          }
        }
      }

      for (const h of nextLayer) visited.add(h);
      currentLayer = nextLayer;
      layerHistory.push(nextLayer);
    }

    return Array.from(cycleMembers);
  }

  // Number of unique attesters for an agent (attestation source diversity)
  countUniqueAttesters(subjectHash: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(DISTINCT attester_hash) as count FROM attestations WHERE subject_hash = ?'
    ).get(subjectHash) as { count: number };
    return row.count;
  }

  // --- Trust graph queries ---

  /** Agents positively attested (score >= threshold) by a given attester */
  findPositivelyAttestedBy(attesterHash: string, minScore: number = 70): string[] {
    const rows = this.db.prepare(
      'SELECT DISTINCT subject_hash FROM attestations WHERE attester_hash = ? AND score >= ?'
    ).all(attesterHash, minScore) as { subject_hash: string }[];
    return rows.map(r => r.subject_hash);
  }

  /** Agents who positively attested (score >= threshold) a given subject */
  findPositiveAttestersOf(subjectHash: string, minScore: number = 70): { attester_hash: string; score: number }[] {
    return this.db.prepare(
      'SELECT attester_hash, score FROM attestations WHERE subject_hash = ? AND score >= ?'
    ).all(subjectHash, minScore) as { attester_hash: string; score: number }[];
  }

  countByCategoryForSubject(subjectHash: string, categories: string[]): number {
    if (categories.length === 0) return 0;
    if (categories.length > 20) throw new Error('categories array exceeds limit');
    const placeholders = categories.map(() => '?').join(',');
    const row = this.db.prepare(
      `SELECT COUNT(*) as count FROM attestations WHERE subject_hash = ? AND category IN (${placeholders})`
    ).get(subjectHash, ...categories) as { count: number };
    return row.count;
  }

  insert(attestation: Attestation): void {
    this.db.prepare(`
      INSERT INTO attestations (attestation_id, tx_id, attester_hash, subject_hash, score, tags, evidence_hash, timestamp, category, verified, weight)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attestation.attestation_id, attestation.tx_id, attestation.attester_hash,
      attestation.subject_hash, attestation.score, attestation.tags,
      attestation.evidence_hash, attestation.timestamp, attestation.category,
      attestation.verified, attestation.weight,
    );
  }

  // --- v2 report queries ---

  /** Find most recent report from attester to subject (for dedup) */
  findRecentReport(attesterHash: string, subjectHash: string, afterTimestamp: number): Attestation | undefined {
    return this.db.prepare(
      'SELECT * FROM attestations WHERE attester_hash = ? AND subject_hash = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT 1'
    ).get(attesterHash, subjectHash, afterTimestamp) as Attestation | undefined;
  }

  /** Count reports by outcome category for a subject */
  countReportsByOutcome(subjectHash: string): { successes: number; failures: number; timeouts: number; total: number } {
    const rows = this.db.prepare(`
      SELECT category, COUNT(*) as count FROM attestations
      WHERE subject_hash = ?
      AND category IN ('successful_transaction', 'failed_transaction', 'unresponsive')
      GROUP BY category
    `).all(subjectHash) as { category: string; count: number }[];

    const counts = { successes: 0, failures: 0, timeouts: 0, total: 0 };
    for (const row of rows) {
      if (row.category === 'successful_transaction') counts.successes = row.count;
      else if (row.category === 'failed_transaction') counts.failures = row.count;
      else if (row.category === 'unresponsive') counts.timeouts = row.count;
    }
    counts.total = counts.successes + counts.failures + counts.timeouts;
    return counts;
  }

  /** Weighted success rate: sum(weight * (score >= 50 ? 1 : 0)) / sum(weight) for report-category attestations */
  weightedSuccessRate(subjectHash: string): { rate: number; dataPoints: number; uniqueReporters: number } {
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN score >= 50 THEN weight ELSE 0 END), 0) as weighted_successes,
        COALESCE(SUM(weight), 0) as total_weight,
        COUNT(*) as data_points,
        COUNT(DISTINCT attester_hash) as unique_reporters
      FROM attestations
      WHERE subject_hash = ?
      AND category IN ('successful_transaction', 'failed_transaction', 'unresponsive')
    `).get(subjectHash) as { weighted_successes: number; total_weight: number; data_points: number; unique_reporters: number };

    if (row.total_weight === 0) return { rate: 0, dataPoints: 0, uniqueReporters: 0 };
    return { rate: row.weighted_successes / row.total_weight, dataPoints: row.data_points, uniqueReporters: row.unique_reporters };
  }

  /** Report signal stats for scoring: weighted success/failure counts with verified bonus.
   *  Each report contributes its `weight` (reporter credibility). Verified reports (preimage-proven)
   *  get 2x weight. Returns raw weighted counts for the scoring engine to blend. */
  reportSignalStats(subjectHash: string): { weightedSuccesses: number; weightedFailures: number; total: number } {
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN score >= 50 THEN weight * (1 + verified) ELSE 0 END), 0) as weighted_successes,
        COALESCE(SUM(CASE WHEN score < 50 THEN weight * (1 + verified) ELSE 0 END), 0) as weighted_failures,
        COUNT(*) as total
      FROM attestations
      WHERE subject_hash = ?
      AND category IN ('successful_transaction', 'failed_transaction', 'unresponsive')
    `).get(subjectHash) as { weighted_successes: number; weighted_failures: number; total: number };

    return { weightedSuccesses: row.weighted_successes, weightedFailures: row.weighted_failures, total: row.total };
  }

  /** Count reports from a specific attester in the last N seconds (rate limiting).
   *  When categories is provided, only counts attestations in those categories (C8). */
  countRecentByAttester(attesterHash: string, afterTimestamp: number, categories?: string[]): number {
    if (categories && categories.length > 0) {
      if (categories.length > 20) throw new Error('categories array exceeds limit');
      const placeholders = categories.map(() => '?').join(',');
      const row = this.db.prepare(
        `SELECT COUNT(*) as count FROM attestations WHERE attester_hash = ? AND timestamp >= ? AND category IN (${placeholders})`
      ).get(attesterHash, afterTimestamp, ...categories) as { count: number };
      return row.count;
    }
    const row = this.db.prepare(
      'SELECT COUNT(*) as count FROM attestations WHERE attester_hash = ? AND timestamp >= ?'
    ).get(attesterHash, afterTimestamp) as { count: number };
    return row.count;
  }
}
