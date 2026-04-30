// Data access for the attestations table (pg async port, Phase 12B).
import type { Pool, PoolClient } from 'pg';
import type { Attestation } from '../types';

type Queryable = Pool | PoolClient;

export class AttestationRepository {
  constructor(private db: Queryable) {}

  async findBySubject(subjectHash: string, limit: number, offset: number): Promise<Attestation[]> {
    const { rows } = await this.db.query<Attestation>(
      'SELECT * FROM attestations WHERE subject_hash = $1 ORDER BY timestamp DESC LIMIT $2 OFFSET $3',
      [subjectHash, limit, offset],
    );
    return rows;
  }

  // M3: hard cap to prevent unbounded memory usage for prolific attesters
  async findByAttester(attesterHash: string, limit: number = 1000): Promise<Attestation[]> {
    const { rows } = await this.db.query<Attestation>(
      'SELECT * FROM attestations WHERE attester_hash = $1 ORDER BY timestamp DESC LIMIT $2',
      [attesterHash, limit],
    );
    return rows;
  }

  async countBySubject(subjectHash: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      'SELECT COUNT(*)::text as count FROM attestations WHERE subject_hash = $1',
      [subjectHash],
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** Report submission stats for an agent (as the attester / reporter).
   *  Used by /api/profile to surface the `reporterStats` field and derive
   *  the Trusted Reporter badge without touching scoring math. */
  async reporterStats(attesterHash: string, sinceUnix: number): Promise<{
    submitted: number;
    verified: number;
    successes: number;
    failures: number;
    timeouts: number;
  }> {
    const { rows } = await this.db.query<{
      submitted: string | null;
      verified: string | null;
      successes: string | null;
      failures: string | null;
      timeouts: string | null;
    }>(
      `
      SELECT
        COUNT(*)::text AS submitted,
        SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END)::text AS verified,
        SUM(CASE WHEN category = 'successful_transaction' THEN 1 ELSE 0 END)::text AS successes,
        SUM(CASE WHEN category = 'failed_transaction' THEN 1 ELSE 0 END)::text AS failures,
        SUM(CASE WHEN category = 'unresponsive' THEN 1 ELSE 0 END)::text AS timeouts
      FROM attestations
      WHERE attester_hash = $1
        AND category IN ('successful_transaction','failed_transaction','unresponsive')
        AND timestamp >= $2
      `,
      [attesterHash, sinceUnix],
    );
    const row = rows[0];
    return {
      submitted: Number(row?.submitted ?? 0),
      verified: Number(row?.verified ?? 0),
      successes: Number(row?.successes ?? 0),
      failures: Number(row?.failures ?? 0),
      timeouts: Number(row?.timeouts ?? 0),
    };
  }

  async avgScoreBySubject(subjectHash: string): Promise<number> {
    const { rows } = await this.db.query<{ avg: number | null }>(
      'SELECT AVG(score) as avg FROM attestations WHERE subject_hash = $1',
      [subjectHash],
    );
    return rows[0]?.avg ?? 0;
  }

  async totalCount(): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      'SELECT COUNT(*)::text as count FROM attestations',
    );
    return Number(rows[0]?.count ?? 0);
  }

  // Detects direct mutual attestation loops (A attests B AND B attests A)
  async findMutualAttestations(agentHash: string): Promise<string[]> {
    const { rows } = await this.db.query<{ mutual_agent: string }>(
      `
      SELECT DISTINCT a1.attester_hash as mutual_agent
      FROM attestations a1
      INNER JOIN attestations a2
        ON a1.attester_hash = a2.subject_hash
        AND a1.subject_hash = a2.attester_hash
      WHERE a1.subject_hash = $1
      `,
      [agentHash],
    );
    return rows.map(r => r.mutual_agent);
  }

  // Detects circular clusters (A->B->C->A) up to depth 3
  // Returns agents that are part of a cycle passing through agentHash
  async findCircularCluster(agentHash: string): Promise<string[]> {
    const { rows } = await this.db.query<{ cluster_member: string }>(
      `
      SELECT DISTINCT a2.subject_hash as cluster_member
      FROM attestations a1
      INNER JOIN attestations a2 ON a1.attester_hash = a2.subject_hash
      INNER JOIN attestations a3 ON a2.attester_hash = a3.subject_hash
      WHERE a1.subject_hash = $1
        AND a3.attester_hash = $2
        AND a1.attester_hash != $3
        AND a2.attester_hash != $4
      `,
      [agentHash, agentHash, agentHash, agentHash],
    );

    // Also add direct intermediaries in the chain
    const { rows: rows2 } = await this.db.query<{ cluster_member: string }>(
      `
      SELECT DISTINCT a1.attester_hash as cluster_member
      FROM attestations a1
      INNER JOIN attestations a2 ON a1.attester_hash = a2.subject_hash
      INNER JOIN attestations a3 ON a2.attester_hash = a3.subject_hash
      WHERE a1.subject_hash = $1
        AND a3.attester_hash = $2
        AND a1.attester_hash != $3
      `,
      [agentHash, agentHash, agentHash],
    );

    const members = new Set([
      ...rows.map(r => r.cluster_member),
      ...rows2.map(r => r.cluster_member),
    ]);
    return Array.from(members);
  }

  // Detects cycles up to `maxDepth` hops using BFS (A→B→C→D→A for depth=4)
  // Returns all agents that are part of a cycle passing through agentHash
  async findCycleMembers(agentHash: string, maxDepth: number = 4): Promise<string[]> {
    if (maxDepth < 2) return [];

    // BFS: walk "who attested agents in the current layer" layer by layer.
    // If agentHash appears as an attester at any layer, we've found a cycle.
    const cycleMembers = new Set<string>();
    let currentLayer = new Set<string>();

    // Layer 0: direct attesters of agentHash (excluding self-attestation)
    const { rows: directAttesters } = await this.db.query<{ attester_hash: string }>(
      'SELECT DISTINCT attester_hash FROM attestations WHERE subject_hash = $1 AND attester_hash != $2',
      [agentHash, agentHash],
    );

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
        // Do NOT exclude agentHash — we need to detect when it closes the cycle
        const { rows } = await this.db.query<{ attester_hash: string; subject_hash: string }>(
          'SELECT DISTINCT attester_hash, subject_hash FROM attestations WHERE subject_hash = ANY($1::text[])',
          [batch],
        );

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
  async countUniqueAttesters(subjectHash: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      'SELECT COUNT(DISTINCT attester_hash)::text as count FROM attestations WHERE subject_hash = $1',
      [subjectHash],
    );
    return Number(rows[0]?.count ?? 0);
  }

  // --- Trust graph queries ---

  /** Agents positively attested (score >= threshold) by a given attester */
  async findPositivelyAttestedBy(attesterHash: string, minScore: number = 70): Promise<string[]> {
    const { rows } = await this.db.query<{ subject_hash: string }>(
      'SELECT DISTINCT subject_hash FROM attestations WHERE attester_hash = $1 AND score >= $2',
      [attesterHash, minScore],
    );
    return rows.map(r => r.subject_hash);
  }

  /** Agents who positively attested (score >= threshold) a given subject */
  async findPositiveAttestersOf(subjectHash: string, minScore: number = 70): Promise<{ attester_hash: string; score: number }[]> {
    const { rows } = await this.db.query<{ attester_hash: string; score: number }>(
      'SELECT attester_hash, score FROM attestations WHERE subject_hash = $1 AND score >= $2',
      [subjectHash, minScore],
    );
    return rows;
  }

  async countByCategoryForSubject(subjectHash: string, categories: string[]): Promise<number> {
    if (categories.length === 0) return 0;
    if (categories.length > 20) throw new Error('categories array exceeds limit');
    const { rows } = await this.db.query<{ count: string }>(
      'SELECT COUNT(*)::text as count FROM attestations WHERE subject_hash = $1 AND category = ANY($2::text[])',
      [subjectHash, categories],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async insert(attestation: Attestation): Promise<void> {
    await this.db.query(
      `
      INSERT INTO attestations (attestation_id, tx_id, attester_hash, subject_hash, score, tags, evidence_hash, timestamp, category, verified, weight)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        attestation.attestation_id, attestation.tx_id, attestation.attester_hash,
        attestation.subject_hash, attestation.score, attestation.tags,
        attestation.evidence_hash, attestation.timestamp, attestation.category,
        attestation.verified, attestation.weight,
      ],
    );
  }

  // --- v2 report queries ---

  /** Find most recent report from attester to subject (for dedup) */
  async findRecentReport(attesterHash: string, subjectHash: string, afterTimestamp: number): Promise<Attestation | undefined> {
    const { rows } = await this.db.query<Attestation>(
      'SELECT * FROM attestations WHERE attester_hash = $1 AND subject_hash = $2 AND timestamp >= $3 ORDER BY timestamp DESC LIMIT 1',
      [attesterHash, subjectHash, afterTimestamp],
    );
    return rows[0];
  }

  /** Count reports by outcome category for a subject */
  async countReportsByOutcome(subjectHash: string): Promise<{ successes: number; failures: number; timeouts: number; total: number }> {
    const { rows } = await this.db.query<{ category: string; count: string }>(
      `
      SELECT category, COUNT(*)::text as count FROM attestations
      WHERE subject_hash = $1
      AND category IN ('successful_transaction', 'failed_transaction', 'unresponsive')
      GROUP BY category
      `,
      [subjectHash],
    );

    const counts = { successes: 0, failures: 0, timeouts: 0, total: 0 };
    for (const row of rows) {
      const n = Number(row.count);
      if (row.category === 'successful_transaction') counts.successes = n;
      else if (row.category === 'failed_transaction') counts.failures = n;
      else if (row.category === 'unresponsive') counts.timeouts = n;
    }
    counts.total = counts.successes + counts.failures + counts.timeouts;
    return counts;
  }

  /** Weighted success rate: sum(weight * (score >= 50 ? 1 : 0)) / sum(weight) for report-category attestations */
  async weightedSuccessRate(subjectHash: string): Promise<{ rate: number; dataPoints: number; uniqueReporters: number }> {
    const { rows } = await this.db.query<{
      weighted_successes: number;
      total_weight: number;
      data_points: string;
      unique_reporters: string;
    }>(
      `
      SELECT
        COALESCE(SUM(CASE WHEN score >= 50 THEN weight ELSE 0 END), 0) as weighted_successes,
        COALESCE(SUM(weight), 0) as total_weight,
        COUNT(*)::text as data_points,
        COUNT(DISTINCT attester_hash)::text as unique_reporters
      FROM attestations
      WHERE subject_hash = $1
      AND category IN ('successful_transaction', 'failed_transaction', 'unresponsive')
      `,
      [subjectHash],
    );
    const row = rows[0];
    const totalWeight = Number(row?.total_weight ?? 0);
    if (totalWeight === 0) return { rate: 0, dataPoints: 0, uniqueReporters: 0 };
    return {
      rate: Number(row?.weighted_successes ?? 0) / totalWeight,
      dataPoints: Number(row?.data_points ?? 0),
      uniqueReporters: Number(row?.unique_reporters ?? 0),
    };
  }

  /** Report signal stats for scoring: weighted success/failure counts with verified bonus.
   *  Each report contributes its `weight` (reporter credibility). Verified reports (preimage-proven)
   *  get 2x weight. Returns raw weighted counts for the scoring engine to blend. */
  async reportSignalStats(subjectHash: string): Promise<{ weightedSuccesses: number; weightedFailures: number; total: number }> {
    const { rows } = await this.db.query<{
      weighted_successes: number;
      weighted_failures: number;
      total: string;
    }>(
      `
      SELECT
        COALESCE(SUM(CASE WHEN score >= 50 THEN weight * (1 + verified) ELSE 0 END), 0) as weighted_successes,
        COALESCE(SUM(CASE WHEN score < 50 THEN weight * (1 + verified) ELSE 0 END), 0) as weighted_failures,
        COUNT(*)::text as total
      FROM attestations
      WHERE subject_hash = $1
      AND category IN ('successful_transaction', 'failed_transaction', 'unresponsive')
      `,
      [subjectHash],
    );
    const row = rows[0];
    return {
      weightedSuccesses: Number(row?.weighted_successes ?? 0),
      weightedFailures: Number(row?.weighted_failures ?? 0),
      total: Number(row?.total ?? 0),
    };
  }

  /** Count reports from a specific attester in the last N seconds (rate limiting).
   *  When categories is provided, only counts attestations in those categories (C8). */
  async countRecentByAttester(attesterHash: string, afterTimestamp: number, categories?: string[]): Promise<number> {
    if (categories && categories.length > 0) {
      if (categories.length > 20) throw new Error('categories array exceeds limit');
      const { rows } = await this.db.query<{ count: string }>(
        'SELECT COUNT(*)::text as count FROM attestations WHERE attester_hash = $1 AND timestamp >= $2 AND category = ANY($3::text[])',
        [attesterHash, afterTimestamp, categories],
      );
      return Number(rows[0]?.count ?? 0);
    }
    const { rows } = await this.db.query<{ count: string }>(
      'SELECT COUNT(*)::text as count FROM attestations WHERE attester_hash = $1 AND timestamp >= $2',
      [attesterHash, afterTimestamp],
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** Audit Tier 3A (2026-04-30) — count reports against a SUBJECT (target) in
   *  the last N seconds, optionally filtered by categories. Used to cap
   *  negative-report flooding ("censure de réputation") on a single target.
   *  Without this guard, an attacker who spreads reports across many
   *  attesters can sidestep the per-attester rate limit and dominate a
   *  target's posterior with concerted negative reports. */
  async countRecentBySubject(subjectHash: string, afterTimestamp: number, categories?: string[]): Promise<number> {
    if (categories && categories.length > 0) {
      if (categories.length > 20) throw new Error('categories array exceeds limit');
      const { rows } = await this.db.query<{ count: string }>(
        'SELECT COUNT(*)::text as count FROM attestations WHERE subject_hash = $1 AND timestamp >= $2 AND category = ANY($3::text[])',
        [subjectHash, afterTimestamp, categories],
      );
      return Number(rows[0]?.count ?? 0);
    }
    const { rows } = await this.db.query<{ count: string }>(
      'SELECT COUNT(*)::text as count FROM attestations WHERE subject_hash = $1 AND timestamp >= $2',
      [subjectHash, afterTimestamp],
    );
    return Number(rows[0]?.count ?? 0);
  }
}
