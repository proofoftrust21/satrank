// Phase 7 — tests d'intégration pour le crawler Nostr kind 30385.
//
// Couverture :
//   - parseOperatorEvent : shape basique, tags invalides filtrés, kind-mismatch
//   - ingestOperatorEvent : upsert + claim + verify inline (LN, NIP-05 stub, DNS stub)
//   - crawler : relayFactory injectée, events synthétiques, dedup par ev.id
//   - règle dure 2/3 : event avec 2 preuves valides → status='verified'
//   - signature Nostr rejetée (verifyEvent=false) → skip
import { webcrypto } from 'node:crypto';
if (!(globalThis as { crypto?: unknown }).crypto) {
  (globalThis as { crypto: unknown }).crypto = webcrypto;
}
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { setupTestPool, teardownTestPool, truncateAll, type TestDb } from './helpers/testDatabase';
import {
  OperatorRepository,
  OperatorIdentityRepository,
  OperatorOwnershipRepository,
} from '../repositories/operatorRepository';
import { OperatorService } from '../services/operatorService';
import {
  EndpointStreamingPosteriorRepository,
  NodeStreamingPosteriorRepository,
  ServiceStreamingPosteriorRepository,
} from '../repositories/streamingPosteriorRepository';
import {
  parseOperatorEvent,
  ingestOperatorEvent,
  OperatorCrawler,
  KIND_OPERATOR_DECLARATION,
  type OperatorNostrEvent,
  type RelayHandle,
} from '../nostr/operatorCrawler';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { buildLnChallenge } from '../services/operatorVerificationService';
let testDb: TestDb;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function makeLnSignature(operatorId: string): { pubkeyHex: string; sigHex: string } {
  const keys = secp256k1.keygen();
  const pubkeyHex = bytesToHex(keys.publicKey);
  const challenge = buildLnChallenge(operatorId);
  const msgBytes = new TextEncoder().encode(challenge);
  const sig = secp256k1.sign(msgBytes, keys.secretKey);
  return { pubkeyHex, sigHex: bytesToHex(sig) };
}

function makeEvent(overrides: Partial<OperatorNostrEvent> & { tags: string[][] }): OperatorNostrEvent {
  return {
    id: overrides.id ?? 'ev-' + Math.random().toString(36).slice(2, 14),
    kind: overrides.kind ?? KIND_OPERATOR_DECLARATION,
    pubkey: overrides.pubkey ?? 'a'.repeat(64),
    created_at: overrides.created_at ?? Math.floor(Date.now() / 1000),
    tags: overrides.tags,
    content: overrides.content ?? '',
    sig: overrides.sig ?? 'd'.repeat(128),
  };
}

// ---------------------------------------------------------------------------
// parseOperatorEvent — unit tests (pur, pas de DB)
// ---------------------------------------------------------------------------

