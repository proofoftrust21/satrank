// Phase 12.16 (2026-05-08) — public MCP server bundle.
//
// Slim MCP entrypoint that ships on npm as `satrank-mcp`. Unlike the full
// `src/mcp/server.ts` (which requires a local Postgres + LND wiring for
// the legacy oracle-internal tools), this build talks ONLY to the public
// SatRank HTTP API at SATRANK_API_BASE (default https://satrank.dev).
//
// Surface = the 17 tools an end-user agent actually wants :
//   discovery     intent, get_endpoint_score
//   commerce      fulfill, fulfill_evidence,
//                 mini_llm_classify, mini_llm_summarize, mini_llm_translate
//   audit         aeps.daily_anchor, aeps.recent_anchors,
//                 aeps.inclusion_proof, aeps.evidence_receipt
//   disputes      aeps.get_dispute, aeps.list_forks, aeps.get_observations
//   multi-hop     aeps.get_multihop
//   offline       verify_assertion (pure fn, no network)
//
// The 10 oracle-admin tools (get_agent_score, get_top_agents, decide, etc.)
// are intentionally NOT exposed here — they touch internal DB state and
// only make sense when self-hosting SatRank. Self-hosters use
// `src/mcp/server.ts` directly via `npm run mcp`.
//
// Zero DB dependency, zero LND dependency. Stdio transport. Boots in <100ms.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const SATRANK_API_BASE = (process.env.SATRANK_API_BASE ?? 'https://satrank.dev').replace(/\/$/, '');
const FETCH_TIMEOUT_MS = Number(process.env.SATRANK_MCP_TIMEOUT_MS ?? 12_000);
const FULFILL_TIMEOUT_MS = Number(process.env.SATRANK_MCP_FULFILL_TIMEOUT_MS ?? 32_000);
const MAX_BODY_BYTES = 1024 * 1024;

interface ProxyResult {
  status: number;
  ok: boolean;
  body: string;
  truncated: boolean;
}

async function fetchProxy(
  url: string,
  init: RequestInit,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<ProxyResult> {
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
      if (total > MAX_BODY_BYTES) {
        truncated = true;
        try { await reader.cancel(); } catch { /* swallow */ }
        break;
      }
      chunks.push(value);
    }
    return {
      status: resp.status,
      ok: resp.ok,
      body: Buffer.concat(chunks).toString('utf-8'),
      truncated,
    };
  } finally {
    clearTimeout(timer);
  }
}

function ok(body: string): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  return { content: [{ type: 'text' as const, text: body }] };
}

function err(payload: Record<string, unknown>): { content: Array<{ type: 'text'; text: string }>; isError: boolean } {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

async function proxyGet(path: string, timeoutMs?: number): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const r = await fetchProxy(
      `${SATRANK_API_BASE}${path}`,
      { method: 'GET', headers: { 'User-Agent': 'satrank-mcp/1.0' } },
      timeoutMs,
    );
    if (r.truncated) return err({ error: 'response_too_large', max_bytes: MAX_BODY_BYTES });
    return r.ok ? ok(r.body) : { content: [{ type: 'text' as const, text: r.body }], isError: true };
  } catch (e) {
    return err({ error: 'network_error', message: e instanceof Error ? e.message : String(e) });
  }
}

