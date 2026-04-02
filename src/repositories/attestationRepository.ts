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

  findByAttester(attesterHash: string): Attestation[] {
    return this.db.prepare(
      'SELECT * FROM attestations WHERE attester_hash = ? ORDER BY timestamp DESC'
    ).all(attesterHash) as Attestation[];
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
    const placeholders = categories.map(() => '?').join(',');
    const row = this.db.prepare(
      `SELECT COUNT(*) as count FROM attestations WHERE subject_hash = ? AND category IN (${placeholders})`
    ).get(subjectHash, ...categories) as { count: number };
    return row.count;
  }

  insert(attestation: Attestation): void {
    this.db.prepare(`
      INSERT INTO attestations (attestation_id, tx_id, attester_hash, subject_hash, score, tags, evidence_hash, timestamp, category)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attestation.attestation_id, attestation.tx_id, attestation.attester_hash,
      attestation.subject_hash, attestation.score, attestation.tags,
      attestation.evidence_hash, attestation.timestamp, attestation.category
    );
  }
}
