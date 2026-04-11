// Indexes Lightning Network nodes from our LND node's graph view.
// Primary source — replaces mempool.space for full graph coverage.
// Mainnet today: ~14,000 active Lightning nodes after UTXO validation.
import type { AgentRepository } from '../repositories/agentRepository';
import type { ChannelSnapshotRepository } from '../repositories/channelSnapshotRepository';
import type { FeeSnapshotRepository } from '../repositories/feeSnapshotRepository';
import type { LndGraphClient, LndNode, LndEdge, LndNodeInfo } from './lndGraphClient';
import { computePageRank } from '../scoring/pagerank';
import { sha256 } from '../utils/crypto';
import { logger } from '../logger';

export interface LndGraphCrawlResult {
  startedAt: number;
  finishedAt: number;
  nodesFetched: number;
  newAgents: number;
  updatedAgents: number;
  errors: string[];
  syncedToGraph: boolean;
}

interface ParsedNode {
  pubKey: string;
  alias: string;
  lastUpdate: number;
  channels: number;
  capacitySats: number;
  uniquePeers: number;
  disabledChannels: number;
}

export class LndGraphCrawler {
  constructor(
    private client: LndGraphClient,
    private agentRepo: AgentRepository,
    private channelSnapshotRepo?: ChannelSnapshotRepository,
    private feeSnapshotRepo?: FeeSnapshotRepository,
  ) {}

  async run(): Promise<LndGraphCrawlResult> {
    const startedAt = Math.floor(Date.now() / 1000);
    const result: LndGraphCrawlResult = {
      startedAt,
      finishedAt: 0,
      nodesFetched: 0,
      newAgents: 0,
      updatedAgents: 0,
      errors: [],
      syncedToGraph: false,
    };

    // Check if LND node is synced to graph
    let info;
    try {
      info = await this.client.getInfo();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`getInfo failed: ${msg}`);
      result.finishedAt = Math.floor(Date.now() / 1000);
      return result;
    }

    result.syncedToGraph = info.synced_to_graph;
    if (!info.synced_to_graph) {
      result.errors.push('LND node not synced to graph');
      result.finishedAt = Math.floor(Date.now() / 1000);
      return result;
    }

