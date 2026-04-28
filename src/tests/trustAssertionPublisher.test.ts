// Phase 6.2 — TrustAssertionPublisher : pure builder + intégration cycle.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import { ServiceEndpointRepository } from '../repositories/serviceEndpointRepository';
import { AgentRepository } from '../repositories/agentRepository';
import {
  EndpointStagePosteriorsRepository,
  STAGE_CHALLENGE,
  STAGE_DELIVERY,
} from '../repositories/endpointStagePosteriorsRepository';
import { CalibrationRepository } from '../repositories/calibrationRepository';
import { TrustAssertionRepository } from '../repositories/trustAssertionRepository';
import {
  TrustAssertionPublisher,
  buildTrustAssertionTemplate,
  KIND_TRUST_ASSERTION,
  TRUST_ASSERTION_TTL_SEC,
} from '../services/trustAssertionPublisher';
import type { NostrMultiKindPublisher } from '../nostr/nostrMultiKindPublisher';
import { sha256 } from '../utils/crypto';
import { endpointHash } from '../utils/urlCanonical';
import type { Agent } from '../types';
import type { ServiceEndpoint, ServiceEndpoint as RepoServiceEndpoint } from '../repositories/serviceEndpointRepository';

let testDb: TestDb;
const ORACLE_PK = 'satrank-test-oracle-pubkey';
const NOW = 1_700_000_000;

function makeAgent(hash: string): Agent {
  return {
    public_key_hash: hash,
    public_key: `02${hash.slice(0, 64)}`,
    alias: 'op',
    first_seen: NOW - 365 * 86400,
    last_seen: NOW - 86400,
    source: 'attestation',
    total_transactions: 0,
    total_attestations_received: 0,
    avg_score: 70,
    capacity_sats: null,
    positive_ratings: 0,
    negative_ratings: 0,
    lnplus_rank: 0,
    hubness_rank: 0,
    betweenness_rank: 0,
    hopness_rank: 0,
    unique_peers: null,
    last_queried_at: null,
    query_count: 0,
  };
}

function makeFakePublisher(): { publisher: NostrMultiKindPublisher; lastTemplate: { kind: number; tags: string[][]; content: string } | null; eventIdCounter: { n: number } } {
  const state = { lastTemplate: null as null | { kind: number; tags: string[][]; content: string }, eventIdCounter: { n: 0 } };
  const publisher = {
    publishTemplate: async (template: { kind: number; tags: string[][]; content: string; created_at: number }) => {
      state.lastTemplate = template;
      const id = `e${state.eventIdCounter.n.toString().padStart(63, '0')}`;
      state.eventIdCounter.n += 1;
      return {
        eventId: id,
        kind: template.kind,
        publishedAt: template.created_at,
        acks: [{ relay: 'wss://test.relay', result: 'success' as const }],
        anySuccess: true,
      };
    },
  } as unknown as NostrMultiKindPublisher;
  return { publisher, lastTemplate: state.lastTemplate, eventIdCounter: state.eventIdCounter };
}

