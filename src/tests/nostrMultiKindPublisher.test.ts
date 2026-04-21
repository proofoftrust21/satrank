// Phase 8 — C3 : tests du NostrMultiKindPublisher.
//
// On injecte un binding mock pour nostr-tools afin d'isoler la logique du
// publisher de la dépendance ESM. Les tests vérifient :
//   - connect() ouvre les connexions, gère les échecs par relai
//   - close() ferme tout proprement
//   - publishNodeEndorsement / Endpoint / Service signent et publient sur
//     tous les relais connectés
//   - l'échec d'un relai ne bloque pas les autres (Promise.all settled)
//   - publishTemplate remonte les acks par relai avec le bon result type
//   - anySuccess reflète correctement le statut agrégé
import { describe, it, expect, beforeEach } from 'vitest';
import {
  NostrMultiKindPublisher,
  type NostrToolsBindings,
} from '../nostr/nostrMultiKindPublisher';
import type {
  NodeEndorsementState,
  EndpointEndorsementState,
  ServiceEndorsementState,
} from '../nostr/eventBuilders';

// --- Mock nostr-tools bindings ---
interface MockRelay {
  url: string;
  closed: boolean;
  publishedEvents: Array<{ id: string; kind: number; tags: string[][] }>;
  /** Mode d'échec : false = ok, 'timeout' = setTimeout forever, 'error' = throw. */
  mode: 'ok' | 'timeout' | 'error';
  publish: (signed: { id: string; kind: number; tags: string[][] }) => Promise<void>;
  close: () => void;
}

async function createMockRelay(url: string, mode: 'ok' | 'timeout' | 'error' = 'ok'): MockRelay {
  const r: MockRelay = {
    url,
    closed: false,
    publishedEvents: [],
    mode,
    publish: async (signed) => {
      if (r.mode === 'error') throw new Error('relay rejected');
      if (r.mode === 'timeout') await new Promise<void>(() => { /* forever */ });
      r.publishedEvents.push(signed);
    },
    close: () => { r.closed = true; },
  };
  return r;
}

function createMockBindings(relayModes: Record<string, 'ok' | 'timeout' | 'error' | 'connect-fail'>): {
  bindings: NostrToolsBindings;
  relays: Map<string, MockRelay>;
  connectAttempts: string[];
} {
  const relays = new Map<string, MockRelay>();
  const connectAttempts: string[] = [];
  const bindings: NostrToolsBindings = {
    finalizeEvent: (template, _sk) => ({
      id: 'evt-' + template.kind + '-' + (template.tags.find((t) => t[0] === 'd')?.[1] ?? 'x'),
      kind: template.kind,
      tags: template.tags,
      content: template.content,
      sig: 'mock-sig',
      pubkey: 'mock-pk',
      created_at: template.created_at,
    }),
    hexToBytes: (_hex) => new Uint8Array(32),
    connectRelay: async (url: string) => {
      connectAttempts.push(url);
      const mode = relayModes[url] ?? 'ok';
      if (mode === 'connect-fail') throw new Error('connection refused');
      const relay = await createMockRelay(url, mode);
      relays.set(url, relay);
      return relay;
    },
  };
  return { bindings, relays, connectAttempts };
}

const SK_HEX = '1'.repeat(64);
const RELAYS = ['wss://r1.test', 'wss://r2.test', 'wss://r3.test'];

const nodeState: NodeEndorsementState = {
  node_pubkey: '02' + 'a'.repeat(64),
  verdict: 'SAFE',
  p_success: 0.87,
  ci95_low: 0.82,
  ci95_high: 0.92,
  n_obs: 120,
  advisory_level: 'green',
  risk_score: 0.1,
  source: 'probe',
  time_constant_days: 7,
  last_update: 1776000000,
};

