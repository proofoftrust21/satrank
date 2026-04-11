// Capacity-weighted PageRank for the Lightning Network graph.
//
// Why PageRank and not betweenness/eigenvector:
//   - Betweenness is O(V×E) = 13k × 88k = 1.1B ops. Too expensive hourly.
//   - Eigenvector is mathematically equivalent for undirected graphs but
//     doesn't handle dangling nodes (dead ends). PageRank's damping fixes this.
//   - PageRank is O(iterations × E) = 50 × 88k ≈ 4.4M ops. Runs in <500ms.
//
// Why capacity-weighted:
//   A 10 BTC channel is a stronger endorsement than a 0.001 BTC channel.
//   log-scale weight: a 10 BTC channel is ~2.3× more influential than 0.1 BTC,
//   not 100×. This prevents mega-channels from completely dominating.
//
// Output: every node in the graph gets a 0-100 score. No more "centrality = 0
// because LN+ doesn't cover this node." A small agent connected to ACINQ scores
// higher than one connected to a zombie — exactly the signal agents need.

import { logger } from '../logger';

export interface PageRankEdge {
  node1_pub: string;
  node2_pub: string;
  capacity: string | number;
}

export interface PageRankResult {
  scores: Map<string, number>; // pubkey → 0-100 score
  iterations: number;
  convergenceDelta: number;
  durationMs: number;
  nodeCount: number;
  edgeCount: number;
}

const DEFAULT_DAMPING = 0.85;
const DEFAULT_MAX_ITERATIONS = 50;
const DEFAULT_TOLERANCE = 0.0001;

export function computePageRank(
  edges: PageRankEdge[],
  damping: number = DEFAULT_DAMPING,
  maxIterations: number = DEFAULT_MAX_ITERATIONS,
  tolerance: number = DEFAULT_TOLERANCE,
): PageRankResult {
  const startMs = Date.now();

  // Build adjacency list with log-capacity weights.
  // Undirected graph: each edge creates two directed links.
  const outLinks = new Map<string, Array<{ target: string; weight: number }>>();
  const allNodes = new Set<string>();

  for (const edge of edges) {
    const cap = typeof edge.capacity === 'string' ? Number(edge.capacity) : edge.capacity;
    if (cap <= 0) continue;
    allNodes.add(edge.node1_pub);
    allNodes.add(edge.node2_pub);
    const weight = Math.log(cap + 1);

    if (!outLinks.has(edge.node1_pub)) outLinks.set(edge.node1_pub, []);
    if (!outLinks.has(edge.node2_pub)) outLinks.set(edge.node2_pub, []);
    outLinks.get(edge.node1_pub)!.push({ target: edge.node2_pub, weight });
    outLinks.get(edge.node2_pub)!.push({ target: edge.node1_pub, weight });
  }

  const N = allNodes.size;
  if (N === 0) {
    return { scores: new Map(), iterations: 0, convergenceDelta: 0, durationMs: 0, nodeCount: 0, edgeCount: 0 };
  }

  const nodes = Array.from(allNodes);
  const base = (1 - damping) / N;

  // Use Float64Arrays indexed by node position for cache-friendly iteration.
  // Map pubkey → index for O(1) lookup.
  const nodeIndex = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) nodeIndex.set(nodes[i], i);

  // Build compressed adjacency: outgoing[nodeIdx] = [{targetIdx, weight}]
  const outgoing: Array<Array<{ idx: number; weight: number }>> = new Array(N);
  const totalOutWeight = new Float64Array(N);
  for (let i = 0; i < N; i++) outgoing[i] = [];

  for (const [pub, links] of outLinks) {
    const srcIdx = nodeIndex.get(pub)!;
    for (const link of links) {
      const tgtIdx = nodeIndex.get(link.target);
      if (tgtIdx === undefined) continue;
      outgoing[srcIdx].push({ idx: tgtIdx, weight: link.weight });
      totalOutWeight[srcIdx] += link.weight;
    }
  }

  // Iterate
  let scores = new Float64Array(N).fill(1 / N);
  let newScores = new Float64Array(N);
  let iterations = 0;
  let maxDelta = 0;

  for (iterations = 0; iterations < maxIterations; iterations++) {
    newScores.fill(base);

    for (let src = 0; src < N; src++) {
      const srcScore = scores[src];
      const total = totalOutWeight[src];
      if (total === 0) continue;
      const links = outgoing[src];
      for (let j = 0; j < links.length; j++) {
        newScores[links[j].idx] += damping * srcScore * (links[j].weight / total);
      }
    }

    // Check convergence
    maxDelta = 0;
    for (let i = 0; i < N; i++) {
      const delta = Math.abs(newScores[i] - scores[i]);
      if (delta > maxDelta) maxDelta = delta;
    }

    // Swap buffers
    const tmp = scores;
    scores = newScores;
    newScores = tmp;

    if (maxDelta < tolerance) {
      iterations++;
      break;
    }
  }

  // Normalize to 0-100 via PERCENTILE RANK.
  // Linear normalization (score/max*100) crushes the power-law tail to 0 —
  // 95%+ of nodes round to 0 because the top hub is orders of magnitude
  // higher. Percentile rank distributes meaningfully: a small 1-channel
  // node connected to ACINQ lands at ~30 instead of 0, which is exactly
  // what we need for the centrality sub-signal.
  const indexed: Array<{ idx: number; score: number }> = [];
  for (let i = 0; i < N; i++) indexed.push({ idx: i, score: scores[i] });
  indexed.sort((a, b) => a.score - b.score);

  const result = new Map<string, number>();
  for (let rank = 0; rank < indexed.length; rank++) {
    const percentile = Math.round((rank / (N - 1)) * 100);
    result.set(nodes[indexed[rank].idx], percentile);
  }

  const durationMs = Date.now() - startMs;
  logger.info({ nodeCount: N, edgeCount: edges.length, iterations, maxDelta: maxDelta.toExponential(3), durationMs }, 'PageRank computed');

  return { scores: result, iterations, convergenceDelta: maxDelta, durationMs, nodeCount: N, edgeCount: edges.length };
}