describe('buildTrustAssertionTemplate (pure)', () => {
  it('emits kind 30782 with required tags + content schema', () => {
    const endpoint = {
      url: 'https://x.test/api',
      service_price_sats: 5,
      http_method: 'POST' as const,
      category: 'data/finance',
    } as RepoServiceEndpoint;
    const template = buildTrustAssertionTemplate(
      endpoint,
      'h'.repeat(64),
      {
        stages: {
          challenge: { stage: 'challenge', alpha: 9, beta: 1, p_success: 0.9, ci95_low: 0.6, ci95_high: 0.99, n_obs: 7, is_meaningful: true },
        },
        p_e2e: 0.9,
        p_e2e_pessimistic: 0.6,
        p_e2e_optimistic: 0.99,
        meaningful_stages: ['challenge'],
        measured_stages: 1,
      },
      ORACLE_PK,
      'cal-event-id-abc'.padEnd(64, '0'),
      NOW,
    );
    expect(template.kind).toBe(KIND_TRUST_ASSERTION);
    expect(template.kind).toBe(30782);
    const tagMap = Object.fromEntries(template.tags.map((t) => [t[0], t[1]]));
    expect(tagMap.d).toBe('h'.repeat(64));
    expect(tagMap.endpoint_url).toBe('https://x.test/api');
    expect(tagMap.p_e2e).toBe('0.9000');
    expect(tagMap.http_method).toBe('POST');
    expect(tagMap.price_sats).toBe('5');
    expect(tagMap.calibration_proof).toBe('cal-event-id-abc'.padEnd(64, '0'));
    expect(Number(tagMap.valid_until)).toBe(NOW + TRUST_ASSERTION_TTL_SEC);
    const content = JSON.parse(template.content);
    expect(content.schema_version).toBe(1);
    expect(content.p_e2e).toBe(0.9);
    expect(content.stages.challenge.is_meaningful).toBe(true);
  });

  it('omits calibration_proof tag when null', () => {
    const endpoint = {
      url: 'https://x.test/api',
      service_price_sats: null,
      http_method: 'GET' as const,
      category: null,
    } as RepoServiceEndpoint;
    const template = buildTrustAssertionTemplate(
      endpoint,
      'h'.repeat(64),
      { stages: {}, p_e2e: null, p_e2e_pessimistic: null, p_e2e_optimistic: null, meaningful_stages: [], measured_stages: 0 },
      ORACLE_PK,
      null,
      NOW,
    );
    const tagKeys = template.tags.map((t) => t[0]);
    expect(tagKeys).not.toContain('calibration_proof');
    expect(tagKeys).not.toContain('price_sats');
    expect(tagKeys).not.toContain('category');
  });
});

