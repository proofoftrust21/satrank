// Phase 8.1 — CrowdOutcomeIngestor : intégration validation + persistence + Sybil weight.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import {
  CrowdOutcomeRepository,
  NostrIdentityRepository,
} from '../repositories/crowdOutcomeRepository';
import { EndpointStagePosteriorsRepository } from '../repositories/endpointStagePosteriorsRepository';
import {
  CrowdOutcomeIngestor,
  type CrowdOutcomeEvent,
  KIND_CROWD_OUTCOME,
} from '../services/crowdOutcomeIngestor';

let testDb: TestDb;
const NOW = 1_700_000_000;

function makeEvent(overrides: Partial<CrowdOutcomeEvent> = {}): CrowdOutcomeEvent {
  return {
    id: 'f'.repeat(64), // 0 PoW bits
    pubkey: 'a'.repeat(64),
    kind: KIND_CROWD_OUTCOME,
    created_at: NOW,
    tags: [
      ['endpoint_url_hash', 'b'.repeat(64)],
      ['outcome', 'delivered'],
    ],
    content: '{}',
    sig: 's'.repeat(128),
    ...overrides,
  };
}

describe('CrowdOutcomeIngestor (Phase 8.1)', () => {
  let pool: Pool;
  let crowdRepo: CrowdOutcomeRepository;
  let identityRepo: NostrIdentityRepository;
  let stagesRepo: EndpointStagePosteriorsRepository;
  let ingestor: CrowdOutcomeIngestor;

  beforeEach(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    crowdRepo = new CrowdOutcomeRepository(pool);
    identityRepo = new NostrIdentityRepository(pool);
    stagesRepo = new EndpointStagePosteriorsRepository(pool);
    ingestor = new CrowdOutcomeIngestor({
      crowdRepo,
      identityRepo,
      stagePosteriorsRepo: stagesRepo,
      verifyEvent: () => true, // bypass crypto pour tests structurels
      now: () => NOW,
    });
    await truncateAll(pool);
  });

  afterEach(async () => {
    await teardownTestPool(testDb);
  });

  it('persists a valid delivered event with base weight', async () => {
    const result = await ingestor.ingest(makeEvent());
    expect(result.outcome).toBe('persisted');
    expect(result.effective_weight).toBeCloseTo(0.3, 5); // base × 1 × 1 × 1
    const record = await crowdRepo.findByEventId('f'.repeat(64));
    expect(record).not.toBeNull();
    expect(record!.outcome).toBe('delivered');
    expect(record!.success).toBe(true);
    expect(record!.stage).toBe(4);
  });

  it('rejects wrong kind', async () => {
    const result = await ingestor.ingest(makeEvent({ kind: 30782 }));
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('wrong_kind');
  });

  it('rejects when verifyEvent returns false', async () => {
    const noVerifyIngestor = new CrowdOutcomeIngestor({
      crowdRepo,
      identityRepo,
      stagePosteriorsRepo: stagesRepo,
      verifyEvent: () => false,
      now: () => NOW,
    });
    const result = await noVerifyIngestor.ingest(makeEvent());
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('signature_invalid');
  });

  it('rejects missing endpoint_url_hash tag', async () => {
    const result = await ingestor.ingest(makeEvent({
      tags: [['outcome', 'delivered']],
    }));
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('missing_or_malformed_endpoint_url_hash');
  });

  it('rejects malformed endpoint_url_hash', async () => {
    const result = await ingestor.ingest(makeEvent({
      tags: [['endpoint_url_hash', 'not-hex'], ['outcome', 'delivered']],
    }));
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('missing_or_malformed_endpoint_url_hash');
  });

  it('rejects unknown outcome', async () => {
    const result = await ingestor.ingest(makeEvent({
      tags: [['endpoint_url_hash', 'b'.repeat(64)], ['outcome', 'mystery']],
    }));
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('unknown_outcome');
  });

  it('detects duplicates via event_id', async () => {
    await ingestor.ingest(makeEvent());
    const result = await ingestor.ingest(makeEvent());
    expect(result.outcome).toBe('duplicate');
  });

  it('weighs preimage proof when sha256 matches', async () => {
    const preimage = 'a'.repeat(64);
    const paymentHash = createHash('sha256')
      .update(Buffer.from(preimage, 'hex'))
      .digest('hex');
    const result = await ingestor.ingest(makeEvent({
      tags: [
        ['endpoint_url_hash', 'b'.repeat(64)],
        ['outcome', 'delivered'],
        ['preimage', preimage],
        ['payment_hash', paymentHash],
      ],
    }));
    expect(result.outcome).toBe('persisted');
    expect(result.effective_weight).toBeCloseTo(0.3 * 1 * 1 * 2, 5); // base × no_pow × no_age × preimage_x2
    const record = await crowdRepo.findByEventId('f'.repeat(64));
    expect(record!.preimage_verified).toBe(true);
    expect(record!.preimage_factor).toBe(2.0);
  });

  it('weighs PoW bits via leading zeros count', async () => {
    const result = await ingestor.ingest(makeEvent({
      // 16 leading zero bits → pow_factor = 1.5
      id: '0000' + 'f'.repeat(60),
      tags: [
        ['endpoint_url_hash', 'b'.repeat(64)],
        ['outcome', 'delivered'],
        ['pow', '16'], // declared
      ],
    }));
    expect(result.outcome).toBe('persisted');
    expect(result.effective_weight).toBeCloseTo(0.3 * 1.5, 5);
    const record = await crowdRepo.findByEventId('0000' + 'f'.repeat(60));
    expect(record!.verified_pow_bits).toBe(16);
    expect(record!.declared_pow_bits).toBe(16);
  });

  it('weighs identity-age factor for an established Nostr key', async () => {
    // Pre-seed identity → first_seen 30 days ago.
    const past = NOW - 30 * 86400;
    await identityRepo.observeIdentity('a'.repeat(64), past);

    const result = await ingestor.ingest(makeEvent());
    expect(result.outcome).toBe('persisted');
    // 30 days → age_factor = 2.0 → weight = 0.3 × 1 × 2 × 1 = 0.6
    expect(result.effective_weight).toBeCloseTo(0.6, 5);
    const record = await crowdRepo.findByEventId('f'.repeat(64));
    expect(record!.identity_age_factor).toBe(2.0);
  });

  it('maps pay_failed outcome to stage 3 (payment) instead of stage 4', async () => {
    await ingestor.ingest(makeEvent({
      tags: [
        ['endpoint_url_hash', 'b'.repeat(64)],
        ['outcome', 'pay_failed'],
      ],
    }));
    const record = await crowdRepo.findByEventId('f'.repeat(64));
    expect(record!.stage).toBe(3);
    expect(record!.success).toBe(false);
  });
});
