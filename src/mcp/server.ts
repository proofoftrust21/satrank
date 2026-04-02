// MCP Server (Model Context Protocol) — agent-native access to SatRank
// AI agents can query the scoring engine directly via stdio
import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getDatabase, closeDatabase } from '../database/connection';
import { runMigrations } from '../database/migrations';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { ScoringService } from '../services/scoringService';
import { AgentService } from '../services/agentService';
import { StatsService } from '../services/statsService';
import { logger } from '../logger';

// Zod validation schemas for MCP args (same rules as HTTP controllers)
const getAgentScoreArgs = z.object({
  publicKeyHash: z.string().regex(/^[a-f0-9]{64}$/, 'Expected SHA256 hex (64 chars)'),
});
const getTopAgentsArgs = z.object({
  limit: z.number().int().min(1).max(100).default(10),
});
const searchAgentsArgs = z.object({
  alias: z.string().min(1).max(100),
});

// Database initialization and dependency injection
const db = getDatabase();
runMigrations(db);

const agentRepo = new AgentRepository(db);
const txRepo = new TransactionRepository(db);
const attestationRepo = new AttestationRepository(db);
const snapshotRepo = new SnapshotRepository(db);

const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo);
const agentService = new AgentService(agentRepo, txRepo, attestationRepo, scoringService);
const statsService = new StatsService(agentRepo, txRepo, attestationRepo, snapshotRepo);

// MCP server creation (low-level API to avoid TS2589 with .tool())
const server = new Server(
  { name: 'satrank', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// Available tools declaration
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_agent_score',
      description: 'Returns the detailed trust score of an agent including score components, evidence (transactions, Lightning graph, LN+ reputation, popularity), and verification URLs',
      inputSchema: {
        type: 'object' as const,
        properties: {
          publicKeyHash: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'SHA256 hex of the public key' },
        },
        required: ['publicKeyHash'],
      },
    },
    {
      name: 'get_top_agents',
      description: 'Returns the agent leaderboard ranked by trust score, including LN+ ratings and popularity data',
      inputSchema: {
        type: 'object' as const,
        properties: {
          limit: { type: 'number', minimum: 1, maximum: 100, default: 10, description: 'Number of agents' },
        },
      },
    },
    {
      name: 'search_agents',
      description: 'Search agents by alias (partial match)',
      inputSchema: {
        type: 'object' as const,
        properties: {
          alias: { type: 'string', minLength: 1, description: 'Alias to search for' },
        },
        required: ['alias'],
      },
    },
    {
      name: 'get_network_stats',
      description: 'Returns global SatRank network statistics',
      inputSchema: { type: 'object' as const, properties: {} },
    },
  ],
}));

// Tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'get_agent_score': {
        const parsed = getAgentScoreArgs.safeParse(args);
        if (!parsed.success) {
          return { content: [{ type: 'text', text: `Invalid parameters:${parsed.error.errors.map(e => e.message).join(', ')}` }], isError: true };
        }
        const result = agentService.getAgentScore(parsed.data.publicKeyHash);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'get_top_agents': {
        const parsed = getTopAgentsArgs.safeParse(args);
        if (!parsed.success) {
          return { content: [{ type: 'text', text: `Invalid parameters:${parsed.error.errors.map(e => e.message).join(', ')}` }], isError: true };
        }
        const agents = agentService.getTopAgents(parsed.data.limit, 0);
        const result = agents.map(a => ({
          publicKeyHash: a.public_key_hash,
          alias: a.alias,
          score: a.avg_score,
          totalTransactions: a.total_transactions,
          source: a.source,
          positiveRatings: a.positive_ratings,
          negativeRatings: a.negative_ratings,
          lnplusRank: a.lnplus_rank,
          queryCount: a.query_count,
        }));
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'search_agents': {
        const parsed = searchAgentsArgs.safeParse(args);
        if (!parsed.success) {
          return { content: [{ type: 'text', text: `Invalid parameters:${parsed.error.errors.map(e => e.message).join(', ')}` }], isError: true };
        }
        const agents = agentService.searchByAlias(parsed.data.alias, 20, 0);
        const result = agents.map(a => ({
          publicKeyHash: a.public_key_hash,
          alias: a.alias,
          score: a.avg_score,
          source: a.source,
          positiveRatings: a.positive_ratings,
          negativeRatings: a.negative_ratings,
          lnplusRank: a.lnplus_rank,
        }));
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'get_network_stats': {
        const stats = statsService.getNetworkStats();
        return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
      }

      default:
        return { content: [{ type: 'text', text: 'Unknown tool' }], isError: true };
    }
  } catch (err: unknown) {
    logger.error({ err, tool: name }, 'MCP tool error');
    return { content: [{ type: 'text', text: 'Internal error' }], isError: true };
  }
});

// Startup
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('SatRank MCP server started (stdio)');
}

function shutdown() {
  closeDatabase();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch(err => {
  logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Fatal MCP error');
  closeDatabase();
  process.exit(1);
});
