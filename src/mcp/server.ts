// MCP Server (Model Context Protocol) — agent-native access to SatRank
// Autonomous agents can query the scoring engine directly via stdio
import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { config } from '../config';
import { getPool, closePools } from '../database/connection';
import { runMigrations } from '../database/migrations';
import { HttpLndGraphClient } from '../crawler/lndGraphClient';
import { AgentRepository } from '../repositories/agentRepository';
import { TransactionRepository } from '../repositories/transactionRepository';
import { AttestationRepository } from '../repositories/attestationRepository';
import { SnapshotRepository } from '../repositories/snapshotRepository';
import { ProbeRepository } from '../repositories/probeRepository';
import { ScoringService } from '../services/scoringService';
import { AgentService } from '../services/agentService';
import { AttestationService } from '../services/attestationService';
import { StatsService } from '../services/statsService';
import { TrendService } from '../services/trendService';
import { VerdictService } from '../services/verdictService';
import { RiskService } from '../services/riskService';
import { DecideService } from '../services/decideService';
import { ReportService } from '../services/reportService';
import { BayesianScoringService } from '../services/bayesianScoringService';
import { BayesianVerdictService } from '../services/bayesianVerdictService';
import {
  EndpointStreamingPosteriorRepository,
  ServiceStreamingPosteriorRepository,
  OperatorStreamingPosteriorRepository,
  NodeStreamingPosteriorRepository,
  RouteStreamingPosteriorRepository,
} from '../repositories/streamingPosteriorRepository';
import {
  EndpointDailyBucketsRepository,
  ServiceDailyBucketsRepository,
  OperatorDailyBucketsRepository,
  NodeDailyBucketsRepository,
  RouteDailyBucketsRepository,
} from '../repositories/dailyBucketsRepository';
import { ChannelSnapshotRepository } from '../repositories/channelSnapshotRepository';
import { FeeSnapshotRepository } from '../repositories/feeSnapshotRepository';
import { attestationCategoryValues } from '../middleware/validation';
import { logger } from '../logger';

import { sha256 } from '../utils/crypto';

// Phase 6.0 — base URL de l'API SatRank vers laquelle le MCP `intent` tool
// proxie. Security C1+H1 — validation centrale dans config.ts (https-only
// sauf localhost) empêche SSRF via file:// / http://internal.
const SATRANK_API_BASE = config.SATRANK_API_BASE;
// Security C3 — cap réponses HTTP à 1 MB pour empêcher memory exhaustion
// si l'instance pointée par SATRANK_API_BASE retourne un body géant.
const MAX_INTENT_RESPONSE_BYTES = 1024 * 1024;
const INTENT_FETCH_TIMEOUT_MS = 8000;

/** Security C3 + L2 — fetch avec hard cap byte size + timeout. Stream le
 *  body et abort dès qu'on dépasse maxBytes. */
async function fetchWithCap(
  url: string,
  init: RequestInit,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ status: number; ok: boolean; body: string; truncated: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    const reader = resp.body?.getReader();
    if (!reader) {
      return { status: resp.status, ok: resp.ok, body: '', truncated: false };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        truncated = true;
        try { await reader.cancel(); } catch { /* swallow */ }
        break;
      }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks).toString('utf-8');
    return { status: resp.status, ok: resp.ok, body, truncated };
  } finally {
    clearTimeout(timer);
  }
}

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

// Phase 6.0 — `intent` tool args. Mirror du body /api/intent côté HTTP.
// Le MCP proxie vers l'API SatRank ; agent reçoit la réponse JSON brute.
const intentArgs = z.object({
  category: z.string().min(1).max(64).describe('Service category (e.g. "data/finance", "ai/text")'),
  keywords: z.array(z.string()).optional().describe('Filter keywords (AND match on metadata)'),
  budget_sats: z.number().int().min(1).max(10000).optional().describe('Hard budget per request'),
  max_latency_ms: z.number().int().min(1).max(60000).optional().describe('Latency ceiling for matching'),
  fresh: z.boolean().optional().describe('Force a sync HTTP probe (costs 2 sats — only when wallet attached)'),
  caller: z.string().optional().describe('Agent identifier (snake_case)'),
  optimize: z.enum(['p_success', 'latency', 'reliability', 'cost']).optional().describe('Ranking axis'),
  limit: z.number().int().min(1).max(20).optional().describe('Number of candidates returned'),
});

