// Public MCP server bundle (V2.0 — recentered 2026-05-08).
//
// Slim MCP entrypoint that ships on npm as `satrank-mcp`. Talks ONLY to the
// public SatRank HTTP API at SATRANK_API_BASE (default https://satrank.dev).
//
// Surface — V2.0 minimal: 3 tools focused on the agent consumer parcours:
//   discovery   intent, get_endpoint_score
//   offline     verify_assertion (pure fn, no network)
//
// Removed in V2.0 (vs V1.0.1): fulfill, fulfill_evidence, mini_llm_*,
// aeps.* — these subsystems are reclassified ADJACENT/HORS-PARCOURS in
// the post-distribution simplification report (8 May 2026). They remain
// in `src/mcp/server.ts` for self-hosters who want the full set.
//
// Zero DB dependency, zero LND dependency. Stdio transport. Boots in <100ms.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const SATRANK_API_BASE = (process.env.SATRANK_API_BASE ?? 'https://satrank.dev').replace(/\/$/, '');
const FETCH_TIMEOUT_MS = Number(process.env.SATRANK_MCP_TIMEOUT_MS ?? 12_000);
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
const urlHashArgs = z.object({ url_hash: z.string().regex(/^[0-9a-f]{64}$/) });
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
    { name: 'satrank-mcp', version: '2.0.0' },
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