    // Fetch full graph
    let graph;
    try {
      graph = await this.client.getGraph();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`getGraph failed: ${msg}`);
      result.finishedAt = Math.floor(Date.now() / 1000);
      return result;
    }

    // Build per-node channel count and capacity from edges
    const nodeStats = this.aggregateEdges(graph.edges);
    result.nodesFetched = graph.nodes.length;

    // Index each node
    for (const node of graph.nodes) {
      try {
        const stats = nodeStats.get(node.pub_key) ?? { channels: 0, capacitySats: 0, uniquePeers: 0, disabledChannels: 0 };
        const parsed: ParsedNode = {
          pubKey: node.pub_key,
          alias: node.alias || node.pub_key.slice(0, 20),
          lastUpdate: node.last_update,
          channels: stats.channels,
          capacitySats: stats.capacitySats,
          uniquePeers: stats.uniquePeers,
          disabledChannels: stats.disabledChannels,
        };
        const action = this.indexNode(parsed);
        if (action === 'created') result.newAgents++;
        else if (action === 'updated') result.updatedAgents++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`node ${node.pub_key.slice(0, 16)}: ${msg}`);
      }
    }

    // Store channel snapshots for predictive signals (flow, drain)
    if (this.channelSnapshotRepo) {
      const now = Math.floor(Date.now() / 1000);
      const snapshots = Array.from(nodeStats.entries()).map(([pub, stats]) => ({
        agent_hash: sha256(pub),
        channel_count: stats.channels,
        capacity_sats: stats.capacitySats,
        snapshot_at: now,
      }));
      this.channelSnapshotRepo.insertBatch(snapshots);
      logger.info({ count: snapshots.length }, 'Channel snapshots stored');
    }

    // Store fee snapshots for volatility index — one per direction per edge
    if (this.feeSnapshotRepo && graph.edges.length > 0) {
      const now = Math.floor(Date.now() / 1000);
      const feeSnapshots: Array<{ channel_id: string; node1_pub: string; node2_pub: string; fee_base_msat: number; fee_rate_ppm: number; snapshot_at: number }> = [];
      for (const e of graph.edges) {
        if (e.node1_policy) {
          feeSnapshots.push({
            channel_id: e.channel_id,
            node1_pub: e.node1_pub,
            node2_pub: e.node2_pub,
            fee_base_msat: parseInt(e.node1_policy.fee_base_msat, 10) || 0,
            fee_rate_ppm: parseInt(e.node1_policy.fee_rate_milli_msat, 10) || 0,
            snapshot_at: now,
          });
        }
        if (e.node2_policy) {
          feeSnapshots.push({
            channel_id: e.channel_id,
            node1_pub: e.node2_pub,
            node2_pub: e.node1_pub,
            fee_base_msat: parseInt(e.node2_policy.fee_base_msat, 10) || 0,
            fee_rate_ppm: parseInt(e.node2_policy.fee_rate_milli_msat, 10) || 0,
            snapshot_at: now,
          });
        }
      }
      if (feeSnapshots.length > 0) {
        const inserted = this.feeSnapshotRepo.insertBatchDeduped(feeSnapshots);
        logger.info({ candidates: feeSnapshots.length, inserted }, 'Fee snapshots stored (deduped)');
      }
    }

    // Compute sovereign PageRank from the full graph — replaces LN+ dependency
    // for the centrality sub-signal. Covers 100% of nodes (vs ~70% with LN+).
    if (graph.edges.length > 0) {
      const prResult = computePageRank(graph.edges);
      this.agentRepo.updatePageRankBatch(prResult.scores);
    }

    result.finishedAt = Math.floor(Date.now() / 1000);
    logger.info({
      duration: result.finishedAt - result.startedAt,
      fetched: result.nodesFetched,
      newAgents: result.newAgents,
      updated: result.updatedAgents,
      errors: result.errors.length,
    }, 'LND graph crawl finished');

    return result;
  }

  // Index a single node by pubkey (used for auto-indexation)
  async indexSingleNode(pubkey: string): Promise<'created' | 'updated' | 'skipped' | 'not_found'> {
    let nodeInfo: LndNodeInfo | null;
    try {
      nodeInfo = await this.client.getNodeInfo(pubkey);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ pubkey: pubkey.slice(0, 16), error: msg }, 'Failed to fetch single node from LND');
      throw err;
    }

    if (!nodeInfo) return 'not_found';

    const parsed: ParsedNode = {
      pubKey: nodeInfo.node.pub_key,
      alias: nodeInfo.node.alias || nodeInfo.node.pub_key.slice(0, 20),
      lastUpdate: nodeInfo.node.last_update,
      channels: nodeInfo.num_channels,
      capacitySats: Number(nodeInfo.total_capacity),
      uniquePeers: 0, // Single-node fetch doesn't have edge data; updated on next full crawl
      disabledChannels: 0, // Same — updated on next full crawl
    };

    return this.indexNode(parsed);
  }

  private aggregateEdges(edges: LndEdge[]): Map<string, { channels: number; capacitySats: number; uniquePeers: number; disabledChannels: number }> {
    const channels = new Map<string, { count: number; capacitySats: number }>();
    const peers = new Map<string, Set<string>>();
    const disabled = new Map<string, number>();

    for (const edge of edges) {
      const cap = Number(edge.capacity);

      for (const pub of [edge.node1_pub, edge.node2_pub]) {
        const existing = channels.get(pub);
        if (existing) {
          channels.set(pub, { count: existing.count + 1, capacitySats: existing.capacitySats + cap });
        } else {
          channels.set(pub, { count: 1, capacitySats: cap });
        }
      }

      // Track unique peers for each node
      if (!peers.has(edge.node1_pub)) peers.set(edge.node1_pub, new Set());
      if (!peers.has(edge.node2_pub)) peers.set(edge.node2_pub, new Set());
      peers.get(edge.node1_pub)!.add(edge.node2_pub);
      peers.get(edge.node2_pub)!.add(edge.node1_pub);

      // Count disabled channel directions per node
      if (edge.node1_policy?.disabled) {
        disabled.set(edge.node1_pub, (disabled.get(edge.node1_pub) ?? 0) + 1);
      }
      if (edge.node2_policy?.disabled) {
        disabled.set(edge.node2_pub, (disabled.get(edge.node2_pub) ?? 0) + 1);
      }
    }

    const stats = new Map<string, { channels: number; capacitySats: number; uniquePeers: number; disabledChannels: number }>();
    for (const [pub, ch] of channels) {
      stats.set(pub, {
        channels: ch.count,
        capacitySats: ch.capacitySats,
        uniquePeers: peers.get(pub)?.size ?? 0,
        disabledChannels: disabled.get(pub) ?? 0,
      });
    }
    return stats;
  }

  private indexNode(node: ParsedNode): 'created' | 'updated' | 'skipped' {
    if (!node.pubKey) throw new Error('Missing pubKey');

    const publicKeyHash = sha256(node.pubKey);
    const existing = this.agentRepo.findByHash(publicKeyHash);
    const now = Math.floor(Date.now() / 1000);
    // Only use lastUpdate if it's a real gossip timestamp (> 0).
    // Never inject Date.now() as proxy — it corrupts regularity scoring for dead nodes.
    const validLastUpdate = node.lastUpdate > 0 ? node.lastUpdate : null;

    if (existing) {
      if (!existing.public_key) {
        this.agentRepo.updatePublicKey(publicKeyHash, node.pubKey);
      }
      const lastSeen = validLastUpdate ?? existing.last_seen;
      if (existing.source === 'lightning_graph') {
        this.agentRepo.updateLightningStats(
          publicKeyHash,
          node.channels,
          node.capacitySats,
          node.alias,
          lastSeen,
          node.uniquePeers,
          node.disabledChannels,
        );
      } else {
        this.agentRepo.updateCapacity(publicKeyHash, node.capacitySats, lastSeen);
      }
      return 'updated';
    }

    // Cross-source consolidation — only merge if existing agent has no public_key
    // (aliases are user-chosen and non-unique, so matching on alias alone is unsafe)
    const aliasMatch = this.agentRepo.findByExactAlias(node.alias);
    if (aliasMatch && aliasMatch.public_key_hash !== publicKeyHash && !aliasMatch.public_key) {
      this.agentRepo.updatePublicKey(aliasMatch.public_key_hash, node.pubKey);
      this.agentRepo.updateCapacity(aliasMatch.public_key_hash, node.capacitySats, validLastUpdate ?? aliasMatch.last_seen);
      return 'updated';
    }

    this.agentRepo.insert({
      public_key_hash: publicKeyHash,
      public_key: node.pubKey,
      alias: node.alias,
      first_seen: validLastUpdate ?? now,
      last_seen: validLastUpdate ?? now,
      source: 'lightning_graph',
      total_transactions: node.channels,
      total_attestations_received: 0,
      avg_score: 0,
      capacity_sats: node.capacitySats,
      positive_ratings: 0,
      negative_ratings: 0,
      lnplus_rank: 0,
      hubness_rank: 0,
      betweenness_rank: 0,
      hopness_rank: 0,
      query_count: 0,
      unique_peers: node.uniquePeers > 0 ? node.uniquePeers : null,
      last_queried_at: null,
    });

    return 'created';
  }
}