// Phase 6.0 — `verify_assertion` tool args. Vérification offline d'une
// kind 30782 / 30783 trust assertion publiée par un oracle SatRank-compatible.
// Schéma : agent reçoit l'event Nostr brut, extrait kind / pubkey / sig,
// vérifie Schnorr + window valid_until + format. Aucun appel réseau.
const verifyAssertionArgs = z.object({
  event: z.object({
    id: z.string().regex(/^[a-f0-9]{64}$/, 'Nostr event id is 32-byte hex'),
    pubkey: z.string().regex(/^[a-f0-9]{64}$/, 'Schnorr pubkey is 32-byte hex'),
    created_at: z.number().int(),
    kind: z.number().int(),
    tags: z.array(z.array(z.string())),
    content: z.string(),
    sig: z.string().regex(/^[a-f0-9]{128}$/, 'Schnorr signature is 64-byte hex'),
  }).describe('Raw Nostr event (kind 30782 trust assertion or 30783 calibration)'),
  expected_oracle_pubkey: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('Optional : reject the assertion if pubkey does not match this expected oracle identity'),
  now_sec: z.number().int().optional().describe('Optional : current epoch seconds for valid_until check (default = Date.now / 1000)'),
});
const getBatchVerdictsArgs = z.object({
  hashes: z.array(identifierSchema).min(1).max(100),
});
const decideArgs = z.object({
  target: identifierSchema,
  caller: identifierSchema,
  amountSats: z.number().int().positive().optional(),
});
const reportArgs = z.object({
  target: identifierSchema,
  reporter: identifierSchema,
  outcome: z.enum(['success', 'failure', 'timeout']),
  paymentHash: z.string().regex(/^[a-f0-9]{64}$/).refine(v => v !== '0'.repeat(64), 'All-zero paymentHash rejected').optional(),
  preimage: z.string().regex(/^[a-f0-9]{64}$/).refine(v => v !== '0'.repeat(64), 'All-zero preimage rejected').optional(),
  amountBucket: z.enum(['micro', 'small', 'medium', 'large']).optional(),
  memo: z.string().max(280).regex(/^[^\x00-\x1f]*$/, 'Memo must not contain control characters').optional(),
}).refine(
  (data) => !data.preimage || !!data.paymentHash,
  { message: 'preimage requires paymentHash', path: ['preimage'] },
);
const getProfileArgs = z.object({
  id: identifierSchema,
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

async function bootstrap() {
  // Database initialization and dependency injection
  const pool = getPool();
  await runMigrations(pool);

  const agentRepo = new AgentRepository(pool);
  const txRepo = new TransactionRepository(pool);
  const attestationRepo = new AttestationRepository(pool);
  const snapshotRepo = new SnapshotRepository(pool);
  const probeRepo = new ProbeRepository(pool);

  const channelSnapshotRepo = new ChannelSnapshotRepository(pool);
  const feeSnapshotRepo = new FeeSnapshotRepository(pool);
  const scoringService = new ScoringService(
    agentRepo, txRepo, attestationRepo, snapshotRepo, pool, probeRepo, channelSnapshotRepo, feeSnapshotRepo,
  );
  const trendService = new TrendService(agentRepo, snapshotRepo);
  const endpointStreamingRepo = new EndpointStreamingPosteriorRepository(pool);
  const serviceStreamingRepo = new ServiceStreamingPosteriorRepository(pool);
  const operatorStreamingRepo = new OperatorStreamingPosteriorRepository(pool);
  const nodeStreamingRepo = new NodeStreamingPosteriorRepository(pool);
  const routeStreamingRepo = new RouteStreamingPosteriorRepository(pool);
  const endpointBucketsRepo = new EndpointDailyBucketsRepository(pool);
  const serviceBucketsRepo = new ServiceDailyBucketsRepository(pool);
  const operatorBucketsRepo = new OperatorDailyBucketsRepository(pool);
  const nodeBucketsRepo = new NodeDailyBucketsRepository(pool);
  const routeBucketsRepo = new RouteDailyBucketsRepository(pool);
  const bayesianScoringService = new BayesianScoringService(
    endpointStreamingRepo, serviceStreamingRepo, operatorStreamingRepo, nodeStreamingRepo, routeStreamingRepo,
    endpointBucketsRepo, serviceBucketsRepo, operatorBucketsRepo, nodeBucketsRepo, routeBucketsRepo,
  );
  const bayesianVerdictService = new BayesianVerdictService(
    bayesianScoringService, endpointStreamingRepo, endpointBucketsRepo, snapshotRepo,
  );
  const agentService = new AgentService(agentRepo, txRepo, attestationRepo, bayesianVerdictService, probeRepo);
  const attestationService = new AttestationService(attestationRepo, agentRepo, txRepo, pool);
  const statsService = new StatsService(
    agentRepo, txRepo, attestationRepo, snapshotRepo, pool, trendService, probeRepo,
  );
  const riskService = new RiskService();

  const lndClient = new HttpLndGraphClient({
    restUrl: config.LND_REST_URL,
    macaroonPath: config.LND_MACAROON_PATH,
    timeoutMs: config.LND_TIMEOUT_MS,
  });
  const verdictService = new VerdictService(
    agentRepo, attestationRepo, scoringService, trendService, riskService, bayesianVerdictService,
    probeRepo, lndClient.isConfigured() ? lndClient : undefined,
  );
  const decideService = new DecideService({
    agentRepo, attestationRepo, scoringService, trendService, riskService, verdictService,
    probeRepo, lndClient: lndClient.isConfigured() ? lndClient : undefined,
  });
  const reportService = new ReportService(attestationRepo, agentRepo, txRepo, scoringService, pool);

  return {
    agentRepo,
    attestationRepo,
    probeRepo,
    agentService,
    attestationService,
    statsService,
    verdictService,
    decideService,
    reportService,
    lndClient,
  };
}

async function main() {
  const deps = await bootstrap();
  const {
    agentRepo,
    attestationRepo,
    probeRepo,
    agentService,
    attestationService,
    statsService,
    verdictService,
    decideService,
    reportService,
    lndClient,
  } = deps;

  // MCP server creation (low-level API to avoid TS2589 with .tool())
  const server = new Server(
    { name: 'satrank', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  // Available tools declaration
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_agent_score',
        description: 'Returns the canonical Bayesian trust block of an agent (verdict, p_success, ci95, n_obs, sources, convergence) plus evidence (transactions, Lightning graph, LN+ reputation, popularity) and verification URLs.',
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
        description: 'Returns the agent leaderboard ranked by the canonical Bayesian block (p_success default, n_obs, ci95_width, window_freshness axes). Includes evidence overlays such as LN+ ratings and popularity data.',
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
        description: 'Returns SAFE / RISKY / UNKNOWN verdict for an agent, with risk profile, optional personal trust graph, and personalized pathfinding (real-time route from caller to target via LND). The primary tool for pre-transaction trust decisions.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            publicKeyHash: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'SHA256 hex of the target agent public key' },
            callerPubkey: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Optional: your own pubkey hash to get personalized trust distance and real-time pathfinding (route from you to the target)' },
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
      {
        name: 'decide',
        description: 'GO / NO-GO decision with success probability. The primary tool for pre-transaction decisions. Returns a boolean go plus the canonical Bayesian block (verdict, p_success, ci95, n_obs, sources, convergence, window) and the multi-signal probability breakdown (trust, routable, available, empirical).',
        inputSchema: {
          type: 'object' as const,
          properties: {
            target: { type: 'string', description: 'Target agent: 64-char SHA256 hash or 66-char Lightning pubkey' },
            caller: { type: 'string', description: 'Your identity: 64-char SHA256 hash or 66-char Lightning pubkey' },
            amountSats: { type: 'number', description: 'Optional: transaction amount in sats for amount-aware routing' },
          },
          required: ['target', 'caller'],
        },
      },
      {
        name: 'report',
        description: 'Report a transaction outcome (success / failure / timeout). Requires SATRANK_API_KEY. Weighted by reporter trust score. Provide paymentHash + preimage for 2x weight bonus.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            target: { type: 'string', description: 'Target agent: 64-char SHA256 hash or 66-char Lightning pubkey' },
            reporter: { type: 'string', description: 'Your identity: 64-char SHA256 hash or 66-char Lightning pubkey' },
            outcome: { type: 'string', enum: ['success', 'failure', 'timeout'], description: 'Transaction outcome' },
            paymentHash: { type: 'string', description: 'Optional: payment hash (64 hex chars) for preimage verification' },
            preimage: { type: 'string', description: 'Optional: preimage (64 hex chars). SHA256(preimage) must equal paymentHash.' },
            amountBucket: { type: 'string', enum: ['micro', 'small', 'medium', 'large'], description: 'Optional: transaction size bucket' },
            memo: { type: 'string', description: 'Optional: free-text note (max 280 chars)' },
          },
          required: ['target', 'reporter', 'outcome'],
        },
      },
      {
        name: 'get_profile',
        description: 'Agent profile with score, report statistics (successes/failures/timeouts), probe uptime, rank, evidence, and flags. The comprehensive view of an agent.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            id: { type: 'string', description: 'Agent identifier: 64-char SHA256 hash or 66-char Lightning pubkey' },
          },
          required: ['id'],
        },
      },
      {
        name: 'ping',
        description: 'Real-time reachability check via QueryRoutes. Returns whether a Lightning node is reachable right now, number of hops, and routing fee. Free, no payment required.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            pubkey: { type: 'string', pattern: '^(02|03)[a-f0-9]{64}$', description: 'Lightning pubkey (66 hex chars)' },
            from: { type: 'string', pattern: '^(02|03)[a-f0-9]{64}$', description: 'Optional: your Lightning pubkey for personalized pathfinding' },
          },
          required: ['pubkey'],
        },
      },
      {
        name: 'intent',
        description: 'Phase 6.0 — Resolve an intent (category + keywords + budget + latency ceiling) into a ranked list of L402 endpoint candidates. Each candidate carries the Bayesian trust posterior, the 5-stage breakdown (challenge / invoice / payment / delivery / quality) when available, http_method, and a freshness advisory. The first agent-native primitive : ask for what you want, get a ranked shortlist, choose one, pay it directly. SatRank never custodies sats.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            category: { type: 'string', minLength: 1, maxLength: 64, description: 'Service category (e.g. "data/finance", "ai/text")' },
            keywords: { type: 'array', items: { type: 'string' }, description: 'Filter keywords (AND match on metadata)' },
            budget_sats: { type: 'number', minimum: 1, maximum: 10000, description: 'Hard budget per request' },
            max_latency_ms: { type: 'number', minimum: 1, maximum: 60000, description: 'Latency ceiling for matching' },
            fresh: { type: 'boolean', description: 'Force a sync HTTP probe (costs 2 sats — only when paying via /api/intent?fresh=true with a wallet)' },
            caller: { type: 'string', description: 'Agent identifier (pubkey hash or snake_case alias)' },
            optimize: { type: 'string', enum: ['p_success', 'latency', 'reliability', 'cost'], description: 'Ranking axis (default: p_success)' },
            limit: { type: 'number', minimum: 1, maximum: 20, description: 'Number of candidates returned (default: 5)' },
          },
          required: ['category'],
        },
      },
      {
        name: 'verify_assertion',
        description: 'Phase 6.0 — Verify offline a SatRank-compatible trust assertion (kind 30782 transferable assertion, or kind 30783 oracle calibration). Validates Schnorr signature, optionally enforces an expected oracle pubkey, and reads the valid_until tag. No network call ; the entire check is cryptographic + structural. Use this to compose oracle output across agents without re-querying SatRank.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            event: {
              type: 'object',
              description: 'Raw Nostr event (kind 30782 / 30783)',
              properties: {
                id: { type: 'string', pattern: '^[a-f0-9]{64}$' },
                pubkey: { type: 'string', pattern: '^[a-f0-9]{64}$' },
                created_at: { type: 'number' },
                kind: { type: 'number' },
                tags: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
                content: { type: 'string' },
                sig: { type: 'string', pattern: '^[a-f0-9]{128}$' },
              },
              required: ['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig'],
            },
            expected_oracle_pubkey: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Optional : reject the assertion if pubkey does not match this expected oracle identity' },
            now_sec: { type: 'number', description: 'Optional : current epoch seconds for valid_until check' },
          },
          required: ['event'],
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
          const result = await agentService.getAgentScore(normalizeId(parsed.data.publicKeyHash));
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'get_top_agents': {
          const parsed = getTopAgentsArgs.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `Invalid parameters: ${parsed.error.errors.map(e => e.message).join(', ')}` }], isError: true };
          }
          const agents = await agentService.getTopAgents(parsed.data.limit, 0);
          const result = agents.map((a) => ({
            publicKeyHash: a.publicKeyHash,
            alias: a.alias,
            totalTransactions: a.totalTransactions,
            source: a.source,
            bayesian: a.bayesian,
          }));
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'search_agents': {
          const parsed = searchAgentsArgs.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `Invalid parameters: ${parsed.error.errors.map(e => e.message).join(', ')}` }], isError: true };
          }
          const agents = await agentService.searchByAlias(parsed.data.alias, 20, 0);
          const result = await Promise.all(
            agents.map(async (a) => ({
              publicKeyHash: a.public_key_hash,
              alias: a.alias,
              source: a.source,
              bayesian: await agentService.toBayesianBlock(a.public_key_hash),
            })),
          );
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'get_verdict': {
          const parsed = getVerdictArgs.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `Invalid parameters: ${parsed.error.errors.map(e => e.message).join(', ')}` }], isError: true };
          }
          const verdict = await verdictService.getVerdict(normalizeId(parsed.data.publicKeyHash), parsed.data.callerPubkey, undefined, 'mcp');
          return { content: [{ type: 'text', text: JSON.stringify(verdict, null, 2) }] };
        }

        case 'get_batch_verdicts': {
          const parsed = getBatchVerdictsArgs.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `Invalid parameters: ${parsed.error.errors.map(e => e.message).join(', ')}` }], isError: true };
          }
          // C4: concurrent execution in chunks of 10
          const BATCH_CONCURRENCY = 10;
          const ids = parsed.data.hashes.map(normalizeId);
          const batchResults: Array<Record<string, unknown>> = [];
          for (let i = 0; i < ids.length; i += BATCH_CONCURRENCY) {
            const chunk = ids.slice(i, i + BATCH_CONCURRENCY);
            const results = await Promise.all(
              chunk.map(async (id) => {
                const v = await verdictService.getVerdict(id, undefined, undefined, 'mcp');
                return { publicKeyHash: id, ...v };
              }),
            );
            batchResults.push(...results);
          }
          return { content: [{ type: 'text', text: JSON.stringify(batchResults, null, 2) }] };
        }

        case 'get_top_movers': {
          const parsed = getTopMoversArgs.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `Invalid parameters: ${parsed.error.errors.map(e => e.message).join(', ')}` }], isError: true };
          }
          // Posterior-delta movers land with the Commit 8 aggregate tables;
          // composite-score movers are retired along with ScoringService.
          const movers = { up: [], down: [], note: 'Posterior-delta movers pending Commit 8 aggregate tables.' };
          return { content: [{ type: 'text', text: JSON.stringify(movers, null, 2) }] };
        }

        case 'get_network_stats': {
          const stats = await statsService.getNetworkStats();
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
          const attestation = await attestationService.create(parsed.data);
          return { content: [{ type: 'text', text: JSON.stringify({ attestationId: attestation.attestation_id, subjectHash: attestation.subject_hash, score: attestation.score, timestamp: attestation.timestamp }, null, 2) }] };
        }

        case 'decide': {
          const parsed = decideArgs.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `Invalid parameters: ${parsed.error.errors.map(e => e.message).join(', ')}` }], isError: true };
          }
          const result = await decideService.decide(normalizeId(parsed.data.target), normalizeId(parsed.data.caller), parsed.data.amountSats);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'get_profile': {
          const parsed = getProfileArgs.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `Invalid parameters: ${parsed.error.errors.map(e => e.message).join(', ')}` }], isError: true };
          }
          const id = normalizeId(parsed.data.id);
          const agent = await agentRepo.findByHash(id);
          if (!agent) {
            return { content: [{ type: 'text', text: `Agent not found: ${id}` }], isError: true };
          }
          const bayesian = await agentService.toBayesianBlock(id);
          const rank = await agentRepo.getRank(id);
          const reports = await attestationRepo.countReportsByOutcome(id);
          const successRate = reports.total > 0 ? reports.successes / reports.total : 0;
          const probeUptime = await probeRepo.computeUptime(id, 7 * 86400);
          const evidence = await agentService.buildEvidence(agent);
          const { PROBE_FRESHNESS_TTL } = await import('../config/scoring');
          const { DAY } = await import('../utils/constants');
          const now = Math.floor(Date.now() / 1000);
          const flags: string[] = [];
          const fraudCount = await attestationRepo.countByCategoryForSubject(id, ['fraud']);
          const disputeCount = await attestationRepo.countByCategoryForSubject(id, ['dispute']);
          if (fraudCount > 0) flags.push('fraud_reported');
          if (disputeCount > 0) flags.push('dispute_reported');
          const probe = await probeRepo.findLatestAtTier(id, 1000);
          if (probe && probe.reachable === 0 && (now - probe.probed_at) < PROBE_FRESHNESS_TTL) {
            const gossipFresh = (now - agent.last_seen) < DAY;
            if (!gossipFresh || bayesian.verdict !== 'SAFE') flags.push('unreachable');
          }
          const profile = {
            agent: { publicKeyHash: agent.public_key_hash, alias: agent.alias, publicKey: agent.public_key, firstSeen: agent.first_seen, lastSeen: agent.last_seen, source: agent.source },
            bayesian,
            rank,
            reports: { total: reports.total, successes: reports.successes, failures: reports.failures, timeouts: reports.timeouts, successRate: Math.round(successRate * 1000) / 1000 },
            probeUptime: probeUptime !== null ? Math.round(probeUptime * 1000) / 1000 : null,
            evidence,
            flags,
          };
          return { content: [{ type: 'text', text: JSON.stringify(profile, null, 2) }] };
        }

        case 'report': {
          // C1: gate report on API key — same pattern as submit_attestation
          const reportApiKey = process.env.SATRANK_API_KEY;
          if (!reportApiKey) {
            return { content: [{ type: 'text', text: 'SATRANK_API_KEY environment variable is required for report operations' }], isError: true };
          }
          const parsed = reportArgs.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `Invalid parameters: ${parsed.error.errors.map(e => e.message).join(', ')}` }], isError: true };
          }
          const result = await reportService.submit({
            target: normalizeId(parsed.data.target),
            reporter: normalizeId(parsed.data.reporter),
            outcome: parsed.data.outcome,
            paymentHash: parsed.data.paymentHash,
            preimage: parsed.data.preimage,
            amountBucket: parsed.data.amountBucket,
            memo: parsed.data.memo,
          });
          // Sim #9 M4: expose `preimage_verified` explicitly — the `verified`
          // boolean alone is ambiguous from an MCP tool caller's perspective
          // (verified what?). Keep `verified` for backwards compatibility with
          // existing MCP integrations.
          const reportPayload = {
            ...result,
            preimage_verified: result.verified,
          };
          return { content: [{ type: 'text', text: JSON.stringify(reportPayload, null, 2) }] };
        }

        case 'ping': {
          const pingSchema = z.object({ pubkey: z.string().regex(/^(02|03)[a-f0-9]{64}$/), from: z.string().regex(/^(02|03)[a-f0-9]{64}$/).optional() });
          const parsed = pingSchema.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `Invalid parameters: ${parsed.error.errors.map(e => e.message).join(', ')}` }], isError: true };
          }
          if (!lndClient.isConfigured()) {
            return { content: [{ type: 'text', text: JSON.stringify({ pubkey: parsed.data.pubkey, reachable: null, error: 'lnd_not_configured' }, null, 2) }] };
          }
          const startMs = Date.now();
          try {
            const response = await Promise.race([
              lndClient.queryRoutes(parsed.data.pubkey, 1000, parsed.data.from),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
            ]);
            const routes = response.routes ?? [];
            const hasRoute = routes.length > 0;
            return { content: [{ type: 'text', text: JSON.stringify({
              pubkey: parsed.data.pubkey, reachable: hasRoute,
              hops: hasRoute ? routes[0].hops.length : null,
              totalFeeMsat: hasRoute ? parseInt(routes[0].total_fees_msat, 10) || null : null,
              fromCaller: !!parsed.data.from, latencyMs: Date.now() - startMs,
            }, null, 2) }] };
          } catch {
            return { content: [{ type: 'text', text: JSON.stringify({ pubkey: parsed.data.pubkey, reachable: false, error: 'no_route', latencyMs: Date.now() - startMs }, null, 2) }] };
          }
        }

        case 'intent': {
          // Phase 6.0 — proxie vers POST /api/intent. Le MCP expose les
          // candidates avec le bloc stage_posteriors (Phase 5.14) + http_method
          // (Phase 5.10A) — l'agent voit tout ce qu'il faut pour choisir +
          // appeler directement l'endpoint. SatRank ne touche pas l'argent.
          const parsed = intentArgs.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `Invalid parameters: ${parsed.error.errors.map(e => e.message).join(', ')}` }], isError: true };
          }
          const url = new URL('/api/intent', SATRANK_API_BASE);
          if (parsed.data.fresh) url.searchParams.set('fresh', 'true');
          if (parsed.data.optimize) url.searchParams.set('optimize', parsed.data.optimize);
          if (parsed.data.limit) url.searchParams.set('limit', String(parsed.data.limit));
          try {
            // Security C3 — fetchWithCap : timeout 8s + body cap 1MB.
            const resp = await fetchWithCap(
              url.toString(),
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'User-Agent': 'SatRank-MCP/1.0' },
                body: JSON.stringify({
                  category: parsed.data.category,
                  keywords: parsed.data.keywords,
                  budget_sats: parsed.data.budget_sats,
                  max_latency_ms: parsed.data.max_latency_ms,
                  caller: parsed.data.caller,
                }),
              },
              MAX_INTENT_RESPONSE_BYTES,
              INTENT_FETCH_TIMEOUT_MS,
            );
            if (!resp.ok) {
              return { content: [{ type: 'text', text: JSON.stringify({ error: 'intent_failed', status: resp.status, body: resp.body, truncated: resp.truncated }, null, 2) }], isError: true };
            }
            if (resp.truncated) {
              return { content: [{ type: 'text', text: JSON.stringify({ error: 'response_too_large', max_bytes: MAX_INTENT_RESPONSE_BYTES }, null, 2) }], isError: true };
            }
            return { content: [{ type: 'text', text: resp.body }] };
          } catch (err) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: 'network_error', detail: err instanceof Error ? err.message : String(err) }, null, 2) }], isError: true };
          }
        }

        case 'verify_assertion': {
          // Phase 6.0 — verify offline une trust assertion (kind 30782) ou
          // calibration event (kind 30783). Pure function in assertionVerifier.
          const parsed = verifyAssertionArgs.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `Invalid parameters: ${parsed.error.errors.map(e => e.message).join(', ')}` }], isError: true };
          }
          const { verifyAssertion } = await import('../utils/assertionVerifier');
          const result = verifyAssertion(parsed.data.event, {
            expected_oracle_pubkey: parsed.data.expected_oracle_pubkey,
            now_sec: parsed.data.now_sec,
          });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        default:
          return { content: [{ type: 'text', text: 'Unknown tool' }], isError: true };
      }
    } catch (err: unknown) {
      logger.error({ err, tool: name }, 'MCP tool error');
      return { content: [{ type: 'text', text: 'Internal error' }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('SatRank MCP server started (stdio)');
}

async function shutdown() {
  await closePools();
  process.exit(0);
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });

main().catch(async (err) => {
  logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Fatal MCP error');
  await closePools();
  process.exit(1);
});
