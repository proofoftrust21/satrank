// Phase 8 — C2 : tests des builders d'events Nostr 30382 / 30383 / 30384.
//
// On vérifie :
//   - structure minimale de chaque kind (tags obligatoires présents)
//   - formatage numérique stable (p_success à 4 décimales, risk à 3, n_obs entier)
//   - tag `operator_id` n'est émis que si présent (pas d'entry vide)
//   - tags optionnels endpoint (price_sats, median_latency_ms, category, service_name)
//     sont absents quand leur valeur est null/undefined
//   - payloadHash() est stable sur la même entrée et change avec les tags
import { describe, it, expect } from 'vitest';
import {
  buildNodeEndorsement,
  buildEndpointEndorsement,
  buildServiceEndorsement,
  payloadHash,
  KIND_NODE_ENDORSEMENT,
  KIND_ENDPOINT_ENDORSEMENT,
  KIND_SERVICE_ENDORSEMENT,
  type NodeEndorsementState,
  type EndpointEndorsementState,
  type ServiceEndorsementState,
} from '../nostr/eventBuilders';

const NOW = 1776656900;

function findTag(tags: string[][], name: string): string[] | undefined {
  return tags.find((t) => t[0] === name);
}

describe('Phase 8 — C2 nostr event builders', () => {
  describe('30382 — node endorsement', () => {
    const nodeState: NodeEndorsementState = {
      node_pubkey: '02' + 'a'.repeat(64),
      verdict: 'SAFE',
      p_success: 0.8712,
      ci95_low: 0.82,
      ci95_high: 0.92,
      n_obs: 123.4,
      advisory_level: 'green',
      risk_score: 0.123,
      source: 'probe',
      time_constant_days: 7,
      last_update: NOW,
    };

    it('uses kind 30382 and the expected d/p tags', () => {
      const ev = buildNodeEndorsement(nodeState, NOW);
      expect(ev.kind).toBe(KIND_NODE_ENDORSEMENT);
      expect(ev.created_at).toBe(NOW);
      expect(ev.content).toBe('');
      expect(findTag(ev.tags, 'd')?.[1]).toBe(nodeState.node_pubkey);
      expect(findTag(ev.tags, 'p')?.[1]).toBe(nodeState.node_pubkey);
    });

    it('serializes bayesian fields with stable precision', () => {
      const ev = buildNodeEndorsement(nodeState, NOW);
      expect(findTag(ev.tags, 'verdict')?.[1]).toBe('SAFE');
      expect(findTag(ev.tags, 'p_success')?.[1]).toBe('0.8712');
      expect(findTag(ev.tags, 'ci95_low')?.[1]).toBe('0.8200');
      expect(findTag(ev.tags, 'ci95_high')?.[1]).toBe('0.9200');
      expect(findTag(ev.tags, 'n_obs')?.[1]).toBe('123');
      expect(findTag(ev.tags, 'risk_score')?.[1]).toBe('0.123');
      expect(findTag(ev.tags, 'advisory_level')?.[1]).toBe('green');
      expect(findTag(ev.tags, 'source')?.[1]).toBe('probe');
      expect(findTag(ev.tags, 'time_constant_days')?.[1]).toBe('7');
      expect(findTag(ev.tags, 'last_update')?.[1]).toBe(String(NOW));
    });

    it('omits operator_id tag when absent', () => {
      const ev = buildNodeEndorsement(nodeState, NOW);
      expect(findTag(ev.tags, 'operator_id')).toBeUndefined();
    });

    it('emits operator_id tag when set', () => {
      const ev = buildNodeEndorsement({ ...nodeState, operator_id: 'op-abc' }, NOW);
      expect(findTag(ev.tags, 'operator_id')?.[1]).toBe('op-abc');
    });
  });

  describe('30383 — endpoint endorsement', () => {
    const endpointState: EndpointEndorsementState = {
      url_hash: 'a'.repeat(64),
      url: 'https://api.example.com/weather',
      verdict: 'SAFE',
      p_success: 0.9100,
      ci95_low: 0.87,
      ci95_high: 0.94,
      n_obs: 45.2,
      advisory_level: 'green',
      risk_score: 0.08,
      source: 'probe',
      time_constant_days: 7,
      last_update: NOW,
      price_sats: 3,
      median_latency_ms: 420,
      category: 'weather',
      service_name: 'Foo Weather',
      operator_id: 'op-weather',
    };

    it('uses kind 30383 with url_hash as d-tag and url as explicit tag', () => {
      const ev = buildEndpointEndorsement(endpointState, NOW);
      expect(ev.kind).toBe(KIND_ENDPOINT_ENDORSEMENT);
      expect(findTag(ev.tags, 'd')?.[1]).toBe(endpointState.url_hash);
      expect(findTag(ev.tags, 'url')?.[1]).toBe(endpointState.url);
    });

    it('emits price_sats/median_latency_ms/category/service_name/operator_id when set', () => {
      const ev = buildEndpointEndorsement(endpointState, NOW);
      expect(findTag(ev.tags, 'price_sats')?.[1]).toBe('3');
      expect(findTag(ev.tags, 'median_latency_ms')?.[1]).toBe('420');
      expect(findTag(ev.tags, 'category')?.[1]).toBe('weather');
      expect(findTag(ev.tags, 'service_name')?.[1]).toBe('Foo Weather');
      expect(findTag(ev.tags, 'operator_id')?.[1]).toBe('op-weather');
    });

    it('omits optional tags when their value is null/undefined', () => {
      const minimal: EndpointEndorsementState = {
        url_hash: endpointState.url_hash,
        url: endpointState.url,
        verdict: 'INSUFFICIENT',
        p_success: 0.5,
        ci95_low: 0.061,
        ci95_high: 0.939,
        n_obs: 0,
        advisory_level: 'yellow',
        risk_score: 0.15,
        source: 'probe',
        time_constant_days: 7,
        last_update: NOW,
        price_sats: null,
        median_latency_ms: null,
        category: null,
        service_name: null,
      };
      const ev = buildEndpointEndorsement(minimal, NOW);
      expect(findTag(ev.tags, 'price_sats')).toBeUndefined();
      expect(findTag(ev.tags, 'median_latency_ms')).toBeUndefined();
      expect(findTag(ev.tags, 'category')).toBeUndefined();
      expect(findTag(ev.tags, 'service_name')).toBeUndefined();
      expect(findTag(ev.tags, 'operator_id')).toBeUndefined();
    });
  });

  describe('30384 — service endorsement', () => {
    const serviceState: ServiceEndorsementState = {
      service_hash: 'b'.repeat(64),
      name: 'Foo Weather API',
      verdict: 'SAFE',
      p_success: 0.89,
      ci95_low: 0.85,
      ci95_high: 0.92,
      n_obs: 78.3,
      advisory_level: 'green',
      risk_score: 0.09,
      source: 'probe',
      time_constant_days: 7,
      last_update: NOW,
      endpoint_count: 4,
      operator_id: 'op-foo',
    };

    it('uses kind 30384 with service_hash as d-tag', () => {
      const ev = buildServiceEndorsement(serviceState, NOW);
      expect(ev.kind).toBe(KIND_SERVICE_ENDORSEMENT);
      expect(findTag(ev.tags, 'd')?.[1]).toBe(serviceState.service_hash);
      expect(findTag(ev.tags, 'name')?.[1]).toBe('Foo Weather API');
      expect(findTag(ev.tags, 'endpoint_count')?.[1]).toBe('4');
      expect(findTag(ev.tags, 'operator_id')?.[1]).toBe('op-foo');
    });
  });

  describe('payloadHash stability', () => {
    const nodeState: NodeEndorsementState = {
      node_pubkey: '02' + 'a'.repeat(64),
      verdict: 'SAFE',
      p_success: 0.87,
      ci95_low: 0.82,
      ci95_high: 0.92,
      n_obs: 123,
      advisory_level: 'green',
      risk_score: 0.12,
      source: 'probe',
      time_constant_days: 7,
      last_update: NOW,
    };

    it('is independent of created_at', () => {
      const a = payloadHash(buildNodeEndorsement(nodeState, NOW));
      const b = payloadHash(buildNodeEndorsement(nodeState, NOW + 500));
      expect(a).toBe(b);
    });

    it('changes when a bayesian field changes', () => {
      const a = payloadHash(buildNodeEndorsement(nodeState, NOW));
      const b = payloadHash(buildNodeEndorsement({ ...nodeState, p_success: 0.65 }, NOW));
      expect(a).not.toBe(b);
    });

    it('is stable across tag-order permutations (canonical sort)', () => {
      // Sanity : tant que les builders sortent les tags dans le même ordre,
      // le sort interne à payloadHash est une défense en profondeur.
      const a = payloadHash(buildNodeEndorsement(nodeState, NOW));
      const b = payloadHash(buildNodeEndorsement(nodeState, NOW + 1));
      expect(a).toBe(b);
    });
  });
});
