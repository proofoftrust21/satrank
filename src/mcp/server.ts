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
import { AttestationService } from '../services/attestationService';
import { StatsService } from '../services/statsService';
import { TrendService } from '../services/trendService';
import { VerdictService } from '../services/verdictService';
import { RiskService } from '../services/riskService';
import { attestationCategoryValues } from '../middleware/validation';
import { logger } from '../logger';

import { sha256 } from '../utils/crypto';

// Zod validation schemas for MCP args (same rules as HTTP controllers)
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/, 'Expected SHA256 hex (64 chars)');
// Accepts both 64-char SHA256 hash and 66-char Lightning compressed pubkey
const identifierSchema = z.string().regex(
  /^(?:[a-f0-9]{64}|(02|03)[a-f0-9]{64})$/,
  'Expected 64-char SHA256 hash or 66-char Lightning pubkey (02/03 prefix)',
);

function normalizeId(input: string): string {
  if (input.length === 66 && /^(02|03)/.test(input)) return sha256(input);
  return input;
}

const getAgentScoreArgs = z.object({
  publicKeyHash: identifierSchema,
});
const getVerdictArgs = z.object({
  publicKeyHash: identifierSchema,
  callerPubkey: hashSchema.optional(),
});
const getTopAgentsArgs = z.object({
  limit: z.number().int().min(1).max(100).default(10),
});
const searchAgentsArgs = z.object({
  alias: z.string().min(1).max(100),
});
const getTopMoversArgs = z.object({
  limit: z.number().int().min(1).max(20).default(5),
});
const getBatchVerdictsArgs = z.object({
  hashes: z.array(identifierSchema).min(1).max(100),
});
const submitAttestationArgs = z.object({
  txId: z.string().uuid('txId must be a valid UUID'),
  attesterHash: hashSchema,
  subjectHash: hashSchema,
  score: z.number().int().min(0).max(100),
  tags: z.array(z.string().max(50).regex(/^[\w\-]+$/, 'Invalid tag')).max(10).optional(),
  evidenceHash: hashSchema.optional(),
  category: z.enum(attestationCategoryValues).default('general'),
});

// Database initialization and dependency injection
const db = getDatabase();
runMigrations(db);

const agentRepo = new AgentRepository(db);
const txRepo = new TransactionRepository(db);
const attestationRepo = new AttestationRepository(db);
const snapshotRepo = new SnapshotRepository(db);

