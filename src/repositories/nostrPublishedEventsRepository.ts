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
// (pg async port, Phase 12B)
import type { Pool, PoolClient } from 'pg';
import type { Verdict, AdvisoryLevel } from '../types/index';

type Queryable = Pool | PoolClient;

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
  constructor(private db: Queryable) {}

  /** Récupère le snapshot précédent pour une entité. null si jamais publié. */
  async getLastPublished(entityType: PublishedEntityType, entityId: string): Promise<PublishedEventRow | null> {
    const { rows } = await this.db.query<PublishedEventRow>(
      `SELECT * FROM nostr_published_events
        WHERE entity_type = $1 AND entity_id = $2`,
      [entityType, entityId],
    );
    return rows[0] ?? null;
  }

  /** Lookup par event_id — utilisé par C8 (NIP-09) pour vérifier qu'une
   *  deletion request cible bien un event que nous avons publié avant de
   *  la signer. */
  async findByEventId(eventId: string): Promise<PublishedEventRow | null> {
    const { rows } = await this.db.query<PublishedEventRow>(
      'SELECT * FROM nostr_published_events WHERE event_id = $1 LIMIT 1',
      [eventId],
    );
    return rows[0] ?? null;
  }

  /** Upsert après un publish réussi. Remplace atomiquement la row précédente. */
  async recordPublished(input: RecordPublishedInput): Promise<void> {
    await this.db.query(
      `
      INSERT INTO nostr_published_events
        (entity_type, entity_id, event_id, event_kind, published_at, payload_hash,
         verdict, advisory_level, p_success, n_obs_effective)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (entity_type, entity_id) DO UPDATE SET
        event_id = EXCLUDED.event_id,
        event_kind = EXCLUDED.event_kind,
        published_at = EXCLUDED.published_at,
        payload_hash = EXCLUDED.payload_hash,
        verdict = EXCLUDED.verdict,
        advisory_level = EXCLUDED.advisory_level,
        p_success = EXCLUDED.p_success,
        n_obs_effective = EXCLUDED.n_obs_effective
      `,
      [
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
      ],
    );
  }

  /** Supprime une row — utilisé par C8 pour les deletion requests NIP-09. */
  async delete(entityType: PublishedEntityType, entityId: string): Promise<boolean> {
    const result = await this.db.query(
      'DELETE FROM nostr_published_events WHERE entity_type = $1 AND entity_id = $2',
      [entityType, entityId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Liste les N derniers events publiés pour un type — debug/metrics. */
  async listByType(entityType: PublishedEntityType, limit = 100): Promise<PublishedEventRow[]> {
    const { rows } = await this.db.query<PublishedEventRow>(
      `SELECT * FROM nostr_published_events WHERE entity_type = $1
        ORDER BY published_at DESC LIMIT $2`,
      [entityType, limit],
    );
    return rows;
  }

  /** Comptage par kind — exposé par /metrics. */
  async countByKind(): Promise<Record<number, number>> {
    const { rows } = await this.db.query<{ event_kind: number; c: string }>(
      'SELECT event_kind, COUNT(*)::text as c FROM nostr_published_events GROUP BY event_kind',
    );
    const out: Record<number, number> = {};
    for (const r of rows) out[r.event_kind] = Number(r.c);
    return out;
  }

  /** Timestamp du dernier publish par entity_type — utile pour / metrics et
   *  pour l'introspection (combien de temps depuis le dernier événement ?). */
  async latestPublishedAtByType(): Promise<Record<PublishedEntityType, number | null>> {
    const { rows } = await this.db.query<{ entity_type: PublishedEntityType; ts: number }>(
      'SELECT entity_type, MAX(published_at) as ts FROM nostr_published_events GROUP BY entity_type',
    );
    const out: Record<PublishedEntityType, number | null> = {
      node: null,
      endpoint: null,
      service: null,
    };
    for (const r of rows) out[r.entity_type] = r.ts;
    return out;
  }
}
