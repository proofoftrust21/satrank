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

    const agents = this.agentRepo.findLightningAgentsWithPubkey();

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
          info.positive_ratings_count,
          info.negative_ratings_count,
          info.lnplus_rank_number,
        );
        result.updated++;

        logger.debug({
          alias: agent.alias,
          positive: info.positive_ratings_count,
          negative: info.negative_ratings_count,
          rank: info.lnplus_rank_number,
        }, 'LN+ ratings updated');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`${agent.alias ?? agent.public_key_hash.slice(0, 16)}: ${msg}`);
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