describe('Phase 8 — C3 NostrMultiKindPublisher', () => {
  describe('connect / close', () => {
    it('opens connections to all relays on connect()', async () => {
      const { bindings, relays, connectAttempts } = createMockBindings({});
      const pub = new NostrMultiKindPublisher({ privateKeyHex: SK_HEX, relays: RELAYS }, bindings);
      await pub.connect();
      expect(connectAttempts).toEqual(RELAYS);
      expect(pub.connectedRelayCount).toBe(3);
      expect(relays.size).toBe(3);
    });

    it('tolerates a relay that refuses connection', async () => {
      const { bindings } = createMockBindings({ 'wss://r2.test': 'connect-fail' });
      const pub = new NostrMultiKindPublisher({ privateKeyHex: SK_HEX, relays: RELAYS }, bindings);
      await pub.connect();
      expect(pub.connectedRelayCount).toBe(2);
    });

    it('close() marks all relays closed and is idempotent', async () => {
      const { bindings, relays } = createMockBindings({});
      const pub = new NostrMultiKindPublisher({ privateKeyHex: SK_HEX, relays: RELAYS }, bindings);
      await pub.connect();
      await pub.close();
      for (const r of relays.values()) expect(r.closed).toBe(true);
      expect(pub.connectedRelayCount).toBe(0);
      await pub.close(); // second call should not throw
    });

    it('connect() is idempotent — second call does not reconnect', async () => {
      const { bindings, connectAttempts } = createMockBindings({});
      const pub = new NostrMultiKindPublisher({ privateKeyHex: SK_HEX, relays: RELAYS }, bindings);
      await pub.connect();
      await pub.connect();
      expect(connectAttempts.length).toBe(3);
    });
  });

  describe('publishNodeEndorsement', () => {
    it('signs a kind 30382 and publishes to all relays on success', async () => {
      const { bindings, relays } = createMockBindings({});
      const pub = new NostrMultiKindPublisher({ privateKeyHex: SK_HEX, relays: RELAYS }, bindings);
      await pub.connect();
      const res = await pub.publishNodeEndorsement(nodeState, 1776000000);
      expect(res.kind).toBe(30382);
      expect(res.eventId).toContain('30382');
      expect(res.anySuccess).toBe(true);
      expect(res.acks).toHaveLength(3);
      for (const ack of res.acks) expect(ack.result).toBe('success');
      for (const r of relays.values()) expect(r.publishedEvents).toHaveLength(1);
    });

    it('connects automatically if not pre-connected', async () => {
      const { bindings } = createMockBindings({});
      const pub = new NostrMultiKindPublisher({ privateKeyHex: SK_HEX, relays: RELAYS }, bindings);
      const res = await pub.publishNodeEndorsement(nodeState, 1776000000);
      expect(res.anySuccess).toBe(true);
      expect(pub.connectedRelayCount).toBe(3);
    });

    it('reports per-relay failures without blocking the others', async () => {
      const { bindings } = createMockBindings({ 'wss://r2.test': 'error' });
      const pub = new NostrMultiKindPublisher({ privateKeyHex: SK_HEX, relays: RELAYS }, bindings);
      await pub.connect();
      const res = await pub.publishNodeEndorsement(nodeState, 1776000000);
      const byRelay = Object.fromEntries(res.acks.map((a) => [a.relay, a.result]));
      expect(byRelay['wss://r1.test']).toBe('success');
      expect(byRelay['wss://r2.test']).toBe('error');
      expect(byRelay['wss://r3.test']).toBe('success');
      expect(res.anySuccess).toBe(true);
    });

    it('classifies a slow relay as timeout (not error)', async () => {
      const { bindings } = createMockBindings({ 'wss://r2.test': 'timeout' });
      const pub = new NostrMultiKindPublisher(
        { privateKeyHex: SK_HEX, relays: RELAYS, publishTimeoutMs: 50 },
        bindings,
      );
      await pub.connect();
      const res = await pub.publishNodeEndorsement(nodeState, 1776000000);
      const byRelay = Object.fromEntries(res.acks.map((a) => [a.relay, a.result]));
      expect(byRelay['wss://r2.test']).toBe('timeout');
    });

    it('anySuccess is false when every relay fails', async () => {
      const { bindings } = createMockBindings({
        'wss://r1.test': 'error',
        'wss://r2.test': 'error',
        'wss://r3.test': 'error',
      });
      const pub = new NostrMultiKindPublisher({ privateKeyHex: SK_HEX, relays: RELAYS }, bindings);
      await pub.connect();
      const res = await pub.publishNodeEndorsement(nodeState, 1776000000);
      expect(res.anySuccess).toBe(false);
      for (const ack of res.acks) expect(ack.result).toBe('error');
    });
  });

  describe('publishEndpointEndorsement', () => {
    it('signs a kind 30383 with url_hash as d-tag', async () => {
      const { bindings, relays } = createMockBindings({});
      const pub = new NostrMultiKindPublisher({ privateKeyHex: SK_HEX, relays: RELAYS }, bindings);
      const endpointState: EndpointEndorsementState = {
        url_hash: 'a'.repeat(64),
        url: 'https://api.example.com/x',
        verdict: 'SAFE',
        p_success: 0.9,
        ci95_low: 0.85,
        ci95_high: 0.93,
        n_obs: 50,
        advisory_level: 'green',
        risk_score: 0.1,
        source: 'probe',
        time_constant_days: 7,
        last_update: 1776000000,
      };
      const res = await pub.publishEndpointEndorsement(endpointState, 1776000000);
      expect(res.kind).toBe(30383);
      const relay = relays.get('wss://r1.test')!;
      const ev = relay.publishedEvents[0];
      expect(ev.tags.find((t) => t[0] === 'd')?.[1]).toBe(endpointState.url_hash);
    });
  });

  describe('publishServiceEndorsement', () => {
    it('signs a kind 30384 with service_hash as d-tag', async () => {
      const { bindings, relays } = createMockBindings({});
      const pub = new NostrMultiKindPublisher({ privateKeyHex: SK_HEX, relays: RELAYS }, bindings);
      const serviceState: ServiceEndorsementState = {
        service_hash: 'b'.repeat(64),
        name: 'X Service',
        verdict: 'SAFE',
        p_success: 0.88,
        ci95_low: 0.82,
        ci95_high: 0.92,
        n_obs: 70,
        advisory_level: 'green',
        risk_score: 0.09,
        source: 'report',
        time_constant_days: 7,
        last_update: 1776000000,
        endpoint_count: 4,
      };
      const res = await pub.publishServiceEndorsement(serviceState, 1776000000);
      expect(res.kind).toBe(30384);
      const relay = relays.get('wss://r1.test')!;
      const ev = relay.publishedEvents[0];
      expect(ev.tags.find((t) => t[0] === 'd')?.[1]).toBe(serviceState.service_hash);
      expect(ev.tags.find((t) => t[0] === 'name')?.[1]).toBe('X Service');
    });
  });
});

// Minimal beforeEach to satisfy the linter when file has no shared state
beforeEach(() => { /* noop */ });
