#!/usr/bin/env node
// SatRank V3 — MCP server (slim, 3 tools).
//
// Talks ONLY to the public REST API. No DB access, no LND, no Postgres.
// This file ships verbatim as the npm `satrank-mcp` package — the bin
// resolves to `dist/mcp.js`. Self-hosters point SATRANK_API_BASE at their
// own deployment.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { verifyEvent } from 'nostr-tools/pure';

const API_BASE = process.env.SATRANK_API_BASE ?? 'https://satrank.dev';

const server = new Server({ name: 'satrank-mcp', version: '3.0.0' }, { capabilities: { tools: {} } });

// --- Tool schemas -----------------------------------------------------------

const intentSchema = z.object({
  category: z.string().min(1),
  keywords: z.array(z.string()).optional(),
  budget_sats: z.number().min(1).max(10_000).optional(),
  max_latency_ms: z.number().min(1).max(60_000).optional(),
  optimize: z.enum(['p_success', 'latency', 'cost']).optional(),
  limit: z.number().min(1).max(20).optional(),
});

const getEndpointScoreSchema = z.object({
  url_hash: z.string().regex(/^[a-f0-9]{64}$/),
});

const verifyAssertionSchema = z.object({
  event: z.object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    pubkey: z.string().regex(/^[a-f0-9]{64}$/),
    created_at: z.number(),
    kind: z.number(),
    tags: z.array(z.array(z.string())),
    content: z.string(),
    sig: z.string().regex(/^[a-f0-9]{128}$/),
  }),
  expected_oracle_pubkey: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  now_sec: z.number().optional(),
});

// --- Helpers ----------------------------------------------------------------

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function callApi(path: string, init?: RequestInit): Promise<ToolResult> {
  try {
    const res = await fetch(`${API_BASE}${path}`, init);
    const text = await res.text();
    return { content: [{ type: 'text', text }], isError: !res.ok };
  } catch (err: unknown) {
    return fail(`network error: ${(err as Error).message}`);
  }
}

// --- Tool list --------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'intent',
      description: 'Resolve an intent (category + budget + SLA) into a ranked list of L402 endpoint candidates. Returns Bayesian p_success per stage. PAID: 2 sats via L402 — your runtime should retry with the L402 token after the first 402.',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'e.g. "data/finance", "ai/text"' },
          keywords: { type: 'array', items: { type: 'string' } },
          budget_sats: { type: 'number', minimum: 1, maximum: 10_000 },
          max_latency_ms: { type: 'number', minimum: 1, maximum: 60_000 },
          optimize: { type: 'string', enum: ['p_success', 'latency', 'cost'] },
          limit: { type: 'number', minimum: 1, maximum: 20 },
        },
        required: ['category'],
      },
    },
    {
      name: 'get_endpoint_score',
      description: 'Read the public scoring snapshot for a specific endpoint URL hash (sha256 hex). FREE.',
      inputSchema: {
        type: 'object',
        properties: { url_hash: { type: 'string', pattern: '^[0-9a-f]{64}$' } },
        required: ['url_hash'],
      },
    },
    {
      name: 'verify_assertion',
      description: 'Verify offline a SatRank Nostr trust assertion (kind 30782). Validates Schnorr signature + valid_until tag. No network call.',
      inputSchema: {
        type: 'object',
        properties: {
          event: { type: 'object' },
          expected_oracle_pubkey: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          now_sec: { type: 'number' },
        },
        required: ['event'],
      },
    },
  ],
}));

// --- Tool dispatcher --------------------------------------------------------

// MCP SDK 1.29 ServerResult union added a task-shaped variant ; cast through to
// silence the type strictness. Our content-list-shaped response is still
// fully compatible at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
server.setRequestHandler(CallToolRequestSchema, async (req: any): Promise<any> => {
  const { name, arguments: args } = req.params;
  switch (name) {
    case 'intent': {
      const parsed = intentSchema.safeParse(args);
      if (!parsed.success) return fail(`invalid args: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
      return await callApi('/api/intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.data),
      });
    }
    case 'get_endpoint_score': {
      const parsed = getEndpointScoreSchema.safeParse(args);
      if (!parsed.success) return fail(`invalid args: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
      return await callApi(`/api/services/${parsed.data.url_hash}`);
    }
    case 'verify_assertion': {
      const parsed = verifyAssertionSchema.safeParse(args);
      if (!parsed.success) return fail(`invalid args: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
      const { event, expected_oracle_pubkey, now_sec } = parsed.data;
      const sigOk = verifyEvent(event as unknown as Parameters<typeof verifyEvent>[0]);
      const validUntilTag = (event.tags as string[][]).find((t) => t[0] === 'valid_until');
      const valid_until = validUntilTag ? Number(validUntilTag[1]) : null;
      const now = now_sec ?? Math.floor(Date.now() / 1000);
      const expired = valid_until !== null ? valid_until < now : false;
      const pubkeyOk = expected_oracle_pubkey === undefined || event.pubkey === expected_oracle_pubkey;
      return ok({
        valid: sigOk && pubkeyOk && !expired,
        signature_ok: sigOk,
        pubkey_ok: pubkeyOk,
        expired,
        valid_until,
      });
    }
    default:
      return fail(`unknown tool: ${name}`);
  }
});

// --- Entry point ------------------------------------------------------------

(async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
})().catch((err) => {
  process.stderr.write(`fatal: ${err.message}\n`);
  process.exit(1);
});
