// Phase 9.1 — PeerCalibrationIngestor : validation + persistence.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import { PeerCalibrationRepository } from '../repositories/peerCalibrationRepository';
import {
  PeerCalibrationIngestor,
  type PeerCalibrationEvent,
  KIND_ORACLE_CALIBRATION,
} from '../services/peerCalibrationIngestor';

let testDb: TestDb;
const NOW = 1_700_000_000;
const SELF_PUBKEY = 's'.repeat(64);
const PEER_PUBKEY = 'p'.repeat(64);

function makeEvent(overrides: Partial<PeerCalibrationEvent> = {}): PeerCalibrationEvent {
  return {
    id: 'e'.repeat(64),
    pubkey: PEER_PUBKEY,
    kind: KIND_ORACLE_CALIBRATION,
    created_at: NOW,
    tags: [
      ['d', 'satrank-calibration'],
      ['window_start', String(NOW - 7 * 86400)],
      ['window_end', String(NOW)],
      ['delta_mean', '0.0345'],
      ['delta_median', '0.0214'],
      ['delta_p95', '0.0892'],
      ['n_endpoints', '287'],
      ['n_outcomes', '4521'],
      ['oracle_pubkey', PEER_PUBKEY],
    ],
    content: '{}',
    sig: 's'.repeat(128),
    ...overrides,
  };
}

describe('PeerCalibrationIngestor (Phase 9.1)', () => {
  let pool: Pool;
  let calibRepo: PeerCalibrationRepository;
  let ingestor: PeerCalibrationIngestor;

  beforeEach(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    calibRepo = new PeerCalibrationRepository(pool);
    ingestor = new PeerCalibrationIngestor({
      peerCalibrationRepo: calibRepo,
      selfOraclePubkey: SELF_PUBKEY,
      verifyEvent: () => true,
      now: () => NOW,
    });
    await truncateAll(pool);
  });

  afterEach(async () => {
    await teardownTestPool(testDb);
  });

  it('persists a valid peer calibration event', async () => {
    const result = await ingestor.ingest(makeEvent());
    expect(result.outcome).toBe('persisted');
    const record = await calibRepo.findByEventId('e'.repeat(64));
    expect(record).not.toBeNull();
    expect(record!.peer_pubkey).toBe(PEER_PUBKEY);
    expect(record!.delta_mean).toBe(0.0345);
    expect(record!.n_endpoints).toBe(287);
  });

  it('skips self-published calibration events', async () => {
    const result = await ingestor.ingest(makeEvent({ pubkey: SELF_PUBKEY }));
    expect(result.outcome).toBe('skipped_self');
  });

  it('rejects wrong kind', async () => {
    const result = await ingestor.ingest(makeEvent({ kind: 30782 }));
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('wrong_kind');
  });

  it('rejects wrong d-tag', async () => {
    const result = await ingestor.ingest(makeEvent({
      tags: [['d', 'wrong-tag'], ['window_start', '0'], ['window_end', '1']],
    }));
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('wrong_d_tag');
  });

  it('rejects when verifyEvent returns false', async () => {
    const sigFailIngestor = new PeerCalibrationIngestor({
      peerCalibrationRepo: calibRepo,
      selfOraclePubkey: SELF_PUBKEY,
      verifyEvent: () => false,
      now: () => NOW,
    });
    const result = await sigFailIngestor.ingest(makeEvent());
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('signature_invalid');
  });

  it('rejects invalid window (end <= start)', async () => {
    const result = await ingestor.ingest(makeEvent({
      tags: [
        ['d', 'satrank-calibration'],
        ['window_start', String(NOW)],
        ['window_end', String(NOW - 100)], // negative window
      ],
    }));
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('invalid_window');
  });

  it('handles null delta tags from bootstrap calibration runs', async () => {
    const result = await ingestor.ingest(makeEvent({
      tags: [
        ['d', 'satrank-calibration'],
        ['window_start', String(NOW - 7 * 86400)],
        ['window_end', String(NOW)],
        ['delta_mean', 'null'],
        ['n_endpoints', '0'],
        ['n_outcomes', '0'],
      ],
    }));
    expect(result.outcome).toBe('persisted');
    const record = await calibRepo.findByEventId('e'.repeat(64));
    expect(record!.delta_mean).toBeNull();
    expect(record!.n_endpoints).toBe(0);
  });

  it('detects duplicates via event_id', async () => {
    await ingestor.ingest(makeEvent());
    const result = await ingestor.ingest(makeEvent());
    expect(result.outcome).toBe('duplicate');
  });

  it('listByPeer returns calibrations sorted by window_end DESC', async () => {
    await ingestor.ingest(makeEvent({
      id: '1'.repeat(64),
      tags: [
        ['d', 'satrank-calibration'],
        ['window_start', String(NOW - 14 * 86400)],
        ['window_end', String(NOW - 7 * 86400)],
        ['delta_mean', '0.05'],
      ],
    }));
    await ingestor.ingest(makeEvent({
      id: '2'.repeat(64),
      tags: [
        ['d', 'satrank-calibration'],
        ['window_start', String(NOW - 7 * 86400)],
        ['window_end', String(NOW)],
        ['delta_mean', '0.03'],
      ],
    }));
    const peerCalibrations = await calibRepo.listByPeer(PEER_PUBKEY);
    expect(peerCalibrations).toHaveLength(2);
    expect(peerCalibrations[0].window_end).toBeGreaterThan(peerCalibrations[1].window_end);
  });
});
