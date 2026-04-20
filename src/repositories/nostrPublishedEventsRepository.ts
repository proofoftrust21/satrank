// Phase 8 — C5/C7 : cache des events Nostr déjà publiés, pour piloter
// shouldRepublish() sans avoir à re-scanner les relais.
//
// Une row par (entity_type, entity_id) — un seul event remplaçable actif par
// entité, conformément au modèle NIP-33. On stocke :
//   - event_id / event_kind / published_at : coordonnées Nostr
//   - payload_hash : fingerprint stable du template pour diff rapide
//   - verdict / advisory_level / p_success / n_obs_effective : snapshot qui
//     sert d'input à shouldRepublish() au prochain scan
//
// Ce module ne décide PAS si on republie — il expose juste l'état précédent
// et la méthode d'upsert. shouldRepublish() vit côté src/nostr/.
import type Database from 'better-sqlite3';
import type { Verdict, AdvisoryLevel } from '../types/index';

export type PublishedEntityType = 'node' | 'endpoint' | 'service';

export interface PublishedEventRow {
  entity_type: PublishedEntityType;
  entity_id: string;
  event_id: string;
  event_kind: number;
  published_at: number;
  payload_hash: string;
  verdict: Verdict | null;
  advisory_level: AdvisoryLevel | null;
  p_success: number | null;
  n_obs_effective: number | null;
}

export interface RecordPublishedInput {
  entityType: PublishedEntityType;
  entityId: string;
  eventId: string;
  eventKind: number;
  publishedAt: number;
  payloadHash: string;
  verdict: Verdict;
  advisoryLevel: AdvisoryLevel;
  pSuccess: number;
  nObsEffective: number;
}

export class NostrPublishedEventsRepository {
  private stmtGet;
  private stmtGetByEventId;
  private stmtUpsert;
  private stmtDelete;
  private stmtListByType;
  private stmtCountByKind;
  private stmtLatestTimestamps;

  constructor(private db: Database.Database) {
    this.stmtGet = db.prepare(
      `SELECT * FROM nostr_published_events
        WHERE entity_type = ? AND entity_id = ?`,
    );
    this.stmtGetByEventId = db.prepare(
      `SELECT * FROM nostr_published_events WHERE event_id = ? LIMIT 1`,
    );
    this.stmtLatestTimestamps = db.prepare(
      `SELECT entity_type, MAX(published_at) as ts FROM nostr_published_events GROUP BY entity_type`,
    );
    // Upsert sur la clé composite — un seul event actif par entité.
    this.stmtUpsert = db.prepare(`
      INSERT INTO nostr_published_events
        (entity_type, entity_id, event_id, event_kind, published_at, payload_hash,
         verdict, advisory_level, p_success, n_obs_effective)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_type, entity_id) DO UPDATE SET
        event_id = excluded.event_id,
        event_kind = excluded.event_kind,
        published_at = excluded.published_at,
        payload_hash = excluded.payload_hash,
        verdict = excluded.verdict,
        advisory_level = excluded.advisory_level,
        p_success = excluded.p_success,
        n_obs_effective = excluded.n_obs_effective
    `);
    this.stmtDelete = db.prepare(
      `DELETE FROM nostr_published_events WHERE entity_type = ? AND entity_id = ?`,
    );
    this.stmtListByType = db.prepare(
      `SELECT * FROM nostr_published_events WHERE entity_type = ?
        ORDER BY published_at DESC LIMIT ?`,
    );
    this.stmtCountByKind = db.prepare(
      `SELECT event_kind, COUNT(*) as c FROM nostr_published_events GROUP BY event_kind`,
    );
  }

  /** Récupère le snapshot précédent pour une entité. null si jamais publié. */
  getLastPublished(entityType: PublishedEntityType, entityId: string): PublishedEventRow | null {
    const row = this.stmtGet.get(entityType, entityId) as PublishedEventRow | undefined;
    return row ?? null;
  }

  /** Lookup par event_id — utilisé par C8 (NIP-09) pour vérifier qu'une
   *  deletion request cible bien un event que nous avons publié avant de
   *  la signer. */
  findByEventId(eventId: string): PublishedEventRow | null {
    const row = this.stmtGetByEventId.get(eventId) as PublishedEventRow | undefined;
    return row ?? null;
  }

  /** Upsert après un publish réussi. Remplace atomiquement la row précédente. */
  recordPublished(input: RecordPublishedInput): void {
    this.stmtUpsert.run(
      input.entityType,
      input.entityId,
      input.eventId,
      input.eventKind,
      input.publishedAt,
      input.payloadHash,
      input.verdict,
      input.advisoryLevel,
      input.pSuccess,
      input.nObsEffective,
    );
  }

  /** Supprime une row — utilisé par C8 pour les deletion requests NIP-09. */
  delete(entityType: PublishedEntityType, entityId: string): boolean {
    const res = this.stmtDelete.run(entityType, entityId);
    return Number(res.changes ?? 0) > 0;
  }

  /** Liste les N derniers events publiés pour un type — debug/metrics. */
  listByType(entityType: PublishedEntityType, limit = 100): PublishedEventRow[] {
    return this.stmtListByType.all(entityType, limit) as PublishedEventRow[];
  }

  /** Comptage par kind — exposé par /metrics. */
  countByKind(): Record<number, number> {
    const rows = this.stmtCountByKind.all() as Array<{ event_kind: number; c: number }>;
    const out: Record<number, number> = {};
    for (const r of rows) out[r.event_kind] = r.c;
    return out;
  }

  /** Timestamp du dernier publish par entity_type — utile pour / metrics et
   *  pour l'introspection (combien de temps depuis le dernier événement ?). */
  latestPublishedAtByType(): Record<PublishedEntityType, number | null> {
    const rows = this.stmtLatestTimestamps.all() as Array<{ entity_type: PublishedEntityType; ts: number }>;
    const out: Record<PublishedEntityType, number | null> = {
      node: null,
      endpoint: null,
      service: null,
    };
    for (const r of rows) out[r.entity_type] = r.ts;
    return out;
  }
}
