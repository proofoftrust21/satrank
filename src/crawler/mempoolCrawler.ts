// Indexes Lightning Network nodes from mempool.space into our agents table
// Channels = volume proxy, capacity = trust indicator, updatedAt = regularity
import type { AgentRepository } from '../repositories/agentRepository';
import type { MempoolClient, MempoolNode } from './mempoolClient';
import { sha256 } from '../utils/crypto';
import { logger } from '../logger';

export interface MempoolCrawlResult {
  startedAt: number;
  finishedAt: number;
  nodesFetched: number;
  newAgents: number;
  updatedAgents: number;
  errors: string[];
}

export class MempoolCrawler {
  constructor(
    private client: MempoolClient,
    private agentRepo: AgentRepository,
  ) {}

  async run(): Promise<MempoolCrawlResult> {
    const startedAt = Math.floor(Date.now() / 1000);
    const result: MempoolCrawlResult = {
      startedAt,
      finishedAt: 0,
      nodesFetched: 0,
      newAgents: 0,
      updatedAgents: 0,
      errors: [],
    };

    let nodes: MempoolNode[];
    try {
      nodes = await this.client.fetchTopNodes();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Fetch failed: ${msg}`);
      result.finishedAt = Math.floor(Date.now() / 1000);
      logger.warn({ error: msg }, 'mempool.space unavailable, skipping Lightning crawl');
      return result;
    }

    result.nodesFetched = nodes.length;

    for (const node of nodes) {
      try {
        const indexed = await this.indexNode(node);
        if (indexed === 'created') result.newAgents++;
        else if (indexed === 'updated') result.updatedAgents++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`node ${node.publicKey?.slice(0, 16) ?? 'unknown'}: ${msg}`);
      }
    }

    result.finishedAt = Math.floor(Date.now() / 1000);
    logger.info({
      duration: result.finishedAt - result.startedAt,
      fetched: result.nodesFetched,
      newAgents: result.newAgents,
      updated: result.updatedAgents,
      errors: result.errors.length,
    }, 'Mempool crawl finished');

    return result;
  }

  private async indexNode(node: MempoolNode): Promise<'created' | 'updated' | 'skipped'> {
    if (!node.publicKey || !node.alias) {
      throw new Error('Missing publicKey or alias');
    }

    const publicKeyHash = sha256(node.publicKey);
    // TOCTOU fix: pre-check before idempotent INSERT. `agentRepo.insert` uses
    // ON CONFLICT DO NOTHING so parallel crawlers never raise; the pre-check
    // only decides whether to take the update branch (existing) vs insert.
    const existing = await this.agentRepo.findByHash(publicKeyHash);

    if (existing) {
      // Always store/refresh the original pubkey for LN+ lookups
      if (!existing.public_key) {
        await this.agentRepo.updatePublicKey(publicKeyHash, node.publicKey);
      }
      if (existing.source === 'lightning_graph') {
        // Full update for Lightning nodes: channels, capacity, alias, lastSeen
        await this.agentRepo.updateLightningStats(
          publicKeyHash,
          node.channels,
          node.capacity,
          node.alias,
          node.updatedAt,
        );
      } else {
        // Other sources: only enrich with capacity and refresh lastSeen
        await this.agentRepo.updateCapacity(publicKeyHash, node.capacity, node.updatedAt);
      }
      return 'updated';
    }

    // Cross-source consolidation: if an agent with the same alias already
    // exists (e.g. from a legacy source that hashed alias rather than pubkey),
    // enrich it instead of creating a duplicate entry
    const aliasMatch = await this.agentRepo.findByExactAlias(node.alias);
    if (aliasMatch && aliasMatch.public_key_hash !== publicKeyHash) {
      await this.agentRepo.updateCapacity(aliasMatch.public_key_hash, node.capacity, node.updatedAt);
      logger.info({ existingHash: aliasMatch.public_key_hash.slice(0, 12), alias: node.alias }, 'Cross-source enrichment (alias match)');
      return 'updated';
    }

    await this.agentRepo.insert({
      public_key_hash: publicKeyHash,
      public_key: node.publicKey,
      alias: node.alias,
      first_seen: node.firstSeen,
      last_seen: node.updatedAt,
      source: 'lightning_graph',
      total_transactions: node.channels,
      total_attestations_received: 0,
      avg_score: 0,
      capacity_sats: node.capacity,
      positive_ratings: 0,
      negative_ratings: 0,
      lnplus_rank: 0,
      hubness_rank: 0,
      betweenness_rank: 0,
      hopness_rank: 0,
      unique_peers: null,
      last_queried_at: null,
      query_count: 0,
    });

    logger.debug({ publicKeyHash, alias: node.alias, channels: node.channels }, 'New Lightning node indexed');
    return 'created';
  }
}