describe('TrustAssertionPublisher.publishCycle (intégration)', () => {
  let pool: Pool;
  let serviceRepo: ServiceEndpointRepository;
  let agentRepo: AgentRepository;
  let stagesRepo: EndpointStagePosteriorsRepository;
  let calibRepo: CalibrationRepository;
  let trustRepo: TrustAssertionRepository;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    serviceRepo = new ServiceEndpointRepository(pool);
    agentRepo = new AgentRepository(pool);
    stagesRepo = new EndpointStagePosteriorsRepository(pool);
    calibRepo = new CalibrationRepository(pool);
    trustRepo = new TrustAssertionRepository(pool);
  });

  afterAll(async () => {
    await teardownTestPool(testDb);
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });

  async function seedEndpoint(url: string, hashSeed: string): Promise<ServiceEndpoint> {
    const hash = sha256(hashSeed);
    await agentRepo.insert(makeAgent(hash));
    await serviceRepo.upsert(hash, url, 200, 100, '402index');
    await serviceRepo.updateMetadata(url, {
      name: hashSeed,
      description: null,
      category: 'data/finance',
      provider: null,
    });
    await serviceRepo.updatePrice(url, 5);
    return (await serviceRepo.findByUrl(url))! as unknown as ServiceEndpoint;
  }

  it('publishes for an endpoint with meaningful stages', async () => {
    const url = 'https://meaningful.cal/api';
    await seedEndpoint(url, 'meaningful');
    // 9 successes stage 1 (challenge) → meaningful (n_obs ≥ 3)
    for (let i = 0; i < 9; i++) {
      await stagesRepo.observe(
        { endpoint_url: url, stage: STAGE_CHALLENGE, success: true },
        NOW,
      );
    }

    const fake = makeFakePublisher();
    const publisher = new TrustAssertionPublisher({
      serviceEndpointRepo: serviceRepo,
      stagePosteriorsRepo: stagesRepo,
      calibrationRepo: calibRepo,
      trustAssertionRepo: trustRepo,
      publisher: fake.publisher,
      oraclePubkey: ORACLE_PK,
      relays: ['wss://test.relay'],
      now: () => NOW,
    });
    const summary = await publisher.publishCycle();
    expect(summary.outcomes.published).toBe(1);
    expect(summary.outcomes.skipped_no_meaningful).toBe(0);
    const persisted = await trustRepo.findByUrlHash(endpointHash(url));
    expect(persisted).not.toBeNull();
    expect(persisted!.event_id).toMatch(/^e0{63}$/);
    expect(persisted!.meaningful_stages_count).toBe(1);
    expect(persisted!.valid_until).toBe(NOW + TRUST_ASSERTION_TTL_SEC);
  });

  it('skips endpoints with no meaningful stage', async () => {
    const url = 'https://no-data.cal/api';
    await seedEndpoint(url, 'no-data');
    // 1 obs sur stage 1 → n_obs=1 < 3 → not meaningful
    await stagesRepo.observe({ endpoint_url: url, stage: STAGE_CHALLENGE, success: true }, NOW);

    const fake = makeFakePublisher();
    const publisher = new TrustAssertionPublisher({
      serviceEndpointRepo: serviceRepo,
      stagePosteriorsRepo: stagesRepo,
      calibrationRepo: calibRepo,
      trustAssertionRepo: trustRepo,
      publisher: fake.publisher,
      oraclePubkey: ORACLE_PK,
      relays: ['wss://test.relay'],
      now: () => NOW,
    });
    const summary = await publisher.publishCycle();
    expect(summary.outcomes.published).toBe(0);
    expect(summary.outcomes.skipped_no_meaningful).toBe(1);
    const persisted = await trustRepo.findByUrlHash(endpointHash(url));
    expect(persisted).toBeNull();
  });

  it('idempotence : skipped_recent on second cycle within 6 days', async () => {
    const url = 'https://idem.cal/api';
    await seedEndpoint(url, 'idem');
    for (let i = 0; i < 9; i++) {
      await stagesRepo.observe({ endpoint_url: url, stage: STAGE_DELIVERY, success: true }, NOW);
    }
    const fake = makeFakePublisher();
    const make = (now: number) => new TrustAssertionPublisher({
      serviceEndpointRepo: serviceRepo,
      stagePosteriorsRepo: stagesRepo,
      calibrationRepo: calibRepo,
      trustAssertionRepo: trustRepo,
      publisher: fake.publisher,
      oraclePubkey: ORACLE_PK,
      relays: ['wss://test.relay'],
      now: () => now,
    });

    const cycle1 = await make(NOW).publishCycle();
    expect(cycle1.outcomes.published).toBe(1);

    // 3 jours plus tard, même cron → skipped_recent
    const cycle2 = await make(NOW + 3 * 86400).publishCycle();
    expect(cycle2.outcomes.skipped_recent).toBe(1);
    expect(cycle2.outcomes.published).toBe(0);

    // 7 jours plus tard, déjà au-delà skip window → re-publish OK
    const cycle3 = await make(NOW + 7 * 86400).publishCycle();
    expect(cycle3.outcomes.published).toBe(1);
  });

  it('records calibration_proof from latest run when present', async () => {
    const url = 'https://chained.cal/api';
    await seedEndpoint(url, 'chained');
    for (let i = 0; i < 9; i++) {
      await stagesRepo.observe({ endpoint_url: url, stage: STAGE_CHALLENGE, success: true }, NOW);
    }
    // Insert un calibration run avec un event_id connu.
    const calibEventId = 'cal'.padEnd(64, '0');
    await calibRepo.insertCalibrationRun({
      window_start: NOW - 7 * 86400,
      window_end: NOW,
      delta_mean: 0.05,
      delta_median: 0.04,
      delta_p95: 0.10,
      n_endpoints: 5,
      n_outcomes: 30,
      published_event_id: calibEventId,
      created_at: NOW,
    });

    const fake = makeFakePublisher();
    const publisher = new TrustAssertionPublisher({
      serviceEndpointRepo: serviceRepo,
      stagePosteriorsRepo: stagesRepo,
      calibrationRepo: calibRepo,
      trustAssertionRepo: trustRepo,
      publisher: fake.publisher,
      oraclePubkey: ORACLE_PK,
      relays: ['wss://test.relay'],
      now: () => NOW,
    });
    await publisher.publishCycle();

    const persisted = await trustRepo.findByUrlHash(endpointHash(url));
    expect(persisted!.calibration_proof_event_id).toBe(calibEventId);
  });
});