describe('parseOperatorEvent', () => {
  it('accepte un event minimal valide', () => {
    const ev = makeEvent({
      tags: [
        ['d', 'op-123'],
        ['identity', 'ln_pubkey', '02' + 'a'.repeat(64), 'sig_hex'],
        ['owns', 'node', '02' + 'b'.repeat(64)],
      ],
    });
    const parsed = parseOperatorEvent(ev);
    expect(parsed).not.toBeNull();
    expect(parsed?.operatorId).toBe('op-123');
    expect(parsed?.identities).toHaveLength(1);
    expect(parsed?.identities[0].type).toBe('ln_pubkey');
    expect(parsed?.identities[0].proof).toBe('sig_hex');
    expect(parsed?.ownerships).toHaveLength(1);
  });

  it('rejette kind ≠ 30385', () => {
    const ev = makeEvent({ kind: 1, tags: [['d', 'op']] });
    expect(parseOperatorEvent(ev)).toBeNull();
  });

  it('rejette sans d-tag', () => {
    const ev = makeEvent({ tags: [['identity', 'ln_pubkey', 'v', 'p']] });
    expect(parseOperatorEvent(ev)).toBeNull();
  });

  it('rejette d-tag vide', () => {
    const ev = makeEvent({ tags: [['d', ''], ['identity', 'dns', 'example.com']] });
    expect(parseOperatorEvent(ev)).toBeNull();
  });

  it('rejette operator_id avec caractères invalides', () => {
    const ev = makeEvent({
      tags: [['d', 'op with spaces'], ['identity', 'dns', 'example.com']],
    });
    expect(parseOperatorEvent(ev)).toBeNull();
  });

  it('filtre les identity tags avec type inconnu', () => {
    const ev = makeEvent({
      tags: [
        ['d', 'op-1'],
        ['identity', 'email', 'x@y.z', ''],
        ['identity', 'dns', 'example.com', ''],
      ],
    });
    const parsed = parseOperatorEvent(ev);
    expect(parsed?.identities).toHaveLength(1);
    expect(parsed?.identities[0].type).toBe('dns');
  });

  it('filtre les owns tags avec type inconnu', () => {
    const ev = makeEvent({
      tags: [
        ['d', 'op-1'],
        ['owns', 'foo', 'bar'],
        ['owns', 'endpoint', 'hash123'],
      ],
    });
    const parsed = parseOperatorEvent(ev);
    expect(parsed?.ownerships).toHaveLength(1);
    expect(parsed?.ownerships[0].type).toBe('endpoint');
  });

  it('proof=null quand tag identity a seulement 3 positions', () => {
    const ev = makeEvent({
      tags: [['d', 'op-1'], ['identity', 'dns', 'example.com']],
    });
    const parsed = parseOperatorEvent(ev);
    expect(parsed?.identities[0].proof).toBeNull();
  });

  it('rejette event sans aucune identity ni owns', () => {
    const ev = makeEvent({ tags: [['d', 'op-empty']] });
    expect(parseOperatorEvent(ev)).toBeNull();
  });

  it('accepte jusqu\'à 128 chars pour operator_id', () => {
    const longId = 'a'.repeat(128);
    const ev = makeEvent({
      tags: [['d', longId], ['identity', 'dns', 'example.com']],
    });
    expect(parseOperatorEvent(ev)?.operatorId).toBe(longId);
  });

  it('rejette operator_id > 128 chars', () => {
    const ev = makeEvent({
      tags: [['d', 'a'.repeat(129)], ['identity', 'dns', 'example.com']],
    });
    expect(parseOperatorEvent(ev)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DB-backed tests: ingestOperatorEvent et OperatorCrawler partagent le pool
// ---------------------------------------------------------------------------

describe('OperatorCrawler DB-backed suite', async () => {
  let pool: Pool;
  let operators: OperatorRepository;
  let identities: OperatorIdentityRepository;
  let ownerships: OperatorOwnershipRepository;
  let service: OperatorService;

  beforeAll(async () => {
    testDb = await setupTestPool();
    pool = testDb.pool;
    operators = new OperatorRepository(pool);
    identities = new OperatorIdentityRepository(pool);
    ownerships = new OperatorOwnershipRepository(pool);
    const endpointPosteriors = new EndpointStreamingPosteriorRepository(pool);
    const nodePosteriors = new NodeStreamingPosteriorRepository(pool);
    const servicePosteriors = new ServiceStreamingPosteriorRepository(pool);
    service = new OperatorService(
      operators,
      identities,
      ownerships,
      endpointPosteriors,
      nodePosteriors,
      servicePosteriors,
    );
  });

  afterAll(async () => {
    await teardownTestPool(testDb);
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });

  describe('ingestOperatorEvent', async () => {
    it('crée un operator pending avec identity LN valide → status verified après 2nde preuve', async () => {
      const operatorId = 'op-ln-1';
      const { pubkeyHex, sigHex } = makeLnSignature(operatorId);

      const ev = makeEvent({
        tags: [
          ['d', operatorId],
          ['identity', 'ln_pubkey', pubkeyHex, sigHex],
          ['identity', 'dns', 'example.com', ''],
        ],
      });
      const parsed = parseOperatorEvent(ev)!;

      const stubDns = async (): Promise<string[][]> => [[`satrank-operator=${operatorId}`]];
      const result = await ingestOperatorEvent(parsed, service, { dnsTxtResolver: stubDns });

      expect(result.identitiesClaimed).toBe(2);
      expect(result.identitiesVerified).toBe(2);

      const op = await operators.findById(operatorId);
      expect(op?.status).toBe('verified');
      expect(op?.verification_score).toBe(2);
    });

    it('claim identity même si vérification échoue', async () => {
      const ev = makeEvent({
        tags: [
          ['d', 'op-bad-sig'],
          ['identity', 'ln_pubkey', '02' + 'a'.repeat(64), 'd'.repeat(128)],
        ],
      });
      const parsed = parseOperatorEvent(ev)!;
      const result = await ingestOperatorEvent(parsed, service);

      expect(result.identitiesClaimed).toBe(1);
      expect(result.identitiesVerified).toBe(0);
      expect(result.verifications[0].valid).toBe(false);

      const idList = await identities.findByOperator('op-bad-sig');
      expect(idList).toHaveLength(1);
      expect(idList[0].verified_at).toBeNull();
    });

    it('claim les ownerships (node/endpoint/service)', async () => {
      const ev = makeEvent({
        tags: [
          ['d', 'op-owns'],
          ['identity', 'dns', 'example.com', ''],
          ['owns', 'node', '02' + 'a'.repeat(64)],
          ['owns', 'endpoint', 'url-hash-1'],
          ['owns', 'service', 'svc-hash-1'],
        ],
      });
      const parsed = parseOperatorEvent(ev)!;
      await ingestOperatorEvent(parsed, service);

      expect(await ownerships.listNodes('op-owns')).toHaveLength(1);
      expect(await ownerships.listEndpoints('op-owns')).toHaveLength(1);
      expect(await ownerships.listServices('op-owns')).toHaveLength(1);
    });

    it('idempotent sur re-ingestion du même event', async () => {
      const ev = makeEvent({
        tags: [
          ['d', 'op-idem'],
          ['identity', 'dns', 'example.com', ''],
          ['owns', 'endpoint', 'url-hash-1'],
        ],
      });
      const parsed = parseOperatorEvent(ev)!;
      const stubDns = async (): Promise<string[][]> => [[`satrank-operator=op-idem`]];

      await ingestOperatorEvent(parsed, service, { dnsTxtResolver: stubDns });
      await ingestOperatorEvent(parsed, service, { dnsTxtResolver: stubDns });

      expect(await identities.findByOperator('op-idem')).toHaveLength(1);
      expect(await ownerships.listEndpoints('op-idem')).toHaveLength(1);
    });

    it('NIP-05 vérifie via fetcher stub', async () => {
      const nostrPk = 'f'.repeat(64);
      const stubFetcher = async (): Promise<Record<string, unknown> | null> => ({
        names: { alice: nostrPk },
      });
      const ev = makeEvent({
        tags: [
          ['d', 'op-nip05'],
          ['identity', 'nip05', 'alice@example.com', nostrPk],
        ],
      });
      const parsed = parseOperatorEvent(ev)!;
      const result = await ingestOperatorEvent(parsed, service, { nostrJsonFetcher: stubFetcher });

      expect(result.identitiesVerified).toBe(1);
    });

    it('NIP-05 avec proof manquant → not verified', async () => {
      const ev = makeEvent({
        tags: [
          ['d', 'op-nip05-noproof'],
          ['identity', 'nip05', 'alice@example.com'],
        ],
      });
      const parsed = parseOperatorEvent(ev)!;
      const result = await ingestOperatorEvent(parsed, service);

      expect(result.identitiesClaimed).toBe(1);
      expect(result.identitiesVerified).toBe(0);
      expect(result.verifications[0].reason).toBe('expected_pubkey_missing');
    });
  });

  describe('OperatorCrawler', async () => {
    interface FakeRelay extends RelayHandle {
      events: OperatorNostrEvent[];
    }

    function makeFakeRelay(events: OperatorNostrEvent[]): FakeRelay {
      return {
        events,
        subscribe(_filters, handlers) {
          for (const ev of events) handlers.onevent(ev);
          handlers.oneose?.();
          return { close: () => { /* noop */ } };
        },
        close() { /* noop */ },
      };
    }

    it('ingère les events collectés depuis un fake relay', async () => {
      const ev1 = makeEvent({
        id: 'e1',
        tags: [
          ['d', 'op-crawl-1'],
          ['identity', 'dns', 'example.com', ''],
          ['owns', 'endpoint', 'hash-1'],
        ],
      });
      const stubDns = async (): Promise<string[][]> => [[`satrank-operator=op-crawl-1`]];
      const crawler = new OperatorCrawler(service, {
        relays: ['wss://fake.relay'],
        relayFactory: async () => makeFakeRelay([ev1]),
        dnsTxtResolver: stubDns,
        subscribeTimeoutMs: 1000,
      });

      const summary = await crawler.crawl();
      expect(summary.relaysQueried).toBe(1);
      expect(summary.eventsReceived).toBe(1);
      expect(summary.eventsIngested).toBe(1);
      expect(summary.operatorsTouched.has('op-crawl-1')).toBe(true);
      expect(summary.identitiesVerified).toBe(1);
      expect(summary.ownershipsClaimed).toBe(1);
    });

    it('dedup les events par id entre relays', async () => {
      const shared = makeEvent({
        id: 'shared-id',
        tags: [['d', 'op-dedup'], ['identity', 'dns', 'example.com', '']],
      });
      const stubDns = async (): Promise<string[][]> => [[`satrank-operator=op-dedup`]];

      const crawler = new OperatorCrawler(service, {
        relays: ['wss://r1', 'wss://r2'],
        relayFactory: async () => makeFakeRelay([shared]),
        dnsTxtResolver: stubDns,
        subscribeTimeoutMs: 1000,
      });

      const summary = await crawler.crawl();
      expect(summary.relaysQueried).toBe(2);
      expect(summary.eventsReceived).toBe(1);
      expect(summary.eventsIngested).toBe(1);
    });

    it('skip events avec signature invalide (verifyEvent=false)', async () => {
      const ev = makeEvent({
        tags: [['d', 'op-badsig'], ['identity', 'dns', 'example.com', '']],
      });
      const crawler = new OperatorCrawler(service, {
        relays: ['wss://fake'],
        relayFactory: async () => makeFakeRelay([ev]),
        verifyEvent: () => false,
        subscribeTimeoutMs: 1000,
      });

      const summary = await crawler.crawl();
      expect(summary.eventsReceived).toBe(0);
      expect(summary.eventsIngested).toBe(0);
    });

    it('relay qui throw ne casse pas le crawl global', async () => {
      const ok = makeEvent({
        id: 'ok',
        tags: [['d', 'op-resilient'], ['identity', 'dns', 'example.com', '']],
      });
      const stubDns = async (): Promise<string[][]> => [[`satrank-operator=op-resilient`]];
      let callCount = 0;
      const crawler = new OperatorCrawler(service, {
        relays: ['wss://broken', 'wss://ok'],
        relayFactory: async (_url) => {
          callCount += 1;
          if (callCount === 1) throw new Error('relay down');
          return makeFakeRelay([ok]);
        },
        dnsTxtResolver: stubDns,
        subscribeTimeoutMs: 1000,
      });

      const summary = await crawler.crawl();
      expect(summary.relaysQueried).toBe(1);
      expect(summary.eventsIngested).toBe(1);
    });

    it('règle 2/3 : event avec 2 preuves valides → status verified', async () => {
      const operatorId = 'op-2of3';
      const { pubkeyHex, sigHex } = makeLnSignature(operatorId);
      const ev = makeEvent({
        tags: [
          ['d', operatorId],
          ['identity', 'ln_pubkey', pubkeyHex, sigHex],
          ['identity', 'dns', 'example.com', ''],
        ],
      });
      const stubDns = async (): Promise<string[][]> => [[`satrank-operator=${operatorId}`]];

      const crawler = new OperatorCrawler(service, {
        relays: ['wss://fake'],
        relayFactory: async () => makeFakeRelay([ev]),
        dnsTxtResolver: stubDns,
        subscribeTimeoutMs: 1000,
      });

      await crawler.crawl();

      const op = await operators.findById(operatorId);
      expect(op?.status).toBe('verified');
      expect(op?.verification_score).toBe(2);
    });
  });
});
