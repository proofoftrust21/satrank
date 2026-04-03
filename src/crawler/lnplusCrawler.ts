// Enriches Lightning agents with LightningNetwork.plus ratings
// Queries LN+ for each lightning_graph agent that has an original public key stored
import type { AgentRepository } from '../repositories/agentRepository';
import type { LnplusClient } from './lnplusClient';
import { logger } from '../logger';

export interface LnplusCrawlResult {
  startedAt: number;
  finishedAt: number;
  queried: number;
  updated: number;
  notFound: number;
  errors: string[];
}

export class LnplusCrawler {
  constructor(
    private client: LnplusClient,
    private agentRepo: AgentRepository,
  ) {}

  async run(): Promise<LnplusCrawlResult> {
    const startedAt = Math.floor(Date.now() / 1000);
    const result: LnplusCrawlResult = {
      startedAt,
      finishedAt: 0,
      queried: 0,
      updated: 0,
      notFound: 0,
      errors: [],
    };

    // Only query agents likely to have LN+ profiles:
    // - Already have lnplus_rank > 0 or positive_ratings > 0 (re-check)
    // - Top 1000 by capacity (new candidates)
    const agents = this.agentRepo.findLnplusCandidates(1000);
    logger.info({ candidates: agents.length }, 'LN+ crawl candidates selected');

    for (const agent of agents) {
      result.queried++;

      try {
        const info = await this.client.fetchNodeInfo(agent.public_key!);

        if (!info) {
          result.notFound++;
          continue;
        }

        this.agentRepo.updateLnplusRatings(
          agent.public_key_hash,
          info.positive_ratings ?? 0,
          info.negative_ratings ?? 0,
          info.lnp_rank,
          info.hubness_rank,
          info.betweenness_rank,
          info.hopness_rank,
        );
        result.updated++;

        logger.debug({
          alias: agent.alias,
          positive: info.positive_ratings,
          negative: info.negative_ratings,
          rank: info.lnp_rank,
          hubness: info.hubness_rank,
          betweenness: info.betweenness_rank,
        }, 'LN+ ratings updated');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`${agent.alias ?? agent.public_key_hash.slice(0, 16)}: ${msg}`);
      }

      // Progress log every 200 nodes
      if (result.queried % 200 === 0) {
        logger.info({
          queried: result.queried,
          total: agents.length,
          updated: result.updated,
          notFound: result.notFound,
        }, 'LN+ crawl progress');
      }
    }

    result.finishedAt = Math.floor(Date.now() / 1000);
    logger.info({
      duration: result.finishedAt - result.startedAt,
      queried: result.queried,
      updated: result.updated,
      notFound: result.notFound,
      errors: result.errors.length,
    }, 'LN+ crawl finished');

    return result;
  }
}
