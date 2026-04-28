// Phase 7.0 — kind 30784 oracle announcement publisher : pure builder + cycle.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import { CalibrationRepository } from '../repositories/calibrationRepository';
import { OracleAnnouncementRepository } from '../repositories/oracleFederationRepository';
import {
  OracleAnnouncementPublisher,
  buildAnnouncementTemplate,
  KIND_ORACLE_ANNOUNCEMENT,
} from '../services/oracleAnnouncementPublisher';
import type { NostrMultiKindPublisher } from '../nostr/nostrMultiKindPublisher';

let testDb: TestDb;
const ORACLE_PK = 'a'.repeat(64);
const NOW = 1_700_000_000;

describe('buildAnnouncementTemplate (pure)', () => {
  it('emits kind 30784 with required tags + content', () => {
    const template = buildAnnouncementTemplate({
      oraclePubkey: ORACLE_PK,
      lndPubkey: '02' + 'b'.repeat(64),
      catalogueSize: 345,
      calibrationEventId: 'c'.repeat(64),
      lastAssertionEventId: 'd'.repeat(64),
      about: 'test oracle',
      version: '1.0',
      capabilities: ['5-stage-posterior', 'mcp-server'],
      contact: 'nostr:npub1xxx',
      onboardingUrl: 'https://example.com/onboard',
      createdAt: NOW,
    });
    expect(template.kind).toBe(KIND_ORACLE_ANNOUNCEMENT);
    expect(template.kind).toBe(30784);
    const tagMap = Object.fromEntries(template.tags.map((t) => [t[0], t[1]]));
    expect(tagMap.d).toBe('satrank-oracle-announcement');
    expect(tagMap.oracle_pubkey).toBe(ORACLE_PK);
    expect(tagMap.lnd_pubkey).toBe('02' + 'b'.repeat(64));
    expect(tagMap.catalogue_size).toBe('345');
    expect(tagMap.calibration_event_id).toBe('c'.repeat(64));
    expect(tagMap.contact).toBe('nostr:npub1xxx');
    const content = JSON.parse(template.content);
    expect(content.about).toBe('test oracle');
    expect(content.version).toBe('1.0');
    expect(content.capabilities).toContain('5-stage-posterior');
  });

  it('omits optional tags when not provided', () => {
    const template = buildAnnouncementTemplate({
      oraclePubkey: ORACLE_PK,
      catalogueSize: 0,
      calibrationEventId: null,
      lastAssertionEventId: null,
      about: 'minimal',
      version: '1.0',
      capabilities: [],
      createdAt: NOW,
    });
    const tagKeys = template.tags.map((t) => t[0]);
    expect(tagKeys).not.toContain('lnd_pubkey');
    expect(tagKeys).not.toContain('calibration_event_id');
    expect(tagKeys).not.toContain('contact');
    expect(tagKeys).not.toContain('onboarding_url');
    expect(tagKeys).toContain('oracle_pubkey');
    expect(tagKeys).toContain('catalogue_size');
  });
});

describe('OracleAnnouncementPublisher.publishCycle (intégration)', () => {
  let pool: Pool;
  let serviceRepo: ServiceEndpointRepository;
  let calibRepo: CalibrationRepository;
  let announceRepo: OracleAnnouncementRepository;

  beforeEach(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    serviceRepo = new ServiceEndpointRepository(pool);
    calibRepo = new CalibrationRepository(pool);
    announceRepo = new OracleAnnouncementRepository(pool);
    await truncateAll(pool);
  });

  afterEach(async () => {
    await teardownTestPool(testDb);
  });

  function makeFakePublisher(eventId: string): { publisher: NostrMultiKindPublisher; lastTemplate: { kind: number; tags: string[][] } | null } {
    const state = { lastTemplate: null as null | { kind: number; tags: string[][] } };
    const publisher = {
      publishTemplate: async (t: { kind: number; tags: string[][]; created_at: number }) => {
        state.lastTemplate = t;
        return {
          eventId,
          kind: t.kind,
          publishedAt: t.created_at,
          acks: [{ relay: 'wss://test', result: 'success' as const }],
          anySuccess: true,
        };
      },
    } as unknown as NostrMultiKindPublisher;
    return { publisher, lastTemplate: state.lastTemplate };
  }

  it('publishes when no recent announcement, persists audit', async () => {
    const fake = makeFakePublisher('e'.repeat(64));
    const publisher = new OracleAnnouncementPublisher({
      serviceEndpointRepo: serviceRepo,
      calibrationRepo: calibRepo,
      announcementRepo: announceRepo,
      publisher: fake.publisher,
      oraclePubkey: ORACLE_PK,
      relays: ['wss://test'],
      now: () => NOW,
    });
    const result = await publisher.publishCycle();
    expect(result).not.toBeNull();
    expect(result!.event_id).toBe('e'.repeat(64));
    expect(result!.catalogue_size).toBe(0); // catalogue vide
    const latest = await announceRepo.findLatest();
    expect(latest).not.toBeNull();
    expect(latest!.event_id).toBe('e'.repeat(64));
  });

  it('skips re-publish when announcement < 20h old (idempotence)', async () => {
    const fake = makeFakePublisher('e'.repeat(64));
    const publisher = new OracleAnnouncementPublisher({
      serviceEndpointRepo: serviceRepo,
      calibrationRepo: calibRepo,
      announcementRepo: announceRepo,
      publisher: fake.publisher,
      oraclePubkey: ORACLE_PK,
      relays: ['wss://test'],
      now: () => NOW,
    });
    await publisher.publishCycle();

    // Re-publish 10h plus tard → skip.
    const publisher2 = new OracleAnnouncementPublisher({
      serviceEndpointRepo: serviceRepo,
      calibrationRepo: calibRepo,
      announcementRepo: announceRepo,
      publisher: fake.publisher,
      oraclePubkey: ORACLE_PK,
      relays: ['wss://test'],
      now: () => NOW + 10 * 3600,
    });
    const skipped = await publisher2.publishCycle();
    expect(skipped).toBeNull();

    // 25h plus tard → re-publish.
    const publisher3 = new OracleAnnouncementPublisher({
      serviceEndpointRepo: serviceRepo,
      calibrationRepo: calibRepo,
      announcementRepo: announceRepo,
      publisher: fake.publisher,
      oraclePubkey: ORACLE_PK,
      relays: ['wss://test'],
      now: () => NOW + 25 * 3600,
    });
    const re = await publisher3.publishCycle();
    expect(re).not.toBeNull();
  });

  it('embarque calibration_event_id quand un run existe', async () => {
    await calibRepo.insertCalibrationRun({
      window_start: NOW - 7 * 86400,
      window_end: NOW,
      delta_mean: 0.04,
      delta_median: 0.03,
      delta_p95: 0.10,
      n_endpoints: 5,
      n_outcomes: 30,
      published_event_id: 'cal'.padEnd(64, '0'),
      created_at: NOW,
    });
    const fake = makeFakePublisher('e'.repeat(64));
    const publisher = new OracleAnnouncementPublisher({
      serviceEndpointRepo: serviceRepo,
      calibrationRepo: calibRepo,
      announcementRepo: announceRepo,
      publisher: fake.publisher,
      oraclePubkey: ORACLE_PK,
      relays: ['wss://test'],
      now: () => NOW,
    });
    const result = await publisher.publishCycle();
    expect(result!.calibration_event_id).toBe('cal'.padEnd(64, '0'));
    const latest = await announceRepo.findLatest();
    expect(latest!.calibration_event_id).toBe('cal'.padEnd(64, '0'));
  });
});
