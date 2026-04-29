// Phase 9.1 — repository pour peer_calibration_observations.
//
// Stockage des kind 30783 calibration events publiés par les autres
// oracles SatRank-compatible et ingérés via subscribe permanent. Permet
// aux clients de comparer les calibrations cross-oracle (meta-confidence).
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export interface PeerCalibrationRecord {
  event_id: string;
  peer_pubkey: string;
  window_start: number;
  window_end: number;
  delta_mean: number | null;
  delta_median: number | null;
  delta_p95: number | null;
  n_endpoints: number;
  n_outcomes: number;
  observed_at: number;
}

export class PeerCalibrationRepository {
  constructor(private readonly db: Queryable) {}

  /** INSERT, ON CONFLICT (event_id) DO NOTHING — chaque event Nostr ingéré
   *  une seule fois. Retourne true si nouveau, false si dup. */
  async insertIfNew(record: PeerCalibrationRecord): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `INSERT INTO peer_calibration_observations
         (event_id, peer_pubkey, window_start, window_end,
          delta_mean, delta_median, delta_p95,
          n_endpoints, n_outcomes, observed_at)
       VALUES ($1::text, $2::text, $3::bigint, $4::bigint,
               $5, $6, $7,
               $8::int, $9::int, $10::bigint)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        record.event_id,
        record.peer_pubkey,
        record.window_start,
        record.window_end,
        record.delta_mean,
        record.delta_median,
        record.delta_p95,
        record.n_endpoints,
        record.n_outcomes,
        record.observed_at,
      ],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Liste des calibrations observées pour un peer, freshest first. */
  async listByPeer(peerPubkey: string, limit = 50): Promise<PeerCalibrationRecord[]> {
    const { rows } = await this.db.query<PeerCalibrationRecord>(
      `SELECT event_id, peer_pubkey, window_start, window_end,
              delta_mean, delta_median, delta_p95,
              n_endpoints, n_outcomes, observed_at
         FROM peer_calibration_observations
        WHERE peer_pubkey = $1::text
        ORDER BY window_end DESC
        LIMIT $2::int`,
      [peerPubkey, limit],
    );
    return rows;
  }

  async findByEventId(eventId: string): Promise<PeerCalibrationRecord | null> {
    const { rows } = await this.db.query<PeerCalibrationRecord>(
      `SELECT event_id, peer_pubkey, window_start, window_end,
              delta_mean, delta_median, delta_p95,
              n_endpoints, n_outcomes, observed_at
         FROM peer_calibration_observations
        WHERE event_id = $1::text`,
      [eventId],
    );
    return rows[0] ?? null;
  }
}
