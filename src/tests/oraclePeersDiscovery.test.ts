// Phase 7.1 — OraclePeersDiscovery : ingest validation + UPSERT.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import { OraclePeerRepository } from '../repositories/oracleFederationRepository';
import { OraclePeersDiscovery, type DiscoveryEvent } from '../services/oraclePeersDiscovery';

let testDb: TestDb;
const NOW = 1_700_000_000;

function makeAnnouncement(overrides: Partial<DiscoveryEvent> = {}): DiscoveryEvent {
  return {
    id: 'e'.repeat(64),
    pubkey: 'a'.repeat(64),
    kind: 30784,
    created_at: NOW,
    tags: [
      ['d', 'satrank-oracle-announcement'],
      ['oracle_pubkey', 'a'.repeat(64)],
      ['lnd_pubkey', '02' + 'b'.repeat(64)],
      ['catalogue_size', '345'],
      ['calibration_event_id', 'c'.repeat(64)],
      ['contact', 'nostr:npub1xxx'],
    ],
    content: '{"about":"test"}',
    sig: 's'.repeat(128),
    ...overrides,
  };
}

describe('OraclePeersDiscovery (Phase 7.1)', () => {
  let pool: Pool;
  let peerRepo: OraclePeerRepository;
  let discovery: OraclePeersDiscovery;

  beforeEach(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    peerRepo = new OraclePeerRepository(pool);
    discovery = new OraclePeersDiscovery({
      peerRepo,
      verifyEvent: () => true, // bypass crypto pour tests structurels
      now: () => NOW,
    });
    await truncateAll(pool);
  });

  afterEach(async () => {
    await teardownTestPool(testDb);
  });

  it('persists a valid announcement', async () => {
    const result = await discovery.ingestAnnouncement(makeAnnouncement());
    expect(result.outcome).toBe('persisted');
    const peer = await peerRepo.findByPubkey('a'.repeat(64));
    expect(peer).not.toBeNull();
    expect(peer!.catalogue_size).toBe(345);
    expect(peer!.lnd_pubkey).toBe('02' + 'b'.repeat(64));
    expect(peer!.calibration_event_id).toBe('c'.repeat(64));
    expect(peer!.contact).toBe('nostr:npub1xxx');
    expect(peer!.first_seen).toBe(NOW);
    expect(peer!.last_seen).toBe(NOW);
  });

  it('preserves first_seen across UPSERT, updates last_seen', async () => {
    await discovery.ingestAnnouncement(makeAnnouncement());
    // Simule un re-publish 1 jour plus tard.
    const laterDiscovery = new OraclePeersDiscovery({
      peerRepo,
      verifyEvent: () => true,
      now: () => NOW + 86400,
    });
    await laterDiscovery.ingestAnnouncement(
      makeAnnouncement({ id: 'f'.repeat(64), tags: [
        ['d', 'satrank-oracle-announcement'],
        ['oracle_pubkey', 'a'.repeat(64)],
        ['catalogue_size', '400'], // catalogue grew
      ]}),
    );
    const peer = await peerRepo.findByPubkey('a'.repeat(64));
    expect(peer!.first_seen).toBe(NOW); // unchanged
    expect(peer!.last_seen).toBe(NOW + 86400);
    expect(peer!.catalogue_size).toBe(400);
    expect(peer!.latest_announcement_event_id).toBe('f'.repeat(64));
  });

  it('rejects wrong kind', async () => {
    const result = await discovery.ingestAnnouncement(makeAnnouncement({ kind: 30782 }));
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('wrong_kind');
  });

  it('rejects wrong d-tag', async () => {
    const result = await discovery.ingestAnnouncement(makeAnnouncement({
      tags: [['d', 'something-else'], ['oracle_pubkey', 'a'.repeat(64)]],
    }));
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('wrong_d_tag');
  });

  it('rejects when oracle_pubkey tag does not match event.pubkey (spoofing guard)', async () => {
    const result = await discovery.ingestAnnouncement(makeAnnouncement({
      pubkey: 'a'.repeat(64),
      tags: [
        ['d', 'satrank-oracle-announcement'],
        ['oracle_pubkey', 'b'.repeat(64)], // mismatch
      ],
    }));
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('oracle_pubkey_does_not_match_signer');
  });

  it('rejects malformed oracle_pubkey', async () => {
    const result = await discovery.ingestAnnouncement(makeAnnouncement({
      tags: [
        ['d', 'satrank-oracle-announcement'],
        ['oracle_pubkey', 'not-hex'],
      ],
    }));
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('malformed_oracle_pubkey');
  });

  it('Security H3 — onboarding_url javascript: protocol → null (anti-XSS)', async () => {
    const result = await discovery.ingestAnnouncement(makeAnnouncement({
      tags: [
        ['d', 'satrank-oracle-announcement'],
        ['oracle_pubkey', 'a'.repeat(64)],
        ['catalogue_size', '345'],
        ['onboarding_url', 'javascript:alert(1)'],
      ],
    }));
    expect(result.outcome).toBe('persisted');
    const peer = await peerRepo.findByPubkey('a'.repeat(64));
    expect(peer!.onboarding_url).toBeNull(); // strippé par le validator
  });

  it('Security H3 — onboarding_url http: protocol → null (force https)', async () => {
    await discovery.ingestAnnouncement(makeAnnouncement({
      tags: [
        ['d', 'satrank-oracle-announcement'],
        ['oracle_pubkey', 'a'.repeat(64)],
        ['onboarding_url', 'http://insecure.example/onboard'],
      ],
    }));
    const peer = await peerRepo.findByPubkey('a'.repeat(64));
    expect(peer!.onboarding_url).toBeNull();
  });

  it('Security H3 — onboarding_url https://valid → persisted', async () => {
    await discovery.ingestAnnouncement(makeAnnouncement({
      tags: [
        ['d', 'satrank-oracle-announcement'],
        ['oracle_pubkey', 'a'.repeat(64)],
        ['onboarding_url', 'https://safe.example/onboard'],
      ],
    }));
    const peer = await peerRepo.findByPubkey('a'.repeat(64));
    expect(peer!.onboarding_url).toBe('https://safe.example/onboard');
  });

  it('Security H6 — catalogue_size > 1M clamped (Postgres int overflow protection)', async () => {
    await discovery.ingestAnnouncement(makeAnnouncement({
      tags: [
        ['d', 'satrank-oracle-announcement'],
        ['oracle_pubkey', 'a'.repeat(64)],
        ['catalogue_size', '99999999999'], // huge value
      ],
    }));
    const peer = await peerRepo.findByPubkey('a'.repeat(64));
    expect(peer!.catalogue_size).toBe(1_000_000); // clamped
  });

  it('Security M1 — contact > 200 chars truncated', async () => {
    const longContact = 'x'.repeat(500);
    await discovery.ingestAnnouncement(makeAnnouncement({
      tags: [
        ['d', 'satrank-oracle-announcement'],
        ['oracle_pubkey', 'a'.repeat(64)],
        ['contact', longContact],
      ],
    }));
    const peer = await peerRepo.findByPubkey('a'.repeat(64));
    expect(peer!.contact!.length).toBe(200);
  });

  it('rejects when signature verify fails', async () => {
    const sigFailDiscovery = new OraclePeersDiscovery({
      peerRepo,
      verifyEvent: () => false,
      now: () => NOW,
    });
    const result = await sigFailDiscovery.ingestAnnouncement(makeAnnouncement());
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('signature_invalid');
  });
});
