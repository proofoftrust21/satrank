// Indexes Lightning Network nodes from our LND node's graph view
// Primary source — replaces mempool.space for full graph coverage (~17,000 nodes)
import type { AgentRepository } from '../repositories/agentRepository';
import type { LndGraphClient, LndNode, LndEdge, LndNodeInfo } from './lndGraphClient';
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
}

export class LndGraphCrawler {
  constructor(
    private client: LndGraphClient,
    private agentRepo: AgentRepository,
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
        const stats = nodeStats.get(node.pub_key) ?? { channels: 0, capacitySats: 0 };
        const parsed: ParsedNode = {
          pubKey: node.pub_key,
          alias: node.alias || node.pub_key.slice(0, 20),
          lastUpdate: node.last_update,
          channels: stats.channels,
          capacitySats: stats.capacitySats,
        };
        const action = this.indexNode(parsed);
        if (action === 'created') result.newAgents++;
        else if (action === 'updated') result.updatedAgents++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`node ${node.pub_key.slice(0, 16)}: ${msg}`);
      }
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
    };

    return this.indexNode(parsed);
  }

  private aggregateEdges(edges: LndEdge[]): Map<string, { channels: number; capacitySats: number }> {
    const stats = new Map<string, { channels: number; capacitySats: number }>();

    for (const edge of edges) {
      const cap = Number(edge.capacity);

      for (const pub of [edge.node1_pub, edge.node2_pub]) {
        const existing = stats.get(pub);
        if (existing) {
          stats.set(pub, { channels: existing.channels + 1, capacitySats: existing.capacitySats + cap });
        } else {
          stats.set(pub, { channels: 1, capacitySats: cap });
        }
      }
    }

    return stats;
  }

  private indexNode(node: ParsedNode): 'created' | 'updated' | 'skipped' {
    if (!node.pubKey) throw new Error('Missing pubKey');

    const publicKeyHash = sha256(node.pubKey);
    const existing = this.agentRepo.findByHash(publicKeyHash);
    const now = Math.floor(Date.now() / 1000);

    if (existing) {
      if (!existing.public_key) {
        this.agentRepo.updatePublicKey(publicKeyHash, node.pubKey);
      }
      if (existing.source === 'lightning_graph') {
        this.agentRepo.updateLightningStats(
          publicKeyHash,
          node.channels,
          node.capacitySats,
          node.alias,
          node.lastUpdate || now,
        );
      } else {
        this.agentRepo.updateCapacity(publicKeyHash, node.capacitySats, node.lastUpdate || now);
      }
      return 'updated';
    }

    // Cross-source consolidation — only merge if existing agent has no public_key
    // (aliases are user-chosen and non-unique, so matching on alias alone is unsafe)
    const aliasMatch = this.agentRepo.findByExactAlias(node.alias);
    if (aliasMatch && aliasMatch.public_key_hash !== publicKeyHash && !aliasMatch.public_key) {
      this.agentRepo.updatePublicKey(aliasMatch.public_key_hash, node.pubKey);
      this.agentRepo.updateCapacity(aliasMatch.public_key_hash, node.capacitySats, node.lastUpdate || now);
      return 'updated';
    }

    this.agentRepo.insert({
      public_key_hash: publicKeyHash,
      public_key: node.pubKey,
      alias: node.alias,
      first_seen: node.lastUpdate || now,
      last_seen: node.lastUpdate || now,
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
    });

    return 'created';
  }
}