const scoringService = new ScoringService(agentRepo, txRepo, attestationRepo, snapshotRepo);
const trendService = new TrendService(agentRepo, snapshotRepo);
const agentService = new AgentService(agentRepo, txRepo, attestationRepo, scoringService, trendService, snapshotRepo);
const attestationService = new AttestationService(attestationRepo, agentRepo, txRepo, db);
const statsService = new StatsService(agentRepo, txRepo, attestationRepo, snapshotRepo, db, trendService);
const riskService = new RiskService();
const verdictService = new VerdictService(agentRepo, attestationRepo, scoringService, trendService, riskService);

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
    {
      name: 'get_verdict',
      description: 'Returns SAFE / RISKY / UNKNOWN verdict for an agent, with risk profile and optional personal trust graph. The primary tool for pre-transaction trust decisions.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          publicKeyHash: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'SHA256 hex of the target agent public key' },
          callerPubkey: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Optional: your own pubkey hash to get personalized trust distance' },
        },
        required: ['publicKeyHash'],
      },
    },
    {
      name: 'get_batch_verdicts',
      description: 'Returns SAFE/RISKY/UNKNOWN for up to 100 agents in one call. Efficient for bulk pre-transaction screening.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          hashes: {
            type: 'array',
            items: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            minItems: 1,
            maxItems: 100,
            description: 'Array of SHA256 hex hashes of target agent public keys',
          },
        },
        required: ['hashes'],
      },
    },
    {
      name: 'get_top_movers',
      description: 'Returns agents with the biggest score changes over the past 7 days — rising and falling.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          limit: { type: 'number', minimum: 1, maximum: 20, default: 5, description: 'Number of movers per direction (up/down)' },
        },
      },
    },
    {
      name: 'submit_attestation',
      description: 'Submit a trust attestation for an agent after a transaction. Requires SATRANK_API_KEY env var.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          txId: { type: 'string', description: 'Transaction ID the attestation references' },
          attesterHash: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'SHA256 hex of the attester public key' },
          subjectHash: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'SHA256 hex of the subject agent public key' },
          score: { type: 'number', minimum: 0, maximum: 100, description: 'Trust score (0-100)' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags (e.g. ["fast", "reliable"])' },
          evidenceHash: { type: 'string', description: 'Optional evidence hash' },
          category: { type: 'string', enum: ['successful_transaction', 'failed_transaction', 'dispute', 'fraud', 'unresponsive', 'general'], description: 'Attestation category (default: general)' },
        },
        required: ['txId', 'attesterHash', 'subjectHash', 'score'],
      },
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
          return { content: [{ type: 'text', text: `Invalid parameters: ${parsed.error.errors.map(e => e.message).join(', ')}` }], isError: true };
        }
        const result = agentService.getAgentScore(normalizeId(parsed.data.publicKeyHash));
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'get_top_agents': {
        const parsed = getTopAgentsArgs.safeParse(args);
        if (!parsed.success) {
          return { content: [{ type: 'text', text: `Invalid parameters: ${parsed.error.errors.map(e => e.message).join(', ')}` }], isError: true };
        }
        const agents = agentService.getTopAgents(parsed.data.limit, 0);
        const result = agents.map(a => ({
          publicKeyHash: a.publicKeyHash,
          alias: a.alias,
          score: a.score,
          totalTransactions: a.totalTransactions,
          source: a.source,
          components: a.components,
        }));
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'search_agents': {
        const parsed = searchAgentsArgs.safeParse(args);
        if (!parsed.success) {
          return { content: [{ type: 'text', text: `Invalid parameters: ${parsed.error.errors.map(e => e.message).join(', ')}` }], isError: true };
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

      case 'get_verdict': {
        const parsed = getVerdictArgs.safeParse(args);
        if (!parsed.success) {
          return { content: [{ type: 'text', text: `Invalid parameters: ${parsed.error.errors.map(e => e.message).join(', ')}` }], isError: true };
        }
        const verdict = verdictService.getVerdict(normalizeId(parsed.data.publicKeyHash), parsed.data.callerPubkey);
        return { content: [{ type: 'text', text: JSON.stringify(verdict, null, 2) }] };
      }

      case 'get_batch_verdicts': {
        const parsed = getBatchVerdictsArgs.safeParse(args);
        if (!parsed.success) {
          return { content: [{ type: 'text', text: `Invalid parameters: ${parsed.error.errors.map(e => e.message).join(', ')}` }], isError: true };
        }
        const results = parsed.data.hashes.map(id => ({
          publicKeyHash: normalizeId(id),
          ...verdictService.getVerdict(normalizeId(id)),
        }));
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
      }

      case 'get_top_movers': {
        const parsed = getTopMoversArgs.safeParse(args);
        if (!parsed.success) {
          return { content: [{ type: 'text', text: `Invalid parameters: ${parsed.error.errors.map(e => e.message).join(', ')}` }], isError: true };
        }
        const movers = trendService.getTopMovers(parsed.data.limit);
        return { content: [{ type: 'text', text: JSON.stringify(movers, null, 2) }] };
      }

      case 'get_network_stats': {
        const stats = statsService.getNetworkStats();
        return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
      }

      case 'submit_attestation': {
        // The MCP server acts as a trusted proxy — it holds the API key and
        // authenticates on behalf of the MCP client. Access control is managed
        // at the MCP transport level (stdio/local only).
        const apiKey = process.env.SATRANK_API_KEY;
        if (!apiKey) {
          return { content: [{ type: 'text', text: 'SATRANK_API_KEY environment variable is required for write operations' }], isError: true };
        }
        const parsed = submitAttestationArgs.safeParse(args);
        if (!parsed.success) {
          return { content: [{ type: 'text', text: `Invalid parameters: ${parsed.error.errors.map(e => e.message).join(', ')}` }], isError: true };
        }
        const attestation = attestationService.create(parsed.data);
        return { content: [{ type: 'text', text: JSON.stringify({ attestationId: attestation.attestation_id, subjectHash: attestation.subject_hash, score: attestation.score, timestamp: attestation.timestamp }, null, 2) }] };
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