async function proxyPost(
  path: string,
  body: unknown,
  timeoutMs?: number,
  extraHeaders?: Record<string, string>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const r = await fetchProxy(
      `${SATRANK_API_BASE}${path}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'satrank-mcp/1.0',
          ...(extraHeaders ?? {}),
        },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
    if (r.truncated) return err({ error: 'response_too_large', max_bytes: MAX_BODY_BYTES });
    return r.ok ? ok(r.body) : { content: [{ type: 'text' as const, text: r.body }], isError: true };
  } catch (e) {
    return err({ error: 'network_error', message: e instanceof Error ? e.message : String(e) });
  }
}

// Zod schemas — same shapes as the full server, kept in sync intentionally.

const intentArgs = z.object({
  category: z.string().min(1).max(64),
  keywords: z.array(z.string()).optional(),
  budget_sats: z.number().int().min(1).max(10_000).optional(),
  max_latency_ms: z.number().int().min(1).max(60_000).optional(),
  optimize: z.enum(['p_success', 'latency', 'reliability', 'cost']).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});
const fulfillArgs = z.object({
  intent: z.object({
    category: z.string().min(1).max(64),
    keywords: z.array(z.string()).optional(),
  }),
  max_sats: z.number().int().min(1).max(10_000),
  max_latency_ms: z.number().int().min(100).max(60_000),
  recall_body: z.string().max(4096).optional(),
  recall_headers: z.record(z.string()).optional(),
  mode: z.enum(['deposit', 'hold']).optional(),
  refund_bolt11: z.string().optional(),
});
const jobIdArgs = z.object({ job_id: z.string().min(1).max(128) });
const urlHashArgs = z.object({ url_hash: z.string().regex(/^[0-9a-f]{64}$/) });
const dayArgs = z.object({ day_utc: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const recentAnchorsArgs = z.object({ limit: z.number().int().min(1).max(366).default(30).optional() });
const inclusionProofArgs = z.object({ receipt_id: z.number().int().min(1) });
const disputeIdArgs = z.object({ dispute_id: z.string().regex(/^dis_[0-9a-f]{32}$/) });
const listForksArgs = z.object({
  operator_pubkey: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  limit: z.number().int().min(1).max(500).default(100).optional(),
});
const getObservationsArgs = z.object({
  operator_pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  day_utc: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const multihopArgs = z.object({ chain_id: z.string().regex(/^mhc_[0-9a-f]{32}$/) });
const miniLlmText = z.object({ text: z.string().min(1).max(8000) });
const classifyArgs = miniLlmText.extend({ labels: z.array(z.string()).optional() });
const summarizeArgs = miniLlmText.extend({ max_words: z.number().int().min(10).max(800).optional() });
const translateArgs = miniLlmText.extend({ target: z.string().min(1).max(64) });
const verifyAssertionArgs = z.object({
  event: z.object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    pubkey: z.string().regex(/^[a-f0-9]{64}$/),
    created_at: z.number().int(),
    kind: z.number().int(),
    tags: z.array(z.array(z.string())),
    content: z.string(),
    sig: z.string().regex(/^[a-f0-9]{128}$/),
  }),
  expected_oracle_pubkey: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  now_sec: z.number().int().optional(),
});

async function main(): Promise<void> {
  const server = new Server(
    { name: 'satrank-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      // === Discovery + scoring ===
      {
        name: 'intent',
        description: 'Resolve an intent (category + keywords + budget + latency ceiling) into a ranked list of L402 endpoint candidates from the SatRank catalogue. Returns Bayesian p_success + ci95 + 5-stage breakdown per candidate. Use this BEFORE paying any L402 endpoint to pick the most trusted candidate that fits your budget + SLA. Free to call ; pass `fresh: true` to force a sync HTTP probe (costs 2 sats via /api/intent?fresh=true).',
        inputSchema: {
          type: 'object',
          properties: {
            category: { type: 'string', minLength: 1, maxLength: 64, description: 'Service category, e.g. "data/finance", "ai/text", "ai/classify"' },
            keywords: { type: 'array', items: { type: 'string' } },
            budget_sats: { type: 'number', minimum: 1, maximum: 10000 },
            max_latency_ms: { type: 'number', minimum: 1, maximum: 60000 },
            optimize: { type: 'string', enum: ['p_success', 'latency', 'reliability', 'cost'] },
            limit: { type: 'number', minimum: 1, maximum: 20 },
          },
          required: ['category'],
        },
      },
      {
        name: 'get_endpoint_score',
        description: 'Read the public scoring snapshot for a specific L402 endpoint URL. Returns Bayesian p_success + ci95, 5-stage breakdown (challenge / invoice / payment / delivery / quality), median_latency_ms, last_probe_age_sec, freshness_status, source attribution. Use BEFORE calling fulfill on a specific URL to verify trust independently of the ranking.',
        inputSchema: {
          type: 'object',
          properties: {
            url_hash: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'sha256 of the endpoint URL' },
          },
          required: ['url_hash'],
        },
      },
      // === Commerce ===
      {
        name: 'fulfill',
        description: 'Pay an L402 endpoint via SatRank fulfill proxy with hold-invoice + auto-issued evidence receipt. Agent supplies intent + max_sats budget + max_latency_ms SLA ; SatRank picks best candidate, settles the L402 payment, returns body + body_sha256 + preimage + operator_pubkey + premium_sats + job_id. Refund on candidate failure. Use this when you want SatRank to write the post-pay evidence trail (Ed25519-signed). NIP-98 auth required ; agent must have a token_balance via /api/deposit OR a bond. The MCP server forwards Authorization headers from the agent runtime.',
        inputSchema: {
          type: 'object',
          properties: {
            intent: {
              type: 'object',
              properties: {
                category: { type: 'string', minLength: 1 },
                keywords: { type: 'array', items: { type: 'string' } },
              },
              required: ['category'],
            },
            max_sats: { type: 'integer', minimum: 1, maximum: 10000 },
            max_latency_ms: { type: 'integer', minimum: 100, maximum: 60000 },
            recall_body: { type: 'string', maxLength: 4096 },
            recall_headers: { type: 'object', additionalProperties: { type: 'string' } },
            mode: { type: 'string', enum: ['deposit', 'hold'] },
            refund_bolt11: { type: 'string' },
          },
          required: ['intent', 'max_sats', 'max_latency_ms'],
        },
      },
      {
        name: 'fulfill_evidence',
        description: 'Fetch the public Ed25519-signed evidence receipt for a fulfill_jobs row by job_id. Returns canonical_json + signature + body_sha256 + operator_pubkey + ts_started + ts_finished + sats_paid. No auth required.',
        inputSchema: {
          type: 'object',
          properties: { job_id: { type: 'string', minLength: 1, maxLength: 128 } },
          required: ['job_id'],
        },
      },
      {
        name: 'mini_llm_classify',
        description: 'SatRank-operated L402 endpoint : single-best-label classification (10 sats). Powered by Claude Haiku 4.5 server-side. Use when the public AI catalogue is over-priced (>30 sats/req) for classification. The MCP server forwards Authorization headers ; agent runtime supplies the L402 macaroon after paying the 402 challenge.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', minLength: 1, maxLength: 8000 },
            labels: { type: 'array', items: { type: 'string' } },
          },
          required: ['text'],
        },
      },
      {
        name: 'mini_llm_summarize',
        description: 'SatRank-operated L402 endpoint : plain-prose summarization (10 sats). Powered by Claude Haiku 4.5 server-side. Use when the public AI catalogue prices summarization above your budget.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', minLength: 1, maxLength: 8000 },
            max_words: { type: 'integer', minimum: 10, maximum: 800 },
          },
          required: ['text'],
        },
      },
      {
        name: 'mini_llm_translate',
        description: 'SatRank-operated L402 endpoint : translation (10 sats). POST text + target language code, get back translated text only.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', minLength: 1, maxLength: 8000 },
            target: { type: 'string', minLength: 1, maxLength: 64 },
          },
          required: ['text', 'target'],
        },
      },
      // === AEPS read-only audit ===
      {
        name: 'aeps.daily_anchor',
        description: 'Fetch the daily Merkle anchor for a UTC day. Returns operator_pubkey + root_hex + receipt_count + L1 broadcast info. Verifiers use this for receipt inclusion proofs.',
        inputSchema: {
          type: 'object',
          properties: { day_utc: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
          required: ['day_utc'],
        },
      },
      {
        name: 'aeps.recent_anchors',
        description: 'List the most recent N daily Merkle anchors. Default 30, max 366.',
        inputSchema: {
          type: 'object',
          properties: { limit: { type: 'number', minimum: 1, maximum: 366 } },
        },
      },
      {
        name: 'aeps.inclusion_proof',
        description: 'Build the RFC 6962 audit path for a single evidence receipt against the day-Merkle root. Returns root_hex + audit_path[] + leaf_index + tree_size. Verifiers feed these to the AEPS Merkle verifier (TS or Rust impl) plus the L1 anchor txid to confirm the receipt is committed on-chain.',
        inputSchema: {
          type: 'object',
          properties: { receipt_id: { type: 'integer', minimum: 1 } },
          required: ['receipt_id'],
        },
      },
      {
        name: 'aeps.evidence_receipt',
        description: 'Fetch the Ed25519-signed evidence receipt for a fulfilled job. Same content as fulfill_evidence, addressable by job_id.',
        inputSchema: {
          type: 'object',
          properties: { job_id: { type: 'string', minLength: 1, maxLength: 128 } },
          required: ['job_id'],
        },
      },
      // === AEPS §10 disputes (read-only) ===
      {
        name: 'aeps.get_dispute',
        description: 'Read the current state of an AEPS dispute. Returns dispute_id + type + multiplier + oracle_pubkeys + oracle_threshold + state + attestations.',
        inputSchema: {
          type: 'object',
          properties: { dispute_id: { type: 'string', pattern: '^dis_[0-9a-f]{32}$' } },
          required: ['dispute_id'],
        },
      },
      {
        name: 'aeps.list_forks',
        description: 'List detected fork events (operator equivocations). Optional operator_pubkey filter.',
        inputSchema: {
          type: 'object',
          properties: {
            operator_pubkey: { type: 'string', pattern: '^[0-9a-f]{64}$' },
            limit: { type: 'number', minimum: 1, maximum: 500 },
          },
        },
      },
      {
        name: 'aeps.get_observations',
        description: 'Return all observed daily anchors for a (operator, day) bucket, grouped by root_hex. distinct_roots > 1 = equivocation.',
        inputSchema: {
          type: 'object',
          properties: {
            operator_pubkey: { type: 'string', pattern: '^[0-9a-f]{64}$' },
            day_utc: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
          required: ['operator_pubkey', 'day_utc'],
        },
      },
      {
        name: 'aeps.get_multihop',
        description: 'Read multi-hop HTLC chain state. Returns chain_id + agent_pubkey + per-leg state.',
        inputSchema: {
          type: 'object',
          properties: { chain_id: { type: 'string', pattern: '^mhc_[0-9a-f]{32}$' } },
          required: ['chain_id'],
        },
      },
      // === Offline ===
      {
        name: 'verify_assertion',
        description: 'Verify offline a SatRank-compatible Nostr trust assertion (kind 30782) or oracle calibration (kind 30783). Validates Schnorr signature + structure + valid_until tag. No network call. Use to compose oracle output across agents without re-querying SatRank.',
        inputSchema: {
          type: 'object',
          properties: {
            event: {
              type: 'object',
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
            expected_oracle_pubkey: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            now_sec: { type: 'number' },
          },
          required: ['event'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      switch (name) {
        case 'intent': {
          const p = intentArgs.safeParse(args);
          if (!p.success) return err({ error: 'invalid_params', issues: p.error.issues.slice(0, 5) });
          return await proxyPost('/api/intent', p.data);
        }
        case 'get_endpoint_score': {
          const p = urlHashArgs.safeParse(args);
          if (!p.success) return err({ error: 'invalid_params', issues: p.error.issues.slice(0, 5) });
          return await proxyGet(`/api/services/${p.data.url_hash}`);
        }
        case 'fulfill': {
          const p = fulfillArgs.safeParse(args);
          if (!p.success) return err({ error: 'invalid_params', issues: p.error.issues.slice(0, 5) });
          return await proxyPost('/api/fulfill', p.data, FULFILL_TIMEOUT_MS);
        }
        case 'fulfill_evidence': {
          const p = jobIdArgs.safeParse(args);
          if (!p.success) return err({ error: 'invalid_params', issues: p.error.issues.slice(0, 5) });
          return await proxyGet(`/api/fulfill/${encodeURIComponent(p.data.job_id)}/evidence`);
        }
        case 'mini_llm_classify': {
          const p = classifyArgs.safeParse(args);
          if (!p.success) return err({ error: 'invalid_params', issues: p.error.issues.slice(0, 5) });
          const { text, ...rest } = p.data;
          return await proxyPost('/api/mini-llm/classify', { text, options: rest });
        }
        case 'mini_llm_summarize': {
          const p = summarizeArgs.safeParse(args);
          if (!p.success) return err({ error: 'invalid_params', issues: p.error.issues.slice(0, 5) });
          const { text, ...rest } = p.data;
          return await proxyPost('/api/mini-llm/summarize', { text, options: rest });
        }
        case 'mini_llm_translate': {
          const p = translateArgs.safeParse(args);
          if (!p.success) return err({ error: 'invalid_params', issues: p.error.issues.slice(0, 5) });
          const { text, ...rest } = p.data;
          return await proxyPost('/api/mini-llm/translate', { text, options: rest });
        }
        case 'aeps.daily_anchor': {
          const p = dayArgs.safeParse(args);
          if (!p.success) return err({ error: 'invalid_params', issues: p.error.issues.slice(0, 5) });
          return await proxyGet(`/api/aeps/anchor/${p.data.day_utc}`);
        }
        case 'aeps.recent_anchors': {
          const p = recentAnchorsArgs.safeParse(args);
          if (!p.success) return err({ error: 'invalid_params', issues: p.error.issues.slice(0, 5) });
          const lim = p.data.limit ?? 30;
          return await proxyGet(`/api/aeps/anchor/recent?limit=${lim}`);
        }
        case 'aeps.inclusion_proof': {
          const p = inclusionProofArgs.safeParse(args);
          if (!p.success) return err({ error: 'invalid_params', issues: p.error.issues.slice(0, 5) });
          return await proxyGet(`/api/aeps/evidence/${p.data.receipt_id}/inclusion-proof`);
        }
        case 'aeps.evidence_receipt': {
          const p = jobIdArgs.safeParse(args);
          if (!p.success) return err({ error: 'invalid_params', issues: p.error.issues.slice(0, 5) });
          return await proxyGet(`/api/fulfill/${encodeURIComponent(p.data.job_id)}/evidence`);
        }
        case 'aeps.get_dispute': {
          const p = disputeIdArgs.safeParse(args);
          if (!p.success) return err({ error: 'invalid_params', issues: p.error.issues.slice(0, 5) });
          return await proxyGet(`/api/aeps/dispute/${p.data.dispute_id}`);
        }
        case 'aeps.list_forks': {
          const p = listForksArgs.safeParse(args);
          if (!p.success) return err({ error: 'invalid_params', issues: p.error.issues.slice(0, 5) });
          const params = new URLSearchParams();
          if (p.data.operator_pubkey) params.set('operator_pubkey', p.data.operator_pubkey);
          if (p.data.limit) params.set('limit', String(p.data.limit));
          const q = params.toString();
          return await proxyGet(`/api/aeps/forks${q ? `?${q}` : ''}`);
        }
        case 'aeps.get_observations': {
          const p = getObservationsArgs.safeParse(args);
          if (!p.success) return err({ error: 'invalid_params', issues: p.error.issues.slice(0, 5) });
          return await proxyGet(`/api/aeps/observations/${p.data.operator_pubkey}/${p.data.day_utc}`);
        }
        case 'aeps.get_multihop': {
          const p = multihopArgs.safeParse(args);
          if (!p.success) return err({ error: 'invalid_params', issues: p.error.issues.slice(0, 5) });
          return await proxyGet(`/api/aeps/multihop/${p.data.chain_id}`);
        }
        case 'verify_assertion': {
          // Pure offline verification — same logic as the full server but
          // with an inlined dynamic import so we don't pull the database
          // graph through the bundle.
          const p = verifyAssertionArgs.safeParse(args);
          if (!p.success) return err({ error: 'invalid_params', issues: p.error.issues.slice(0, 5) });
          try {
            const mod = await import('../utils/assertionVerifier');
            const result = mod.verifyAssertion(p.data.event, {
              expected_oracle_pubkey: p.data.expected_oracle_pubkey,
              now_sec: p.data.now_sec,
            });
            return ok(JSON.stringify(result, null, 2));
          } catch (e) {
            return err({ error: 'verify_failed', message: e instanceof Error ? e.message : String(e) });
          }
        }
        default:
          return err({ error: 'unknown_tool', name });
      }
    } catch (e) {
      return err({ error: 'internal', message: e instanceof Error ? e.message : String(e) });
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stdio transport is silent post-connect ; nothing else to log to stdout
  // (which is reserved for the MCP protocol). Errors go to stderr only.
}

main().catch((e) => {
  process.stderr.write(`satrank-mcp fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
