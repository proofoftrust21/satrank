// Phase 7.0 + 7.1 — federation discovery repositories.
//
// Deux concerns séparés pour découpler le publish path (notre instance
// publie kind 30784) du discovery path (on ingère les kind 30784 des
// autres oracles SatRank-compatible).
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

// ---------- Phase 7.0 : audit local des announcements émis ----------

export interface OracleAnnouncementRecord {
  event_id: string;
  oracle_pubkey: string;
  catalogue_size: number;
  calibration_event_id: string | null;
  last_assertion_event_id: string | null;
  published_at: number;
  relays: string[];
}

export class OracleAnnouncementRepository {
  constructor(private readonly db: Queryable) {}

  async insert(record: OracleAnnouncementRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO oracle_announcements_published
         (event_id, oracle_pubkey, catalogue_size, calibration_event_id,
          last_assertion_event_id, published_at, relays)
       VALUES ($1::text, $2::text, $3::int, $4, $5, $6::bigint, $7::text[])`,
      [
        record.event_id,
        record.oracle_pubkey,
        record.catalogue_size,
        record.calibration_event_id,
        record.last_assertion_event_id,
        record.published_at,
        record.relays,
      ],
    );
  }

  /** Le dernier announcement émis — sert à l'idempotence cron (skip si
   *  publié il y a < 20h). */
  async findLatest(): Promise<OracleAnnouncementRecord | null> {
    const { rows } = await this.db.query<OracleAnnouncementRecord>(
      `SELECT event_id, oracle_pubkey, catalogue_size, calibration_event_id,
              last_assertion_event_id, published_at, relays
         FROM oracle_announcements_published
        ORDER BY published_at DESC
        LIMIT 1`,
    );
    return rows[0] ?? null;
  }
}

// ---------- Phase 7.1 : peers découverts ----------

export interface OraclePeerRecord {
  oracle_pubkey: string;
  lnd_pubkey: string | null;
  catalogue_size: number;
  calibration_event_id: string | null;
  last_assertion_event_id: string | null;
  contact: string | null;
  onboarding_url: string | null;
  last_seen: number;
  first_seen: number;
  latest_announcement_event_id: string | null;
}

export class OraclePeerRepository {
  constructor(private readonly db: Queryable) {}

  /** UPSERT sur pubkey. first_seen est gardé inchangé (CASE WHEN), seul
   *  last_seen + autres champs sont rafraîchis quand un nouvel
   *  announcement arrive. */
  async upsert(record: OraclePeerRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO oracle_peers
         (oracle_pubkey, lnd_pubkey, catalogue_size, calibration_event_id,
          last_assertion_event_id, contact, onboarding_url,
          last_seen, first_seen, latest_announcement_event_id)
       VALUES ($1::text, $2, $3::int, $4, $5, $6, $7,
               $8::bigint, $9::bigint, $10)
       ON CONFLICT (oracle_pubkey)
       DO UPDATE SET
         lnd_pubkey = EXCLUDED.lnd_pubkey,
         catalogue_size = EXCLUDED.catalogue_size,
         calibration_event_id = EXCLUDED.calibration_event_id,
         last_assertion_event_id = EXCLUDED.last_assertion_event_id,
         contact = EXCLUDED.contact,
         onboarding_url = EXCLUDED.onboarding_url,
         last_seen = EXCLUDED.last_seen,
         latest_announcement_event_id = EXCLUDED.latest_announcement_event_id`,
      [
        record.oracle_pubkey,
        record.lnd_pubkey,
        record.catalogue_size,
        record.calibration_event_id,
        record.last_assertion_event_id,
        record.contact,
        record.onboarding_url,
        record.last_seen,
        record.first_seen,
        record.latest_announcement_event_id,
      ],
    );
  }

  /** List all known peers, freshest first. */
  async list(limit = 100): Promise<OraclePeerRecord[]> {
    const { rows } = await this.db.query<OraclePeerRecord>(
      `SELECT oracle_pubkey, lnd_pubkey, catalogue_size, calibration_event_id,
              last_assertion_event_id, contact, onboarding_url,
              last_seen, first_seen, latest_announcement_event_id
         FROM oracle_peers
        ORDER BY last_seen DESC
        LIMIT $1::int`,
      [limit],
    );
    return rows;
  }

  async findByPubkey(pubkey: string): Promise<OraclePeerRecord | null> {
    const { rows } = await this.db.query<OraclePeerRecord>(
      `SELECT oracle_pubkey, lnd_pubkey, catalogue_size, calibration_event_id,
              last_assertion_event_id, contact, onboarding_url,
              last_seen, first_seen, latest_announcement_event_id
         FROM oracle_peers
        WHERE oracle_pubkey = $1::text`,
      [pubkey],
    );
    return rows[0] ?? null;
  }
}
