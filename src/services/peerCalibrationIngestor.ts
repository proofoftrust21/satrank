// Phase 9.1 — peer calibration ingestor.
//
// Ingest les kind 30783 calibration events publiés par les autres oracles
// SatRank-compatible via subscribe permanent. Persiste dans
// peer_calibration_observations pour exposition via
// /api/oracle/peers/:pubkey/calibrations.
//
// Validation :
//   1. kind === 30783
//   2. d-tag === 'satrank-calibration'
//   3. Schnorr sig (verifyEvent)
//   4. window_start / window_end tags numériques cohérents
//   5. event id non déjà vu (dedup via UPSERT ON CONFLICT)
//
// Ne consume PAS notre propre publication (kind 30783) — on filtre par
// pubkey != selfOraclePubkey. Sinon on créerait une boucle de
// "self-cross-attestation" qui n'apporte rien.
import { logger } from '../logger';
import type { PeerCalibrationRepository } from '../repositories/peerCalibrationRepository';

export const KIND_ORACLE_CALIBRATION = 30783;

export interface PeerCalibrationEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface PeerCalibrationIngestorDeps {
  peerCalibrationRepo: PeerCalibrationRepository;
  /** Pubkey de NOTRE oracle. Skip self pour éviter d'auto-référencer. */
  selfOraclePubkey: string;
  verifyEvent: (event: PeerCalibrationEvent) => boolean;
  now?: () => number;
}

export interface IngestResult {
  outcome: 'persisted' | 'rejected' | 'duplicate' | 'skipped_self';
  reason?: string;
}

const ANNOUNCEMENT_D_TAG = 'satrank-calibration';

/** Security L4 — clamp un nombre en int32 sécurisé. Rejette NaN / Infinity
 *  → fallback min. */
function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export class PeerCalibrationIngestor {
  private readonly now: () => number;

  constructor(private readonly deps: PeerCalibrationIngestorDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async ingest(event: PeerCalibrationEvent): Promise<IngestResult> {
    if (event.kind !== KIND_ORACLE_CALIBRATION) {
      return { outcome: 'rejected', reason: 'wrong_kind' };
    }
    if (event.pubkey === this.deps.selfOraclePubkey) {
      return { outcome: 'skipped_self' };
    }
    const dTag = event.tags.find((t) => t[0] === 'd');
    if (!dTag || dTag[1] !== ANNOUNCEMENT_D_TAG) {
      return { outcome: 'rejected', reason: 'wrong_d_tag' };
    }
    if (!this.deps.verifyEvent(event)) {
      return { outcome: 'rejected', reason: 'signature_invalid' };
    }

    const tagMap = new Map(event.tags.map((t) => [t[0], t[1]]));
    const windowStartRaw = tagMap.get('window_start');
    const windowEndRaw = tagMap.get('window_end');
    const windowStart = windowStartRaw ? Number(windowStartRaw) : NaN;
    const windowEnd = windowEndRaw ? Number(windowEndRaw) : NaN;
    if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd <= windowStart) {
      return { outcome: 'rejected', reason: 'invalid_window' };
    }

    const parseNullable = (raw: string | undefined): number | null => {
      if (!raw || raw === 'null') return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };

    const inserted = await this.deps.peerCalibrationRepo.insertIfNew({
      event_id: event.id,
      peer_pubkey: event.pubkey,
      window_start: windowStart,
      window_end: windowEnd,
      delta_mean: parseNullable(tagMap.get('delta_mean')),
      delta_median: parseNullable(tagMap.get('delta_median')),
      delta_p95: parseNullable(tagMap.get('delta_p95')),
      // Security L4 — `| 0` truncate à int32 et wrap les grands nombres
      // en négatifs (ex. "2147483649" | 0 === -2147483647). Clamp explicite.
      n_endpoints: clampInt(Number(tagMap.get('n_endpoints') ?? '0'), 0, 1_000_000),
      n_outcomes: clampInt(Number(tagMap.get('n_outcomes') ?? '0'), 0, 10_000_000),
      observed_at: this.now(),
    });

    if (!inserted) {
      return { outcome: 'duplicate' };
    }

    logger.info(
      {
        eventId: event.id.slice(0, 12),
        peer: event.pubkey.slice(0, 12),
        delta_mean: tagMap.get('delta_mean'),
        n_endpoints: tagMap.get('n_endpoints'),
      },
      'PeerCalibrationIngestor: peer calibration ingested',
    );
    return { outcome: 'persisted' };
  }
}
