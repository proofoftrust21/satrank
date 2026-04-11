import { describe, it, expect } from 'vitest';
import { computePageRank } from '../scoring/pagerank';

describe('PageRank', () => {
  it('returns empty map for empty graph', () => {
    const result = computePageRank([]);
    expect(result.scores.size).toBe(0);
    expect(result.nodeCount).toBe(0);
  });

  it('assigns scores to all nodes in a simple triangle', () => {
    const edges = [
      { node1_pub: 'A', node2_pub: 'B', capacity: '1000000' },
      { node1_pub: 'B', node2_pub: 'C', capacity: '1000000' },
      { node1_pub: 'A', node2_pub: 'C', capacity: '1000000' },
    ];
    const result = computePageRank(edges);
    // Symmetric graph → all nodes should have equal raw PR, but percentile
    // ranking assigns 0, 50, 100 to break ties by position.
    expect(result.scores.size).toBe(3);
    // All scores should be reasonable (spread across the range)
    for (const [, s] of result.scores) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    }
  });

  it('hub node scores higher than leaf nodes', () => {
    // Star topology: HUB connected to 5 leaves
    const edges = [
      { node1_pub: 'HUB', node2_pub: 'L1', capacity: '1000000' },
      { node1_pub: 'HUB', node2_pub: 'L2', capacity: '1000000' },
      { node1_pub: 'HUB', node2_pub: 'L3', capacity: '1000000' },
      { node1_pub: 'HUB', node2_pub: 'L4', capacity: '1000000' },
      { node1_pub: 'HUB', node2_pub: 'L5', capacity: '1000000' },
    ];
    const result = computePageRank(edges);
    const hubScore = result.scores.get('HUB')!;
    const leafScore = result.scores.get('L1')!;
    expect(hubScore).toBe(100); // hub is the top percentile
    expect(leafScore).toBeLessThan(hubScore);
    // Leaves have the lowest PR → bottom percentiles, but still > 0 for non-bottom
    expect(leafScore).toBeGreaterThanOrEqual(0);
  });

  it('capacity-weighted: high-capacity channel boosts score', () => {
    // A—(1BTC)—HUB—(0.001BTC)—B
    const edges = [
      { node1_pub: 'A', node2_pub: 'HUB', capacity: '100000000' }, // 1 BTC
      { node1_pub: 'HUB', node2_pub: 'B', capacity: '100000' },    // 0.001 BTC
    ];
    const result = computePageRank(edges);
    const scoreA = result.scores.get('A')!;
    const scoreB = result.scores.get('B')!;
    // A has a higher-capacity link → should score higher than B
    expect(scoreA).toBeGreaterThan(scoreB);
  });

  it('hub neighbors score higher than periphery in a realistic topology', () => {
    // Core: HUB1 ↔ HUB2 ↔ HUB3 (triangle of hubs)
    // Each hub has 5 spokes. Periphery = 2-hop-away chain from a spoke.
    const edges = [
      { node1_pub: 'HUB1', node2_pub: 'HUB2', capacity: '50000000' },
      { node1_pub: 'HUB2', node2_pub: 'HUB3', capacity: '50000000' },
      { node1_pub: 'HUB1', node2_pub: 'HUB3', capacity: '50000000' },
    ];
    for (let h = 1; h <= 3; h++) {
      for (let s = 0; s < 5; s++) {
        edges.push({ node1_pub: `HUB${h}`, node2_pub: `S${h}_${s}`, capacity: '5000000' });
      }
    }
    // Peripheral chain off one spoke
    edges.push({ node1_pub: 'S1_0', node2_pub: 'PERIPH1', capacity: '1000000' });
    edges.push({ node1_pub: 'PERIPH1', node2_pub: 'PERIPH2', capacity: '500000' });

    const result = computePageRank(edges);
    const hub1 = result.scores.get('HUB1')!;
    const periph2 = result.scores.get('PERIPH2')!;

    // Hubs score in the top percentiles
    expect(hub1).toBeGreaterThanOrEqual(85);
    // Hub >> distant periphery
    expect(hub1).toBeGreaterThan(periph2);
    // All nodes have scores (100% coverage). Bottom percentile = 0 is valid.
    expect(result.scores.size).toBe(result.nodeCount);
  });

  it('converges within 50 iterations on a real-sized graph', () => {
    // Build a scale-free-ish graph with ~1000 nodes
    const edges = [];
    for (let i = 1; i < 1000; i++) {
      // Preferential attachment: connect to a random earlier node,
      // biased toward lower indices (higher-degree nodes)
      const target = Math.floor(Math.pow(Math.random(), 2) * i);
      edges.push({
        node1_pub: `N${i}`,
        node2_pub: `N${target}`,
        capacity: String(Math.floor(Math.random() * 10000000) + 100000),
      });
    }
    const result = computePageRank(edges);
    expect(result.iterations).toBeLessThanOrEqual(50);
    expect(result.scores.size).toBeGreaterThan(900);
    expect(result.durationMs).toBeLessThan(1000); // should be <100ms
  });

  it('scores are percentile-ranked 0-100', () => {
    const edges = [
      { node1_pub: 'A', node2_pub: 'B', capacity: '1000000' },
      { node1_pub: 'B', node2_pub: 'C', capacity: '1000000' },
      { node1_pub: 'C', node2_pub: 'D', capacity: '1000000' },
    ];
    const result = computePageRank(edges);
    const maxScore = Math.max(...result.scores.values());
    const minScore = Math.min(...result.scores.values());
    expect(maxScore).toBe(100); // top percentile
    expect(minScore).toBe(0);   // bottom percentile
    // All scores in range
    for (const [, s] of result.scores) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    }
  });
});
