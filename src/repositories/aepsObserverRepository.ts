// AEPS §8.5 (2026-05-07) — Observer storage : observed anchors + fork events.
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export type ObservationSource = 'self' | 'l1' | 'nostr' | 'http' | 'manual';

export interface ObservedAnchor {
  observation_id: number;
  operator_pubkey: string;
  day_utc: string;          // YYYY-MM-DD
  root_hex: string;
  source: ObservationSource;
  source_ref: string | null;
  observed_at: number;
}

export interface RecordObservationInput {
  operator_pubkey: string;
  day_utc: string;
  root_hex: string;
  source: ObservationSource;
  source_ref?: string | null;
  observed_at: number;
}

export interface ForkEvent {
  fork_event_id: number;
  operator_pubkey: string;
  day_utc: string;
  root_hex_a: string;
  root_hex_b: string;
  observation_id_a: number;
  observation_id_b: number;
  detected_at: number;
  nostr_event_id: string | null;
  nostr_published_at: number | null;
  claim_id: number | null;
}

export interface RecordForkInput {
  operator_pubkey: string;
  day_utc: string;
  root_hex_a: string;     // caller responsible for lex order
  root_hex_b: string;
  observation_id_a: number;
  observation_id_b: number;
  detected_at: number;
}

export class AepsObserverRepository {
  constructor(private db: Queryable) {}

  /** Idempotent : (operator, day, root, source, source_ref) is UNIQUE. */
  async recordObservation(input: RecordObservationInput): Promise<ObservedAnchor> {
    const { rows } = await this.db.query<ObservationRow>(
      `INSERT INTO aeps_observed_anchors
        (operator_pubkey, day_utc, root_hex, source, source_ref, observed_at)
       VALUES ($1, $2::date, $3, $4, $5, $6)
       ON CONFLICT (operator_pubkey, day_utc, root_hex, source, source_ref) DO UPDATE
         SET observed_at = LEAST(aeps_observed_anchors.observed_at, EXCLUDED.observed_at)
       RETURNING *`,
      [
        input.operator_pubkey,
        input.day_utc,
        input.root_hex,
        input.source,
        input.source_ref ?? null,
        input.observed_at,
      ],
    );
    return rowToObservation(rows[0]);
  }

  /** Returns ALL observations for an (operator, day). Used by the fork
   *  detector to look for ≥2 distinct roots. */
  async listObservationsForOperatorDay(
    operatorPubkey: string,
    dayUtc: string,
  ): Promise<ObservedAnchor[]> {
    const { rows } = await this.db.query<ObservationRow>(
      `SELECT * FROM aeps_observed_anchors
       WHERE operator_pubkey = $1 AND day_utc = $2::date
       ORDER BY observed_at ASC`,
      [operatorPubkey, dayUtc],
    );
    return rows.map(rowToObservation);
  }

  /** Idempotent : (operator, day, root_a, root_b) is UNIQUE. The caller is
   *  responsible for ordering root_hex_a < root_hex_b lexicographically so
   *  re-detection from observations in any order maps to the same row. */
  async recordForkEvent(input: RecordForkInput): Promise<ForkEvent> {
    const { rows } = await this.db.query<ForkEventRow>(
      `INSERT INTO aeps_fork_events
        (operator_pubkey, day_utc, root_hex_a, root_hex_b,
         observation_id_a, observation_id_b, detected_at)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7)
       ON CONFLICT (operator_pubkey, day_utc, root_hex_a, root_hex_b) DO UPDATE
         SET detected_at = LEAST(aeps_fork_events.detected_at, EXCLUDED.detected_at)
       RETURNING *`,
      [
        input.operator_pubkey,
        input.day_utc,
        input.root_hex_a,
        input.root_hex_b,
        input.observation_id_a,
        input.observation_id_b,
        input.detected_at,
      ],
    );
    return rowToForkEvent(rows[0]);
  }

