// Security and data integrity tests
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { sha256 } from '../utils/crypto';
import type { Agent } from '../types';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

function makeAgent(alias: string, overrides: Partial<Agent> = {}): Agent {
  return {
    public_key_hash: sha256(alias),
    public_key: null,
    alias,
    first_seen: NOW - 90 * DAY,
    last_seen: NOW - DAY,
    source: 'observer_protocol',
    total_transactions: 0,
    total_attestations_received: 0,
    avg_score: 0,
    capacity_sats: null,
    positive_ratings: 0,
    negative_ratings: 0,
    lnplus_rank: 0,
    hubness_rank: 0,
    betweenness_rank: 0,
    hopness_rank: 0,
    unique_peers: null,
    last_queried_at: null,
    query_count: 0,
    ...overrides,
  };
}

describe('Data integrity constraints', () => {
  let db: Database.Database;
  let agentRepo: AgentRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    agentRepo = new AgentRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('rejects negative positive_ratings on insert', () => {
    expect(() => {
      agentRepo.insert(makeAgent('bad-pos', { positive_ratings: -1 }));
    }).toThrow('Invalid rating or rank value');
  });

  it('rejects negative negative_ratings on insert', () => {
    expect(() => {
      agentRepo.insert(makeAgent('bad-neg', { negative_ratings: -5 }));
    }).toThrow('Invalid rating or rank value');
  });

  it('rejects lnplus_rank > 10 on insert', () => {
    expect(() => {
      agentRepo.insert(makeAgent('bad-rank', { lnplus_rank: 11 }));
    }).toThrow('Invalid rating or rank value');
  });

  it('rejects negative lnplus_rank on insert', () => {
    expect(() => {
      agentRepo.insert(makeAgent('bad-rank-neg', { lnplus_rank: -1 }));
    }).toThrow('Invalid rating or rank value');
  });

  it('rejects negative hubness_rank on insert', () => {
    expect(() => {
      agentRepo.insert(makeAgent('bad-hub', { hubness_rank: -1 }));
    }).toThrow('Invalid rating or rank value');
  });

  it('rejects negative betweenness_rank on insert', () => {
    expect(() => {
      agentRepo.insert(makeAgent('bad-btw', { betweenness_rank: -1 }));
    }).toThrow('Invalid rating or rank value');
  });

  it('allows valid ratings and ranks', () => {
    const agent = makeAgent('valid', {
      positive_ratings: 100,
      negative_ratings: 5,
      lnplus_rank: 10,
      hubness_rank: 50,
      betweenness_rank: 200,
      hopness_rank: 0,
    });
    agentRepo.insert(agent);
    const found = agentRepo.findByHash(agent.public_key_hash);
    expect(found!.lnplus_rank).toBe(10);
    expect(found!.hubness_rank).toBe(50);
  });

  it('rejects invalid values on update via updateLnplusRatings', () => {
    agentRepo.insert(makeAgent('update-test'));
    expect(() => {
      agentRepo.updateLnplusRatings(sha256('update-test'), -1, 0, 5, 0, 0, 0);
    }).toThrow('Invalid rating or rank value');
  });

  it('has index on agents(source)', () => {
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agents' AND name='idx_agents_source'"
    ).get() as { name: string } | undefined;
    expect(indexes).toBeDefined();
  });

  it('has index on agents(public_key)', () => {
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agents' AND name='idx_agents_public_key'"
    ).get() as { name: string } | undefined;
    expect(indexes).toBeDefined();
  });
});

describe('LN+ Zod validation', () => {
  it('rejects lnp_rank > 10 via Zod schema', async () => {
    const { lnplusResponseSchema } = await import('../crawler/lnplusClient');

    // Valid data passes
    const valid = lnplusResponseSchema.safeParse({
      lnp_rank: 8, lnp_rank_name: 'Gold',
      lnp_positive_ratings_received: 42, lnp_negative_ratings_received: 2,
      hubness_rank: 25, betweenness_rank: 30, hopness_rank: 15,
    });
    expect(valid.success).toBe(true);

    // lnp_rank > 10 fails
    const badRank = lnplusResponseSchema.safeParse({
      lnp_rank: 99, lnp_rank_name: 'Invalid',
    });
    expect(badRank.success).toBe(false);

    // Negative ratings fail
    const badNeg = lnplusResponseSchema.safeParse({
      lnp_positive_ratings_received: -5,
    });
    expect(badNeg.success).toBe(false);

    // NaN string coerces gracefully — "abc" becomes NaN which fails min(0) check
    const nanInput = lnplusResponseSchema.safeParse({
      lnp_rank: 'not-a-number',
    });
    expect(nanInput.success).toBe(false);
  });

  it('strips unknown fields from LN+ response', async () => {
    const { lnplusResponseSchema } = await import('../crawler/lnplusClient');

    const result = lnplusResponseSchema.safeParse({
      lnp_rank: 5, lnp_rank_name: 'Silver',
      lnp_positive_ratings_received: 10, lnp_negative_ratings_received: 1,
      hubness_rank: 20, betweenness_rank: 30, hopness_rank: 10,
      unknown_field: 'should be removed',
      another_extra: 42,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('unknown_field');
      expect(result.data).not.toHaveProperty('another_extra');
      expect(result.data.lnp_rank).toBe(5);
      expect(result.data.hubness_rank).toBe(20);
    }
  });

  it('rejects negative hopness_rank', async () => {
    const { lnplusResponseSchema } = await import('../crawler/lnplusClient');

    const result = lnplusResponseSchema.safeParse({
      hopness_rank: -1,
    });
    expect(result.success).toBe(false);
  });
});