  async findForkEventByKey(
    operatorPubkey: string,
    dayUtc: string,
    rootHexA: string,
    rootHexB: string,
  ): Promise<ForkEvent | null> {
    const { rows } = await this.db.query<ForkEventRow>(
      `SELECT * FROM aeps_fork_events
       WHERE operator_pubkey = $1 AND day_utc = $2::date
         AND root_hex_a = $3 AND root_hex_b = $4`,
      [operatorPubkey, dayUtc, rootHexA, rootHexB],
    );
    return rows[0] ? rowToForkEvent(rows[0]) : null;
  }

  /** Return the first fork event ever recorded for (operator, day), if any.
   *  Used by ForkDetectionService to make detection idempotent at the
   *  (operator, day) bucket level — once an operator has equivocated for
   *  a given day, additional roots don't multiply the slashing trigger. */
  async findFirstForkEventForBucket(
    operatorPubkey: string,
    dayUtc: string,
  ): Promise<ForkEvent | null> {
    const { rows } = await this.db.query<ForkEventRow>(
      `SELECT * FROM aeps_fork_events
       WHERE operator_pubkey = $1 AND day_utc = $2::date
       ORDER BY detected_at ASC, fork_event_id ASC
       LIMIT 1`,
      [operatorPubkey, dayUtc],
    );
    return rows[0] ? rowToForkEvent(rows[0]) : null;
  }

  /** Persist Nostr publication metadata on a fork event. Idempotent. */
  async recordForkNostrPublish(
    forkEventId: number,
    nostrEventId: string,
    publishedAt: number,
  ): Promise<void> {
    await this.db.query(
      `UPDATE aeps_fork_events
       SET nostr_event_id = $2,
           nostr_published_at = $3
       WHERE fork_event_id = $1`,
      [forkEventId, nostrEventId, publishedAt],
    );
  }

  async listForkEvents(
    operatorPubkey: string | null,
    limit = 100,
  ): Promise<ForkEvent[]> {
    if (operatorPubkey) {
      const { rows } = await this.db.query<ForkEventRow>(
        `SELECT * FROM aeps_fork_events
         WHERE operator_pubkey = $1
         ORDER BY detected_at DESC
         LIMIT $2`,
        [operatorPubkey, limit],
      );
      return rows.map(rowToForkEvent);
    }
    const { rows } = await this.db.query<ForkEventRow>(
      `SELECT * FROM aeps_fork_events
       ORDER BY detected_at DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map(rowToForkEvent);
  }
}

interface ObservationRow {
  observation_id: string | number;
  operator_pubkey: string;
  day_utc: string | Date;
  root_hex: string;
  source: string;
  source_ref: string | null;
  observed_at: string | number;
}

interface ForkEventRow {
  fork_event_id: string | number;
  operator_pubkey: string;
  day_utc: string | Date;
  root_hex_a: string;
  root_hex_b: string;
  observation_id_a: string | number;
  observation_id_b: string | number;
  detected_at: string | number;
  nostr_event_id: string | null;
  nostr_published_at: string | number | null;
  claim_id: string | number | null;
}

function dayOnly(d: string | Date): string {
  return typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
}

function rowToObservation(r: ObservationRow): ObservedAnchor {
  return {
    observation_id: Number(r.observation_id),
    operator_pubkey: r.operator_pubkey,
    day_utc: dayOnly(r.day_utc),
    root_hex: r.root_hex,
    source: r.source as ObservationSource,
    source_ref: r.source_ref,
    observed_at: Number(r.observed_at),
  };
}

function rowToForkEvent(r: ForkEventRow): ForkEvent {
  return {
    fork_event_id: Number(r.fork_event_id),
    operator_pubkey: r.operator_pubkey,
    day_utc: dayOnly(r.day_utc),
    root_hex_a: r.root_hex_a,
    root_hex_b: r.root_hex_b,
    observation_id_a: Number(r.observation_id_a),
    observation_id_b: Number(r.observation_id_b),
    detected_at: Number(r.detected_at),
    nostr_event_id: r.nostr_event_id,
    nostr_published_at: r.nostr_published_at !== null ? Number(r.nostr_published_at) : null,
    claim_id: r.claim_id !== null ? Number(r.claim_id) : null,
  };
}
