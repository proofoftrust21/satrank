// OpenAPI 3.1 specification for SatRank API
export const openapiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'SatRank API',
    version: '1.3.0',
    description: 'Trust score for autonomous agents on Bitcoin Lightning. The PageRank of the agentic economy.\n\nPricing Mix A+D (2026-04-26): agent + attestation reads moved to free discovery (10 req/min/IP). The paid surface is now: /probe, /verdicts (batch), /profile/:id, and /intent when ?fresh=true (paid: 2 sats, server runs a synchronous HTTP probe on the top candidates).',
    license: { name: 'AGPL-3.0' },
  },
  servers: [{ url: '/api' }],
  paths: {
    '/agent/{publicKeyHash}': {
      get: {
        summary: 'Get agent score',
        operationId: 'getAgentScore',
        description: 'Pricing Mix A+D (2026-04-26): free directory read, rate-limited at 10/min/IP. No L402 required.',
        tags: ['Agents'],
        parameters: [{ $ref: '#/components/parameters/publicKeyHash' }],
        responses: {
          '200': {
            description: 'Agent score details',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                data: { $ref: '#/components/schemas/AgentScoreResponse' },
              },
            } } },
          },
          '202': { $ref: '#/components/responses/AutoIndexing' },
          '404': { $ref: '#/components/responses/NotFound' },
          '400': { $ref: '#/components/responses/ValidationError' },
          '429': { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/agent/{publicKeyHash}/verdict': {
      get: {
        summary: 'Get agent verdict (SAFE / RISKY / UNKNOWN)',
        operationId: 'getAgentVerdict',
        description: 'Binary trust decision optimized for < 200ms agent-to-agent evaluation. Returns SAFE, RISKY, or UNKNOWN with confidence, flags, risk profile, and optional personalized trust distance.\n\nPricing Mix A+D (2026-04-26): free directory read, rate-limited at 10/min/IP. No L402 required.',
        tags: ['Agents'],
        parameters: [
          { $ref: '#/components/parameters/publicKeyHash' },
          {
            name: 'caller_pubkey',
            in: 'query',
            required: false,
            schema: { type: 'string', pattern: '^(?:[a-f0-9]{64}|(02|03)[a-f0-9]{64})$' },
            description: 'Your own pubkey hash (64 hex) or Lightning pubkey (66 hex with 02/03 prefix). Enables personalized trust graph and real-time pathfinding (route from you to the target). Also accepted as X-Caller-Pubkey header.',
          },
        ],
        responses: {
          '200': {
            description: 'Agent verdict',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                data: { $ref: '#/components/schemas/VerdictResponse' },
              },
            } } },
          },
          '202': { $ref: '#/components/responses/AutoIndexing' },
          '400': { $ref: '#/components/responses/ValidationError' },
          '429': { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/verdicts': {
      post: {
        summary: 'Batch verdict (up to 100 hashes in one request)',
        operationId: 'batchVerdicts',
        description: 'Returns SAFE/RISKY/UNKNOWN for multiple agents in one request. Triggers auto-indexation for unknown Lightning pubkeys.',
        tags: ['Agents'],
        security: [{ l402: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['hashes'],
            properties: {
              hashes: {
                type: 'array',
                items: { type: 'string', pattern: '^[a-f0-9]{64}$' },
                minItems: 1,
                maxItems: 100,
                description: 'Array of SHA256 hex hashes (max 100)',
              },
            },
          } } },
        },
        responses: {
          '200': {
            description: 'Array of verdicts',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                data: {
                  type: 'array',
                  items: {
                    allOf: [
                      { type: 'object', properties: { publicKeyHash: { type: 'string' } }, required: ['publicKeyHash'] },
                      { $ref: '#/components/schemas/VerdictResponse' },
                    ],
                  },
                },
              },
            } } },
          },
          '202': { $ref: '#/components/responses/AutoIndexing' },
          '402': { $ref: '#/components/responses/PaymentRequired' },
          '400': { $ref: '#/components/responses/ValidationError' },
        },
      },
    },
    '/agent/{publicKeyHash}/history': {
      get: {
        summary: 'Get agent posterior history',
        operationId: 'getAgentHistory',
        description: 'Returns the current Bayesian posterior. Posterior-history samples (data[]) land with the Commit 8 aggregate tables; the response shape is stable.\n\nPricing Mix A+D (2026-04-26): free directory read, rate-limited at 10/min/IP. No L402 required.',
        tags: ['Agents'],
        parameters: [
          { $ref: '#/components/parameters/publicKeyHash' },
          { $ref: '#/components/parameters/limit' },
          { $ref: '#/components/parameters/offset' },
        ],
        responses: {
          '200': {
            description: 'Current posterior + paginated history samples',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                data: {
                  type: 'array',
                  items: { type: 'object', description: 'Posterior history sample (populated in Commit 8).' },
                },
                bayesian: { $ref: '#/components/schemas/BayesianScoreBlock' },
                meta: { $ref: '#/components/schemas/PaginationMeta' },
              },
            } } },
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '429': { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/agent/{publicKeyHash}/attestations': {
      get: {
        summary: 'Get attestations received by an agent',
        operationId: 'getAgentAttestations',
        description: 'Pricing Mix A+D (2026-04-26): free directory read, rate-limited at 10/min/IP. No L402 required.',
        tags: ['Attestations'],
        parameters: [
          { $ref: '#/components/parameters/publicKeyHash' },
          { $ref: '#/components/parameters/limit' },
          { $ref: '#/components/parameters/offset' },
        ],
        responses: {
          '200': {
            description: 'Paginated attestations',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                data: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/Attestation' },
                },
                meta: { $ref: '#/components/schemas/PaginationMeta' },
              },
            } } },
          },
          '404': { $ref: '#/components/responses/NotFound' },
          '400': { $ref: '#/components/responses/ValidationError' },
          '429': { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/agents/movers': {
      get: {
        summary: 'Top posterior movers (Commit 8)',
        operationId: 'getTopMovers',
        description: 'Returns agents with the biggest posterior shifts. Posterior-delta movers require the Commit 8 aggregate tables; the response returns an empty envelope until those land.',
        tags: ['Agents'],
        responses: {
          '200': {
            description: 'Empty until Commit 8 aggregate tables ship',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  properties: {
                    gainers: { type: 'array', items: { $ref: '#/components/schemas/AgentSummary' } },
                    losers: { type: 'array', items: { $ref: '#/components/schemas/AgentSummary' } },
                  },
                },
                meta: { type: 'object', properties: { note: { type: 'string' } } },
              },
            } } },
          },
        },
      },
    },
    '/agents/top': {
      get: {
        summary: 'Leaderboard by score or component',
        operationId: 'getTopAgents',
        tags: ['Agents'],
        parameters: [
          { $ref: '#/components/parameters/limit' },
          { $ref: '#/components/parameters/offset' },
          {
            name: 'sort_by',
            in: 'query',
            schema: {
              type: 'string',
              enum: ['p_success', 'n_obs', 'ci95_width', 'window_freshness'],
              default: 'p_success',
            },
            description: 'Bayesian sort axis. `p_success` (posterior mean, DESC) is the default; `n_obs` (observation count, DESC), `ci95_width` (tighter posterior, ASC), and `window_freshness` (more recent window, DESC) are supported. Legacy composite axes (score, volume, reputation, seniority, regularity, diversity) return 400.',
          },
        ],
        responses: {
          '200': {
            description: 'Paginated agent leaderboard',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                data: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/AgentSummary' },
                },
                meta: { $ref: '#/components/schemas/PaginationMeta' },
              },
            } } },
          },
        },
      },
    },
    '/agents/search': {
      get: {
        summary: 'Search agents by alias',
        operationId: 'searchAgents',
        tags: ['Agents'],
        parameters: [
          { name: 'alias', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 100 } },
          { $ref: '#/components/parameters/limit' },
          { $ref: '#/components/parameters/offset' },
        ],
        responses: {
          '200': {
            description: 'Paginated search results',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                data: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/AgentSearchResult' },
                },
                meta: { $ref: '#/components/schemas/PaginationMeta' },
              },
            } } },
          },
          '400': { $ref: '#/components/responses/ValidationError' },
        },
      },
    },
    '/attestations': {
      post: {
        summary: 'Submit an attestation (free, no L402 payment required)',
        operationId: 'createAttestation',
        description: 'Attestations are free. They are the fuel of the trust network. Requires an API key (X-API-Key header) for identity verification, but no Lightning payment.',
        tags: ['Attestations'],
        security: [{ apiKey: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateAttestationInput' } } },
        },
        responses: {
          '201': {
            description: 'Attestation created',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  properties: {
                    attestationId: { type: 'string', format: 'uuid' },
                    timestamp: { type: 'integer' },
                  },
                },
              },
            } } },
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '409': { description: 'Duplicate attestation (error.code = DUPLICATE_REPORT)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        },
      },
    },
    '/health': {
      get: {
        summary: 'Service health',
        operationId: 'getHealth',
        tags: ['System'],
        responses: {
          '200': {
            description: 'Health status',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: { data: { $ref: '#/components/schemas/HealthResponse' } },
            } } },
          },
          '503': {
            description: 'Service degraded (database unreachable or schema mismatch)',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: { data: { $ref: '#/components/schemas/HealthResponse' } },
            } } },
          },
        },
      },
    },
    '/stats': {
      get: {
        summary: 'Network statistics',
        operationId: 'getStats',
        tags: ['System'],
        responses: {
          '200': {
            description: 'Network stats',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: { data: { $ref: '#/components/schemas/NetworkStats' } },
            } } },
          },
        },
      },
    },
    '/stats/reports': {
      get: {
        summary: 'Report adoption dashboard (30-day)',
        operationId: 'getReportStats',
        description: 'Public 30-day report-adoption dashboard. Weekly buckets + cumulative progress vs targetN (200). The `bonus.*` block (payouts, distinct recipients, enabled flag) is only returned with a valid X-API-Key; unauthenticated callers get the summary + weekly fields only. Cached 5 minutes server-side.',
        tags: ['System'],
        responses: {
          '200': {
            description: 'Report stats',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: { data: { $ref: '#/components/schemas/ReportStatsResponse' } },
            } } },
          },
        },
      },
    },
    '/version': {
      get: {
        summary: 'Build version',
        operationId: 'getVersion',
        tags: ['System'],
        responses: {
          '200': {
            description: 'Version info',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: { data: { $ref: '#/components/schemas/VersionResponse' } },
            } } },
          },
        },
      },
    },
    '/report': {
      post: {
        summary: 'Report outcome',
        operationId: 'report',
        description: 'Submit a success/failure/timeout report. Authenticated (X-API-Key or an L402 deposit token that previously queried this target; see token_query_log scoping). Does not consume quota. Weighted by reporter trust score and reporter badge tier; preimage verification gives a 2x weight bonus.',
        tags: ['Reports'],
        security: [{ apiKey: [] }, { l402: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ReportRequest' } } },
        },
        responses: {
          '201': {
            description: 'Report accepted',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/ReportResponse' } } } } },
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { description: 'Missing or invalid auth (no X-API-Key and no query-scoped L402 token for this target)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          '403': { description: 'L402 token not scoped to this target (no token_query_log row linking token→target within the auth window)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          '404': { $ref: '#/components/responses/NotFound' },
          '409': { description: 'Duplicate report (same reporter+target within 1 hour, error.code = DUPLICATE_REPORT)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        },
      },
    },
    '/profile/{id}': {
      get: {
        summary: 'Agent profile with reports and uptime',
        operationId: 'getProfile',
        description: 'Restructured agent view with report statistics, probe uptime, rank, and full evidence.',
        tags: ['Profiles'],
        security: [{ l402: [] }],
        parameters: [{
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', pattern: '^(?:[a-f0-9]{64}|(02|03)[a-f0-9]{64})$' },
          description: '64-char SHA256 hash or 66-char Lightning pubkey',
        }],
        responses: {
          '200': {
            description: 'Agent profile',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/ProfileResponse' } } } } },
          },
          '402': { $ref: '#/components/responses/PaymentRequired' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/ping/{pubkey}': {
      get: {
        summary: 'Real-time reachability check',
        operationId: 'ping',
        description: 'QueryRoutes in real-time via LND. Returns whether a Lightning node is reachable right now, hops, and fees. Free (no L402 required). Use ?from=<your_pubkey> for personalized pathfinding.',
        tags: ['Discovery'],
        parameters: [
          { name: 'pubkey', in: 'path', required: true, schema: { type: 'string', pattern: '^(02|03)[a-f0-9]{64}$' }, description: '66-char Lightning pubkey' },
          { name: 'from', in: 'query', required: false, schema: { type: 'string', pattern: '^(02|03)[a-f0-9]{64}$' }, description: 'Optional: your Lightning pubkey for personalized pathfinding' },
        ],
        responses: {
          '200': {
            description: 'Reachability result',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'object', properties: {
              pubkey: { type: 'string' },
              reachable: { type: ['boolean', 'null'] },
              hops: { type: ['integer', 'null'] },
              totalFeeMsat: { type: ['integer', 'null'] },
              routeFound: { type: 'boolean' },
              fromCaller: { type: 'boolean' },
              checkedAt: { type: 'integer' },
              latencyMs: { type: 'integer' },
              error: { type: ['string', 'null'] },
            } } } } } },
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '429': { description: 'Rate limited (10 requests/minute)' },
        },
      },
    },
    '/deposit': {
      post: {
        summary: 'Buy requests via variable-amount Lightning invoice (tiered rate)',
        operationId: 'deposit',
        description: 'Two-phase deposit with tiered rate. Phase 1: send { amount } (21 to 1,000,000 sats) to receive a BOLT11 invoice. Phase 2: after payment, send { paymentHash, preimage } to verify and credit the balance. The oracle looks up the tier whose floor is the highest floor less than or equal to amount and engraves its rate (sats per request) onto the resulting token. Tier rates and floors are public at GET /api/deposit/tiers. Use the resulting token on all paid endpoints: Authorization: L402 deposit:<preimage>. Rate limited to 3 invoices/min/IP.',
        tags: ['Payment'],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { oneOf: [
            { type: 'object', properties: { amount: { type: 'integer', minimum: 21, maximum: 1000000, description: 'Sats to deposit (21 to 1,000,000). The tier whose floor is the highest floor ≤ amount determines the rate engraved on the resulting token.' } }, required: ['amount'] },
            { type: 'object', properties: { paymentHash: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Payment hash from the invoice' }, preimage: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Payment preimage (proof of payment)' } }, required: ['paymentHash', 'preimage'] },
          ] } } },
        },
        responses: {
          '201': { description: 'Deposit verified, balance credited', content: { 'application/json': { schema: { type: 'object', properties: {
            data: { $ref: '#/components/schemas/DepositVerifiedResponse' },
          } } } } },
          '402': { description: 'Phase 1: invoice generated. Phase 2: payment not yet settled.', content: { 'application/json': { schema: { type: 'object', properties: {
            data: { $ref: '#/components/schemas/DepositInvoiceResponse' },
          } } } } },
          '400': { $ref: '#/components/responses/ValidationError' },
          '429': { description: 'Rate limited (3 invoices/min/IP)' },
          '503': { description: 'Deposit unavailable (invoice macaroon not configured)' },
        },
      },
    },
    '/watchlist': {
      get: {
        summary: 'Poll for verdict changes on watched targets',
        operationId: 'getWatchlist',
        description: 'Returns verdicts that changed since the given timestamp. Free endpoint. Use as a fallback when Nostr NIP-85 subscription is not available. For real-time updates, subscribe to kind 30382 events on relay.damus.io, nos.lol, or relay.primal.net (published every 30 min, delta-only).',
        tags: ['Monitoring'],
        parameters: [
          { name: 'targets', in: 'query', required: true, schema: { type: 'string' }, description: 'Comma-separated 64-char hex hashes (max 50)' },
          { name: 'since', in: 'query', required: false, schema: { type: 'integer', minimum: 0 }, description: 'Unix timestamp; only return changes after this time. Omit for all latest verdicts.' },
        ],
        responses: {
          '200': { description: 'Changed verdicts since the given timestamp', content: { 'application/json': { schema: { type: 'object', properties: {
            data: { type: 'array', items: { type: 'object', required: ['publicKeyHash', 'alias', 'bayesian', 'changedAt'], properties: {
              publicKeyHash: { type: 'string' },
              alias: { type: ['string', 'null'] },
              bayesian: { $ref: '#/components/schemas/BayesianScoreBlock' },
              changedAt: { type: 'integer', description: 'Unix timestamp of the posterior change.' },
            } } },
            meta: { type: 'object', properties: {
              since: { type: 'integer' },
              queriedAt: { type: 'integer' },
              targets: { type: 'integer' },
              changed: { type: 'integer' },
            } },
          } } } } },
          '400': { $ref: '#/components/responses/ValidationError' },
        },
      },
    },
    '/intent': {
      post: {
        summary: 'Resolve a structured intent to ranked L402 candidates',
        operationId: 'resolveIntent',
        description: 'Discovery API. The agent provides a structured intent (category + optional keywords + budget + max_latency); SatRank returns up to 20 candidates ranked Bayesian-native (p_success DESC → ci95_low DESC → price_sats ASC) with advisory overlay and health snapshot. Neutral ordering (no paid listing). snake_case convention.\n\nPricing Mix A+D (2026-04-26): the default path is **free** (rate-limited at 10/min/IP) with explicit staleness disclaimer (per-candidate `advisory.freshness_status` + `meta.upgrade_path`). Pass `fresh=true` (query string `?fresh=true` or body `{ "fresh": true }`) to upgrade to the **paid** path (2 sats via L402): the server runs a synchronous HTTP probe on the top candidates and guarantees `last_probe_age_sec < 60s`.\n\nCategory must be a known enum member (see GET /api/intent/categories). Unknown categories → 400 INVALID_CATEGORY. Malformed categories → 400 VALIDATION_ERROR.\n\nStrictness tiers (aligned with /api/services/best): strict (SAFE only) → relaxed (any non-RISKY, warning FALLBACK_RELAXED) → degraded (pool empty, warning NO_CANDIDATES). RISKY candidates are never returned.',
        tags: ['Discovery'],
        parameters: [
          {
            name: 'fresh',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['true'] },
            description: 'Mix A+D — when set to the literal string "true", the request is treated as the paid fresh path (L402 challenge, 2 sats). The server force-probes the top candidates synchronously before returning. Equivalent to body `{ "fresh": true }`.',
          },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object', required: ['category'],
            properties: {
              category: { type: 'string', minLength: 1, maxLength: 50, description: 'Canonical category (lowercase, matches /^[a-z][a-z0-9/_-]{1,31}$/). Normalized via aliases (e.g. "lightning" → "bitcoin").' },
              keywords: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 50 }, maxItems: 10, description: 'AND filter on endpoint name/description/category/provider (case-insensitive LIKE).' },
              budget_sats: { type: 'integer', minimum: 0, maximum: 1_000_000, description: 'Upper bound on service price. Endpoints without a known price are excluded.' },
              max_latency_ms: { type: 'integer', minimum: 0, maximum: 60_000, description: 'Upper bound on 7-day median HTTP latency. Endpoints with < 3 probes are excluded.' },
              caller: { type: 'string', minLength: 1, maxLength: 200, description: 'Free-form identifier for logging. Not stored.' },
              limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max candidates returned. Default 5.' },
              fresh: { type: 'boolean', description: 'Mix A+D — when true, paid path: synchronous probe of the top candidates before returning. Equivalent to query param `?fresh=true`. 2 sats via L402.' },
            },
          } } },
        },
        responses: {
          '200': {
            description: 'Ranked candidates + resolved intent echo + meta',
            content: { 'application/json': { schema: {
              type: 'object', properties: {
                intent: { type: 'object', properties: {
                  category: { type: 'string' },
                  keywords: { type: 'array', items: { type: 'string' } },
                  budget_sats: { type: ['integer', 'null'] },
                  max_latency_ms: { type: ['integer', 'null'] },
                  resolved_at: { type: 'integer', description: 'Unix timestamp (seconds) when the server resolved the intent.' },
                  fresh: { type: 'boolean', description: 'Mix A+D — true when the paid fresh path was honoured (top candidates synchronously probed). false on free directory reads.' },
                } },
                candidates: { type: 'array', items: { type: 'object', properties: {
                  rank: { type: 'integer' },
                  endpoint_url: { type: 'string', format: 'uri' },
                  endpoint_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
                  operator_pubkey: { type: ['string', 'null'], description: '66-char LN pubkey of the node operator.' },
                  service_name: { type: ['string', 'null'] },
                  price_sats: { type: ['integer', 'null'] },
                  median_latency_ms: { type: ['integer', 'null'], description: 'SQL median over service_probes within 7 days (null if < 3 probes).' },
                  http_method: {
                    type: 'string',
                    enum: ['GET', 'POST'],
                    description: 'Phase 5.10A — HTTP method advertised by the upstream registry (402index.io). The SDK fulfill() defaults to this method when the agent does not explicitly override.',
                  },
                  stage_posteriors: {
                    $ref: '#/components/schemas/StagePosteriorsBlock',
                  },
                  bayesian: { $ref: '#/components/schemas/BayesianScoreBlock' },
                  advisory: { type: 'object', properties: {
                    advisory_level: { type: 'string', enum: ['green', 'yellow', 'orange', 'red', 'insufficient_freshness'] },
                    risk_score: { type: 'number', minimum: 0, maximum: 1 },
                    advisories: { type: 'array', items: { type: 'object' } },
                    recommendation: { type: 'string', enum: ['proceed', 'proceed_with_caution', 'consider_alternative', 'avoid'] },
                    freshness_status: {
                      type: 'string',
                      enum: ['fresh', 'recent', 'stale', 'very_stale'],
                      description: 'Mix A+D — explicit staleness bucket derived from `health.last_probe_age_sec`. fresh: <60s, recent: <1h, stale: <24h, very_stale: ≥24h or no probe on record.',
                    },
                  } },
                  health: { type: 'object', properties: {
                    reachability: { type: ['number', 'null'], minimum: 0, maximum: 1 },
                    http_health_score: { type: ['number', 'null'], minimum: 0, maximum: 1 },
                    health_freshness: { type: ['number', 'null'], minimum: 0, maximum: 1 },
                    last_probe_age_sec: { type: ['integer', 'null'] },
                  } },
                } } },
                meta: { type: 'object', properties: {
                  total_matched: { type: 'integer', description: 'Endpoints matching category + keywords + budget + latency (before strictness).' },
                  returned: { type: 'integer' },
                  strictness: { type: 'string', enum: ['strict', 'relaxed', 'degraded'] },
                  warnings: { type: 'array', items: { type: 'string' }, description: 'e.g. FALLBACK_RELAXED, NO_CANDIDATES.' },
                  upgrade_path: {
                    type: 'object',
                    description: 'Mix A+D — only present on free responses (fresh !== true). Tells the agent how to upgrade to a synchronously probed result.',
                    properties: {
                      flag: { type: 'string', enum: ['fresh=true'] },
                      cost_sats: { type: 'integer', example: 2 },
                      message: { type: 'string' },
                    },
                  },
                } },
              },
            } } },
          },
          '402': { $ref: '#/components/responses/PaymentRequired' },
          '400': { description: 'VALIDATION_ERROR (malformed body) or INVALID_CATEGORY (unknown category)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          '429': { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/intent/categories': {
      get: {
        summary: 'List known categories with endpoint count + active count',
        operationId: 'listIntentCategories',
        description: 'Returns all non-null categories across trusted service sources (402index + self_registered). `endpoint_count` is the raw total; `active_count` restricts to endpoints with ≥3 probes AND uptime ≥ 0.5. Free endpoint. Use to populate category enums in SDKs before calling POST /api/intent.',
        tags: ['Discovery'],
        responses: {
          '200': { description: 'Category list', content: { 'application/json': { schema: { type: 'object', properties: {
            categories: { type: 'array', items: { type: 'object', properties: {
              name: { type: 'string' },
              endpoint_count: { type: 'integer' },
              active_count: { type: 'integer' },
            } } },
          } } } } },
        },
      },
    },
    '/services': {
      get: {
        summary: 'Discover L402 services by category or keyword',
        operationId: 'searchServices',
        description: 'Browse and search the L402 service registry. Returns service metadata (name, description, category, provider, price) enriched with the SatRank canonical Bayesian block for the backing Lightning node. Free endpoint (no L402 required). Data sourced from 402index.io, refreshed every 24h.',
        tags: ['Discovery'],
        parameters: [
          { name: 'q', in: 'query', required: false, schema: { type: 'string', maxLength: 100 }, description: 'Fulltext search across name, description, category, and provider' },
          { name: 'category', in: 'query', required: false, schema: { type: 'string' }, description: 'Filter by normalized category (ai, data, tools, bitcoin, media, social, earn)' },
          { name: 'minPSuccess', in: 'query', required: false, schema: { type: 'number', minimum: 0, maximum: 1 }, description: 'Minimum posterior p_success (0-1) of the backing Lightning node. Replaces legacy `minScore`; composite axes return 400.' },
          { name: 'minUptime', in: 'query', required: false, schema: { type: 'number', minimum: 0, maximum: 1 }, description: 'Minimum HTTP uptime ratio (0-1). Requires at least 3 health checks.' },
          { name: 'sort', in: 'query', required: false, schema: { type: 'string', enum: ['p_success', 'price', 'uptime'] }, description: 'Sort order (default: most-checked first). `p_success` replaces legacy `score` axis.' },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0, default: 0 } },
        ],
        responses: {
          '200': { description: 'Matching services with SatRank enrichment', content: { 'application/json': { schema: { type: 'object', properties: {
            data: { type: 'array', items: { type: 'object', properties: {
              name: { type: ['string', 'null'] },
              description: { type: ['string', 'null'] },
              category: { type: ['string', 'null'] },
              provider: { type: ['string', 'null'] },
              url: { type: 'string' },
              priceSats: { type: ['integer', 'null'] },
              httpHealth: { type: ['string', 'null'], enum: ['healthy', 'degraded', 'down', null] },
              uptimeRatio: { type: ['number', 'null'] },
              latencyMs: { type: ['integer', 'null'] },
              node: { type: ['object', 'null'], properties: {
                publicKeyHash: { type: 'string' },
                alias: { type: ['string', 'null'] },
                bayesian: { $ref: '#/components/schemas/BayesianScoreBlock' },
              } },
            } } },
            meta: { $ref: '#/components/schemas/PaginationMeta' },
          } } } } },
          '400': { $ref: '#/components/responses/ValidationError' },
        },
      },
    },
    '/services/register': {
      post: {
        summary: 'Self-register an L402 service (NIP-98 gated)',
        operationId: 'registerService',
        description: 'Service operators submit their L402 endpoint URL signed with a Nostr key (NIP-98 Authorization header). SatRank validates the URL by GET-ing it and parsing the WWW-Authenticate header (must return HTTP 402 with a valid BOLT11 invoice). The first signer to claim a URL becomes its operator: subsequent POST/PATCH/DELETE attempts from a different npub return 409. Free, rate-limited (10/min/IP).',
        tags: ['Discovery'],
        security: [{ Nip98: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['url'], properties: {
            url: { type: 'string', format: 'uri', maxLength: 500 },
            name: { type: 'string', maxLength: 100 },
            description: { type: 'string', maxLength: 500 },
            category: { type: 'string', maxLength: 50 },
            provider: { type: 'string', maxLength: 100 },
          } } } },
        },
        responses: {
          '201': { description: 'Service registered, ownership claimed', content: { 'application/json': { schema: { type: 'object', properties: {
            data: { type: 'object', properties: {
              url: { type: 'string' },
              url_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
              registered: { type: 'boolean' },
              agentHash: { type: 'string' },
              priceSats: { type: ['integer', 'null'] },
              fieldsUpdated: { type: 'array', items: { type: 'string' } },
              operator_id: { type: 'string', description: 'npub_hex of the claiming operator' },
              message: { type: 'string' },
            } },
          } } } } },
          '400': { description: 'URL is not a valid L402 endpoint' },
          '401': { description: 'NIP-98 Authorization missing or invalid' },
          '409': { description: 'URL already claimed by a different operator' },
          '503': { description: 'Self-registration unavailable (LND BOLT11 decoder not configured)' },
        },
      },
      patch: {
        summary: 'Update self-registered service metadata (NIP-98, owner-only)',
        operationId: 'updateRegisteredService',
        description: 'Owner of a previously self-registered URL can update its metadata. Requires a NIP-98 Authorization header signed by the same npub that claimed the URL. Fields set to null are cleared; omitted fields are left unchanged.',
        tags: ['Discovery'],
        security: [{ Nip98: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['url'], properties: {
            url: { type: 'string', format: 'uri', maxLength: 500 },
            name: { type: ['string', 'null'], maxLength: 100 },
            description: { type: ['string', 'null'], maxLength: 500 },
            category: { type: ['string', 'null'], maxLength: 50 },
            provider: { type: ['string', 'null'], maxLength: 100 },
          } } } },
        },
        responses: {
          '200': { description: 'Metadata updated' },
          '401': { description: 'NIP-98 Authorization missing or invalid' },
          '403': { description: 'Caller is not the registered owner of this URL' },
          '404': { description: 'No endpoint registered for this URL' },
        },
      },
      delete: {
        summary: 'Soft-delete a self-registered service (NIP-98, owner-only)',
        operationId: 'deleteRegisteredService',
        description: 'Owner can mark their endpoint as deprecated. The row is preserved for forensic purposes but excluded from /api/intent and /api/services. Requires a NIP-98 Authorization header signed by the claiming npub.',
        tags: ['Discovery'],
        security: [{ Nip98: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['url'], properties: {
            url: { type: 'string', format: 'uri', maxLength: 500 },
            reason: { type: 'string', maxLength: 200 },
          } } } },
        },
        responses: {
          '200': { description: 'Endpoint deprecated' },
          '401': { description: 'NIP-98 Authorization missing or invalid' },
          '403': { description: 'Caller is not the registered owner of this URL' },
          '404': { description: 'No endpoint registered for this URL' },
          '409': { description: 'Endpoint already deprecated' },
        },
      },
    },
    '/services/best': {
      get: {
        summary: 'Best provider picks for a category or keyword',
        operationId: 'bestServices',
        description: 'Returns 3 picks for the category/keyword: bestQuality (max score×uptime), bestValue (max score×uptime / sqrt(price)), cheapest (min price among SAFE). Filters to SAFE nodes (score ≥ 47) with positive uptime and price. Free endpoint.',
        tags: ['Discovery'],
        parameters: [
          { name: 'q', in: 'query', required: false, schema: { type: 'string', maxLength: 100 }, description: 'Fulltext keyword (matches name/description/category/provider)' },
          { name: 'category', in: 'query', required: false, schema: { type: 'string' }, description: 'Filter by normalized category' },
        ],
        responses: {
          '200': { description: '3 picks (or null when no SAFE service matches)', content: { 'application/json': { schema: { type: 'object', properties: {
            data: { type: 'object', properties: {
              bestQuality: { type: ['object', 'null'] },
              bestValue: { type: ['object', 'null'] },
              cheapest: { type: ['object', 'null'] },
            } },
            meta: { type: 'object', properties: {
              candidates: { type: 'integer' },
              formula: { type: 'string' },
            } },
          } } } } },
        },
      },
    },
    '/services/categories': {
      get: {
        summary: 'List available service categories',
        operationId: 'getServiceCategories',
        description: 'Returns all normalized categories with service count. Free endpoint.',
        tags: ['Discovery'],
        responses: {
          '200': { description: 'Category list', content: { 'application/json': { schema: { type: 'object', properties: {
            data: { type: 'array', items: { type: 'object', properties: {
              category: { type: 'string' },
              count: { type: 'integer' },
            } } },
          } } } } },
        },
      },
    },
    '/endpoint/{url_hash}': {
      get: {
        summary: 'Bayesian detail for a single HTTP endpoint',
        operationId: 'getEndpointByUrlHash',
        description: 'Returns the canonical Bayesian block for an HTTP endpoint, keyed by the sha256 hex of its canonicalized URL (endpoint_hash). Metadata and HTTP health are included when a matching service_endpoints row is known; they are null otherwise so the Bayesian view works even before discovery has ingested the URL.',
        tags: ['Discovery'],
        parameters: [
          {
            name: 'url_hash',
            in: 'path',
            required: true,
            schema: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            description: 'sha256 hex of the canonicalized URL (endpoint_hash).',
          },
        ],
        responses: {
          '200': {
            description: 'Endpoint Bayesian block + optional metadata',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/EndpointResponse' } } },
          },
          '400': { $ref: '#/components/responses/ValidationError' },
        },
      },
    },
    '/deposit/tiers': {
      get: {
        summary: 'Public deposit pricing schedule',
        operationId: 'getDepositTiers',
        tags: ['Payment'],
        description: 'Returns the live deposit tier table: floor, rate, discount, and the number of requests each tier floor buys. Free endpoint. The rate in effect at deposit time is engraved on the resulting token and never changes; future schedule updates apply only to new deposits.',
        responses: {
          '200': {
            description: 'Tier schedule + unit metadata',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  properties: {
                    tiers: { type: 'array', items: { $ref: '#/components/schemas/DepositTier' } },
                    currency: { type: 'string', example: 'sats' },
                    rateUnit: { type: 'string', example: 'sats per request' },
                    notes: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            } } },
          },
        },
      },
    },
    '/probe': {
      post: {
        summary: 'Probe an L402 endpoint end-to-end via SatRank LND',
        operationId: 'probeEndpoint',
        tags: ['Discovery'],
        security: [{ l402: [] }],
        description: 'SatRank fetches the target URL, parses the L402 challenge, pays the BOLT11 invoice from its own LND node, and retries the request with the preimage. Returns the full telemetry: first fetch, challenge, payment outcome, authenticated retry. Costs 5 credits per call (1 deducted by balanceAuth, 4 deducted in the handler).',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['url'],
            properties: {
              url: { type: 'string', format: 'uri', description: 'http(s) URL of the L402 endpoint to probe.' },
            },
          } } },
        },
        responses: {
          '200': {
            description: 'Probe telemetry',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: { data: { $ref: '#/components/schemas/ProbeResult' } },
            } } },
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '402': { description: 'Insufficient credits (need 5) or L402 auth missing', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          '429': { description: 'Rate limited (per-token and global caps)' },
          '503': { description: 'Probe service unavailable (SatRank admin macaroon not configured)' },
        },
      },
    },
    '/operator/register': {
      post: {
        summary: 'Self-declare an operator with identities and ownerships',
        operationId: 'registerOperator',
        tags: ['Operators'],
        description: 'Self-register an operator, claim identities (ln_pubkey, nip05, dns), and claim ownerships over nodes, endpoints, or services. Requires a valid NIP-98 Authorization header (kind 27235 event signed by a Nostr pubkey, with `u` tag matching the full request URL). Identities are claimed immediately; inline proofs (LN signature, NIP-05 fetch, DNS TXT) are verified live. A proof that fails does not block the claim; the identity is recorded with verified_at=NULL so the claimant can iterate.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['operator_id'],
            properties: {
              operator_id: { type: 'string', minLength: 3, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$', description: 'Opaque operator identifier. Accepts hex sha256 (64 chars) or any free-form id in [A-Za-z0-9._:-].' },
              identities: {
                type: 'array', maxItems: 10,
                items: {
                  type: 'object',
                  required: ['type', 'value'],
                  properties: {
                    type: { type: 'string', enum: ['ln_pubkey', 'nip05', 'dns'] },
                    value: { type: 'string', minLength: 1, maxLength: 256 },
                    signature_hex: { type: 'string', pattern: '^[0-9a-fA-F]+$', minLength: 128, maxLength: 144, description: 'Required for ln_pubkey: ECDSA signature (compact 64-byte = 128 hex) of operator_id by the LN pubkey.' },
                    expected_pubkey: { type: 'string', pattern: '^[0-9a-fA-F]{64}$', description: 'Required for nip05: the Nostr pubkey that /.well-known/nostr.json should map to the identity value.' },
                  },
                },
              },
              ownerships: {
                type: 'array', maxItems: 50,
                items: {
                  type: 'object',
                  required: ['type', 'id'],
                  properties: {
                    type: { type: 'string', enum: ['node', 'endpoint', 'service'] },
                    id: { type: 'string', minLength: 1, maxLength: 256 },
                  },
                },
              },
            },
          } } },
        },
        responses: {
          '201': { description: 'Operator registered (status remains pending until proofs converge)', content: { 'application/json': { schema: {
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  operator_id: { type: 'string' },
                  status: { type: 'string', enum: ['pending', 'verified', 'rejected'] },
                  verification_score: { type: 'number' },
                  verifications: { type: 'array', items: {
                    type: 'object',
                    properties: {
                      type: { type: 'string', enum: ['ln_pubkey', 'nip05', 'dns'] },
                      value: { type: 'string' },
                      valid: { type: 'boolean' },
                      reason: { type: 'string', description: 'Failure detail returned to the claimant (e.g. bad_signature, pubkey_mismatch).' },
                    },
                  } },
                  catalog: { type: 'object', description: 'Full operator catalog snapshot (identities + claimed resources + aggregated bayesian).' },
                  nip98_pubkey: { type: 'string', pattern: '^[0-9a-fA-F]{64}$', description: 'Nostr pubkey that signed the NIP-98 auth event.' },
                },
              },
            },
          } } } },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { description: 'NIP-98 Authorization missing or invalid', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          '429': { description: 'Rate limited (discoveryRateLimit)' },
        },
      },
    },
    '/operators': {
      get: {
        summary: 'List operators (paginated, filterable by status)',
        operationId: 'listOperators',
        tags: ['Operators'],
        description: 'Returns a paginated list of operators with their verification status and activity timestamps. No per-operator bayesian aggregate (too expensive in list mode); use GET /api/operator/{id} for the full catalog and posterior.',
        parameters: [
          { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['verified', 'pending', 'rejected'] } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0, default: 0 } },
        ],
        responses: {
          '200': { description: 'Operator list with status counts', content: { 'application/json': { schema: {
            type: 'object',
            properties: {
              data: { type: 'array', items: {
                type: 'object',
                properties: {
                  operator_id: { type: 'string' },
                  status: { type: 'string', enum: ['verified', 'pending', 'rejected'] },
                  verification_score: { type: 'number' },
                  first_seen: { type: 'integer' },
                  last_activity: { type: 'integer' },
                  created_at: { type: 'integer' },
                },
              } },
              meta: { type: 'object', properties: {
                total: { type: 'integer' },
                limit: { type: 'integer' },
                offset: { type: 'integer' },
                counts: { type: 'object', properties: {
                  verified: { type: 'integer' },
                  pending: { type: 'integer' },
                  rejected: { type: 'integer' },
                } },
              } },
            },
          } } } },
          '400': { $ref: '#/components/responses/ValidationError' },
          '503': { description: 'Operator listing not wired (operator repository not provided)' },
        },
      },
    },
    '/operator/{id}': {
      get: {
        summary: 'Get operator detail (catalog + bayesian aggregate)',
        operationId: 'getOperator',
        tags: ['Operators'],
        description: 'Returns the full operator catalog: identities with their verification state, all claimed resources (nodes, endpoints, services) enriched with metadata, and the aggregated Bayesian posterior across every resource with evidence beyond the prior.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', minLength: 3, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' } },
        ],
        responses: {
          '200': { description: 'Operator catalog', content: { 'application/json': { schema: {
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  operator: { type: 'object', properties: {
                    operator_id: { type: 'string' },
                    status: { type: 'string', enum: ['verified', 'pending', 'rejected'] },
                    verification_score: { type: 'number' },
                    first_seen: { type: 'integer' },
                    last_activity: { type: 'integer' },
                    created_at: { type: 'integer' },
                  } },
                  identities: { type: 'array', items: {
                    type: 'object',
                    properties: {
                      type: { type: 'string', enum: ['ln_pubkey', 'nip05', 'dns'] },
                      value: { type: 'string' },
                      verified_at: { type: ['integer', 'null'] },
                      verification_proof: { type: ['string', 'null'] },
                    },
                  } },
                  catalog: { type: 'object', description: 'Enriched claims: nodes (pubkey + alias + avg_score), endpoints (url_hash + url + name + category + price_sats), services (service_hash). Every claim is listed, even without observations.' },
                  bayesian: { type: 'object', properties: {
                    posterior_alpha: { type: 'number' },
                    posterior_beta: { type: 'number' },
                    p_success: { type: ['number', 'null'], minimum: 0, maximum: 1 },
                    n_obs_effective: { type: 'number', description: 'Evidence mass beyond the prior, summed across all resources that contribute.' },
                    resources_counted: { type: 'integer', description: 'Number of claimed resources with evidence beyond the prior. Subset of catalog.*.length.' },
                    at_ts: { type: 'integer' },
                  } },
                },
              },
              meta: { type: 'object', properties: { computedAt: { type: 'integer' } } },
            },
          } } } },
          '400': { $ref: '#/components/responses/ValidationError' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/openapi.json': {
      get: {
        summary: 'OpenAPI specification',
        operationId: 'getOpenApiSpec',
        tags: ['System'],
        responses: {
          '200': { description: 'This document' },
        },
      },
    },
    // Phase 6.4 + 6.3 + 7.1 — federation + transparency endpoints (free, public).
    '/oracle/budget': {
      get: {
        summary: 'Self-funding loop snapshot',
        operationId: 'getOracleBudget',
        description: 'Phase 6.4 — public observability of the oracle\'s economic supportability. Returns lifetime + 30-day + 7-day snapshots of revenue (paid L402 calls) vs spending (paid probes), with `coverage_ratio = revenue / spending`. The intent is transparency : agents and auditors can verify the oracle is sustainably financed without trusting a self-claim. Free, rate-limited via discoveryRateLimit (10 req/min/IP).',
        tags: ['Oracle'],
        responses: {
          '200': {
            description: 'Multi-window budget snapshot',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        lifetime: { $ref: '#/components/schemas/BudgetSnapshot' },
                        last_30d: { $ref: '#/components/schemas/BudgetSnapshot' },
                        last_7d: { $ref: '#/components/schemas/BudgetSnapshot' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/oracle/peers': {
      get: {
        summary: 'List discovered SatRank-compatible oracles',
        operationId: 'getOraclePeers',
        description: 'Phase 7.1 — federation discovery. Subscribes permanently to kind 30784 announcements on Nostr relays and returns the local snapshot of all oracles seen. Each peer entry carries oracle_pubkey, lnd_pubkey, catalogue_size, latest calibration_event_id pointer, last_seen, age_sec. Trust filtering is client-side (sovereign) — the agent picks its own thresholds.',
        tags: ['Oracle'],
        parameters: [
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        ],
        responses: {
          '200': {
            description: 'Peer list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        peers: { type: 'array', items: { $ref: '#/components/schemas/OraclePeer' } },
                        count: { type: 'integer' },
                        limit: { type: 'integer' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/oracle/peers/{pubkey}/calibrations': {
      get: {
        summary: 'Calibration history of a specific peer',
        operationId: 'getOraclePeerCalibrations',
        description: 'Phase 9.1 — cross-oracle meta-confidence. Returns the kind 30783 calibration events ingested for a given peer, freshest first. Lets a client compare the peer\'s self-published delta_mean against historical observations from other oracles before trusting the peer for aggregation.',
        tags: ['Oracle'],
        parameters: [
          {
            name: 'pubkey',
            in: 'path',
            required: true,
            schema: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            description: 'Peer oracle Schnorr pubkey (32 bytes hex)',
          },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        ],
        responses: {
          '200': {
            description: 'Calibration history',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        peer_pubkey: { type: 'string' },
                        calibrations: { type: 'array', items: { $ref: '#/components/schemas/PeerCalibration' } },
                        count: { type: 'integer' },
                        limit: { type: 'integer' },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': { description: 'Invalid pubkey format' },
        },
      },
    },
    '/oracle/assertion/{url_hash}': {
      get: {
        summary: 'Trust assertion metadata for an endpoint',
        operationId: 'getOracleAssertion',
        description: 'Phase 6.3 — returns the metadata of the latest kind 30782 trust assertion published by this oracle for a given endpoint, plus a BOLT12 TLV embedding hint. Lets operators retrieve the (event_id, oracle_pubkey, valid_until) needed to embed the trust signal directly in their BOLT12 offers — agents reading the offer get the trust signal without round-tripping to SatRank.',
        tags: ['Oracle'],
        parameters: [
          {
            name: 'url_hash',
            in: 'path',
            required: true,
            schema: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            description: 'sha256 of the canonical endpoint URL (64 hex chars)',
          },
        ],
        responses: {
          '200': {
            description: 'Assertion metadata + BOLT12 TLV hint',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { $ref: '#/components/schemas/TrustAssertionMetadata' },
                  },
                },
              },
            },
          },
          '400': { description: 'Invalid url_hash format' },
          '404': { description: 'No trust assertion published yet for this endpoint' },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      l402: {
        type: 'http',
        scheme: 'L402',
        description: 'L402 Lightning payment authentication. Base rate is 1 sat per request (tier 1). Two token options: (1) Fresh macaroon: send a request without credentials to receive HTTP 402 with a Lightning invoice. Pay and include: Authorization: L402 <macaroon>:<preimage>. (2) Deposit: POST /api/deposit with { amount: N } (21 to 1,000,000 sats), pay the invoice, verify, and use: Authorization: L402 deposit:<preimage>. Deposit tokens are priced at the tier rate burnt in at deposit time (see GET /api/deposit/tiers). Both token types work on all paid endpoints. X-SatRank-Balance header tracks remaining requests.',
      },
      Nip98: {
        type: 'http',
        scheme: 'Nostr',
        description: 'NIP-98 HTTP authentication (https://github.com/nostr-protocol/nips/blob/master/98.md). Send Authorization: Nostr <base64-event> where the base64-encoded JSON is a kind 27235 Nostr event with tags [["u","<absolute-url>"], ["method","<HTTP-METHOD>"], ["payload","<sha256-hex-of-body>"]]. The event must be signed by the operator npub and timestamped within the last 60 seconds. SatRank verifies the signature, URL, method, payload-binding, and freshness before accepting the request. Used to gate self-registration endpoints so only the npub that claimed an endpoint can update or delete it.',
      },
    },
    parameters: {
      publicKeyHash: {
        name: 'publicKeyHash',
        in: 'path',
        required: true,
        schema: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        description: 'SHA-256 hex hash of the agent public key',
      },
      limit: {
        name: 'limit',
        in: 'query',
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      offset: {
        name: 'offset',
        in: 'query',
        schema: { type: 'integer', minimum: 0, default: 0 },
      },
    },
    schemas: {
      // Phase 6.4 — self-funding loop
      BudgetSnapshot: {
        type: 'object',
        required: ['window_sec', 'revenue_sats', 'spending_sats', 'balance_sats', 'coverage_ratio', 'n_revenue_events', 'n_spending_events'],
        properties: {
          window_sec: { type: 'integer', nullable: true, description: 'Window in seconds. null = lifetime.' },
          revenue_sats: { type: 'integer', description: 'Total sats logged on the revenue side (paid L402 calls).' },
          spending_sats: { type: 'integer', description: 'Total sats logged on the spending side (paid probes).' },
          balance_sats: { type: 'integer', description: 'revenue - spending. Negative = subsidized.' },
          coverage_ratio: { type: 'number', nullable: true, description: 'revenue / spending. null when spending = 0.' },
          n_revenue_events: { type: 'integer' },
          n_spending_events: { type: 'integer' },
        },
      },
      // Phase 7.1 — federation peer
      OraclePeer: {
        type: 'object',
        required: ['oracle_pubkey', 'catalogue_size', 'last_seen', 'first_seen', 'age_sec', 'stale_sec'],
        properties: {
          oracle_pubkey: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          lnd_pubkey: { type: 'string', nullable: true, description: 'Sovereign LN identity if announced.' },
          catalogue_size: { type: 'integer', description: 'Active trusted endpoints announced by the peer.' },
          calibration_event_id: { type: 'string', nullable: true, description: 'Pointer to the latest kind 30783 calibration of this peer.' },
          last_assertion_event_id: { type: 'string', nullable: true },
          contact: { type: 'string', nullable: true },
          onboarding_url: { type: 'string', nullable: true, description: 'https-only validated.' },
          last_seen: { type: 'integer', description: 'Unix seconds of last announcement received.' },
          first_seen: { type: 'integer', description: 'Unix seconds of first observation. Useful for Sybil-resistance.' },
          age_sec: { type: 'integer' },
          stale_sec: { type: 'integer', description: 'now - last_seen. Filter ≥ 7d for stale peers.' },
          latest_announcement_event_id: { type: 'string', nullable: true },
        },
      },
      // Phase 9.1 — cross-oracle calibration observation
      PeerCalibration: {
        type: 'object',
        required: ['event_id', 'window_start', 'window_end', 'window_days', 'n_endpoints', 'n_outcomes', 'observed_at'],
        properties: {
          event_id: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          window_start: { type: 'integer' },
          window_end: { type: 'integer' },
          window_days: { type: 'integer' },
          delta_mean: { type: 'number', nullable: true },
          delta_median: { type: 'number', nullable: true },
          delta_p95: { type: 'number', nullable: true },
          n_endpoints: { type: 'integer' },
          n_outcomes: { type: 'integer' },
          observed_at: { type: 'integer' },
        },
      },
      // Phase 6.3 — trust assertion metadata + BOLT12 TLV hint
      TrustAssertionMetadata: {
        type: 'object',
        required: ['endpoint_url_hash', 'kind', 'event_id', 'oracle_pubkey', 'valid_until', 'expires_in_sec', 'expired', 'meaningful_stages_count', 'published_at', 'relays', 'bolt12_tlv_hint'],
        properties: {
          endpoint_url_hash: { type: 'string' },
          kind: { type: 'integer', enum: [30782] },
          event_id: { type: 'string', description: 'Nostr event id (32 bytes hex).' },
          oracle_pubkey: { type: 'string' },
          valid_until: { type: 'integer' },
          expires_in_sec: { type: 'integer' },
          expired: { type: 'boolean' },
          p_e2e: { type: 'number', nullable: true },
          meaningful_stages_count: { type: 'integer' },
          calibration_proof_event_id: { type: 'string', nullable: true, description: 'Pointer to the kind 30783 calibration that backs this assertion.' },
          published_at: { type: 'integer' },
          relays: { type: 'array', items: { type: 'string' } },
          bolt12_tlv_hint: {
            type: 'object',
            properties: {
              type_event_id: { type: 'integer', enum: [65537] },
              type_oracle_pubkey: { type: 'integer', enum: [65538] },
              event_id_hex: { type: 'string' },
              oracle_pubkey_hex: { type: 'string' },
            },
          },
        },
      },
      // Phase 5.14 — 5-stage L402 contract decomposition
      StagePosteriorEntry: {
        type: 'object',
        required: ['stage', 'alpha', 'beta', 'p_success', 'ci95_low', 'ci95_high', 'n_obs', 'is_meaningful'],
        properties: {
          stage: { type: 'string', enum: ['challenge', 'invoice', 'payment', 'delivery', 'quality'] },
          alpha: { type: 'number' },
          beta: { type: 'number' },
          p_success: { type: 'number', minimum: 0, maximum: 1 },
          ci95_low: { type: 'number', minimum: 0, maximum: 1 },
          ci95_high: { type: 'number', minimum: 0, maximum: 1 },
          n_obs: { type: 'number' },
          is_meaningful: { type: 'boolean', description: 'true when n_obs effective ≥ 3 (the stage contributed to p_e2e).' },
        },
      },
      StagePosteriorsBlock: {
        type: 'object',
        required: ['stages', 'meaningful_stages', 'measured_stages'],
        properties: {
          stages: {
            type: 'object',
            additionalProperties: { $ref: '#/components/schemas/StagePosteriorEntry' },
            description: 'Map keyed by stage name (challenge / invoice / payment / delivery / quality). Stages absent from the map are not yet measured for this endpoint.',
          },
          p_e2e: { type: 'number', nullable: true, description: 'Chain-rule product of meaningful stages\' p_success. null when no stage is meaningful.' },
          p_e2e_pessimistic: { type: 'number', nullable: true, description: 'Product of CI95_low. Pessimistic bound (not a strict CI95 of the product).' },
          p_e2e_optimistic: { type: 'number', nullable: true, description: 'Product of CI95_high. Optimistic bound.' },
          meaningful_stages: { type: 'array', items: { type: 'string' } },
          measured_stages: { type: 'integer', minimum: 0, maximum: 5 },
        },
      },
      BayesianSourceBlock: {
        oneOf: [
          { type: 'null' },
          {
            type: 'object',
            required: ['p_success', 'ci95_low', 'ci95_high', 'n_obs', 'weight_total'],
            properties: {
              p_success: { type: 'number', minimum: 0, maximum: 1 },
              ci95_low:  { type: 'number', minimum: 0, maximum: 1 },
              ci95_high: { type: 'number', minimum: 0, maximum: 1 },
              n_obs: { type: 'number', description: 'Number of raw observations (weighted sum of successes + failures).' },
              weight_total: { type: 'number', description: 'Sum of per-observation weights (source_weight × temporal_decay).' },
            },
          },
        ],
      },
      BayesianConvergence: {
        type: 'object',
        required: ['converged', 'sources_above_threshold', 'threshold'],
        properties: {
          converged: { type: 'boolean', description: 'True when ≥2 sources exceed p_success threshold (SAFE-eligible condition).' },
          sources_above_threshold: {
            type: 'array',
            items: { type: 'string', enum: ['probe', 'report', 'paid'] },
            description: 'Sources whose marginal posterior p_success ≥ threshold.',
          },
          threshold: { type: 'number', minimum: 0, maximum: 1, description: 'Per-source p_success threshold (default 0.80).' },
        },
      },
      BayesianScoreBlock: {
        type: 'object',
        description: 'Canonical Bayesian posterior block shared across all public endpoints (verdict, intent, profile, service, endpoint). Streaming exponential decay with time constant τ=7 days. The legacy `window` field was removed and replaced by `time_constant_days`, `recent_activity`, `risk_profile`, and `last_update`. As of OpenAPI 1.3.0 / SDK 1.0.5 the additive `is_meaningful` flag indicates whether the posterior aggregates enough recent evidence to drive a decision (true) or is mostly the prior shining through (false).',
        required: ['p_success', 'ci95_low', 'ci95_high', 'n_obs', 'verdict', 'time_constant_days', 'last_update', 'sources', 'convergence', 'recent_activity', 'risk_profile', 'is_meaningful'],
        properties: {
          p_success: { type: 'number', minimum: 0, maximum: 1, description: 'Beta-Binomial posterior mean (streaming, decay τ=7 days).' },
          ci95_low:  { type: 'number', minimum: 0, maximum: 1, description: 'Lower bound of the 95% credible interval.' },
          ci95_high: { type: 'number', minimum: 0, maximum: 1, description: 'Upper bound of the 95% credible interval.' },
          n_obs: { type: 'number', description: 'Effective observations (excess evidence beyond the prior), summed with τ=7d decay across the three sources.' },
          verdict: { type: 'string', enum: ['SAFE', 'UNKNOWN', 'RISKY', 'INSUFFICIENT'], description: 'Priority: INSUFFICIENT > RISKY > UNKNOWN > SAFE.' },
          time_constant_days: { type: 'number', description: 'Exposed time constant τ (exponential decay, days). Currently 7.' },
          last_update: { type: 'number', description: 'Unix seconds of the most recent ingestion, taken as the max over the three sources. 0 when no observation has been recorded.' },
          is_meaningful: { type: 'boolean', description: 'Vague 1 B (OpenAPI 1.3.0). True when the score aggregates enough recent evidence to drive a decision; false when the response is mostly the prior shining through (stale probe and/or thin data). On the /api/intent surface the threshold is freshness_status in {fresh, recent} AND n_obs >= 5. On detail surfaces (/agent/:hash, /verdict, /decide) the field defaults to true so the raw posterior is always exposed; clients filtering for high-confidence picks should rely on /api/intent or pay ?fresh=true.' },
          sources: {
            type: 'object',
            required: ['probe', 'report', 'paid'],
            properties: {
              probe:  { $ref: '#/components/schemas/BayesianSourceBlock' },
              report: { $ref: '#/components/schemas/BayesianSourceBlock' },
              paid:   { $ref: '#/components/schemas/BayesianSourceBlock' },
            },
          },
          convergence: { $ref: '#/components/schemas/BayesianConvergence' },
          recent_activity: {
            type: 'object',
            required: ['last_24h', 'last_7d', 'last_30d'],
            description: 'Cumulative n_obs over 24h/7d/30d windows (daily_buckets, all sources). Display only, independent of the verdict.',
            properties: {
              last_24h: { type: 'integer', minimum: 0 },
              last_7d:  { type: 'integer', minimum: 0 },
              last_30d: { type: 'integer', minimum: 0 },
            },
          },
          risk_profile: { type: 'string', enum: ['low', 'medium', 'high', 'unknown'], description: 'Trend delta: success_rate over the last 7 days vs the preceding 23 days.' },
        },
      },
      PaginationMeta: {
        type: 'object',
        properties: {
          total: { type: 'integer' },
          limit: { type: 'integer' },
          offset: { type: 'integer' },
        },
        required: ['total', 'limit', 'offset'],
      },
      ErrorResponse: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              details: {
                type: 'object',
                description: 'Optional structured context. For NOT_FOUND, includes `resource` naming the missing entity (e.g. "Agent (reporter)", "Transaction").',
                additionalProperties: { type: 'string' },
              },
            },
            required: ['code', 'message'],
          },
          requestId: { type: 'string' },
        },
      },
      AgentScoreResponse: {
        type: 'object',
        description: 'Agent profile: identity, stats, evidence overlay, and canonical Bayesian block. No composite score surface; `bayesian` is the source of truth.',
        required: ['agent', 'bayesian', 'stats', 'evidence', 'alerts'],
        properties: {
          agent: {
            type: 'object',
            properties: {
              publicKeyHash: { type: 'string' },
              alias: { type: ['string', 'null'] },
              firstSeen: { type: 'integer' },
              lastSeen: { type: 'integer' },
              source: { type: 'string', enum: ['attestation', '4tress', 'lightning_graph', 'manual'] },
            },
          },
          bayesian: { $ref: '#/components/schemas/BayesianScoreBlock' },
          stats: {
            type: 'object',
            properties: {
              totalTransactions: { type: 'integer' },
              verifiedTransactions: { type: 'integer' },
              uniqueCounterparties: { type: 'integer' },
              attestationsReceived: { type: 'integer' },
              avgAttestationScore: { type: 'number' },
            },
          },
          evidence: { $ref: '#/components/schemas/ScoreEvidence' },
          alerts: { type: 'array', items: { $ref: '#/components/schemas/AgentAlert' } },
        },
      },
      TransactionSample: {
        type: 'object',
        properties: {
          txId: { type: 'string', format: 'uuid' },
          protocol: { type: 'string', enum: ['l402', 'keysend', 'bolt11'] },
          amountBucket: { type: 'string', enum: ['micro', 'small', 'medium', 'large'] },
          verified: { type: 'boolean' },
          timestamp: { type: 'integer' },
        },
      },
      ScoreEvidence: {
        type: 'object',
        description: "Don't trust, verify. All data sources used to compute the score, with links to verify independently.",
        properties: {
          transactions: {
            type: 'object',
            properties: {
              count: { type: 'integer', description: 'Total transactions involving this agent' },
              verifiedCount: { type: 'integer', description: 'Verified transactions count' },
              sample: { type: 'array', items: { $ref: '#/components/schemas/TransactionSample' }, description: '5 most recent transactions' },
            },
          },
          lightningGraph: {
            oneOf: [
              {
                type: 'object',
                properties: {
                  publicKey: { type: 'string', description: 'Original Lightning node public key' },
                  channels: { type: 'integer' },
                  capacitySats: { type: 'integer' },
                  sourceUrl: { type: 'string', format: 'uri', description: 'Verify on mempool.space' },
                },
              },
              { type: 'null' },
            ],
            description: 'Lightning Network graph data. Null for non-Lightning agents.',
          },
          reputation: {
            oneOf: [
              {
                type: 'object',
                description: 'Sovereign PageRank signal computed on the SatRank peer-trust graph, supplemented by legacy external signals where available.',
                properties: {
                  pageRank: { type: ['number', 'null'], description: 'Sovereign PageRank on the SatRank peer-trust graph (0-1). Primary reputation signal since v19.' },
                  positiveRatings: { type: 'integer', description: 'Legacy count. Kept for backward compatibility. Not weighted in the current score.' },
                  negativeRatings: { type: 'integer', description: 'Legacy count. Kept for backward compatibility. Not weighted in the current score.' },
                },
              },
              { type: 'null' },
            ],
            description: 'Sovereign reputation signals. Null if none exist.',
          },
          popularity: {
            type: 'object',
            properties: {
              queryCount: { type: 'integer', description: 'Number of times this agent has been queried via the API' },
              bonusApplied: { type: 'integer', minimum: 0, maximum: 10, description: 'Score bonus from popularity (0-10)' },
            },
          },
          probe: {
            oneOf: [
              {
                type: 'object',
                description: 'Route probe data (proprietary reachability test from our Lightning node).',
                properties: {
                  reachable: { type: 'boolean', description: 'Whether a route exists to this node' },
                  latencyMs: { type: ['integer', 'null'], description: 'Route query response time in ms' },
                  hops: { type: ['integer', 'null'], description: 'Number of hops in the best route' },
                  estimatedFeeMsat: { type: ['integer', 'null'], description: 'Estimated routing fee in millisatoshis' },
                  failureReason: { type: ['string', 'null'], description: 'Reason for route failure if unreachable' },
                  probedAt: { type: 'integer', description: 'Unix timestamp of the probe' },
                },
              },
              { type: 'null' },
            ],
            description: 'Route probe reachability data. Null if not yet probed.',
          },
        },
      },
      AgentAlert: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['score_drop', 'score_surge', 'new_agent', 'inactive'] },
          message: { type: 'string' },
          severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
        },
      },
      AgentSummary: {
        type: 'object',
        description: 'Leaderboard row: identity plus canonical Bayesian block.',
        required: ['publicKeyHash', 'alias', 'rank', 'totalTransactions', 'source', 'bayesian'],
        properties: {
          publicKeyHash: { type: 'string' },
          alias: { type: ['string', 'null'] },
          rank: { type: ['integer', 'null'] },
          totalTransactions: { type: 'integer' },
          source: { type: 'string' },
          bayesian: { $ref: '#/components/schemas/BayesianScoreBlock' },
        },
      },
      AgentSearchResult: {
        type: 'object',
        description: 'Search result: identity plus canonical Bayesian block.',
        required: ['publicKeyHash', 'alias', 'rank', 'totalTransactions', 'source', 'bayesian'],
        properties: {
          publicKeyHash: { type: 'string' },
          alias: { type: ['string', 'null'] },
          rank: { type: ['integer', 'null'] },
          totalTransactions: { type: 'integer' },
          source: { type: 'string' },
          bayesian: { $ref: '#/components/schemas/BayesianScoreBlock' },
        },
      },
      Attestation: {
        type: 'object',
        properties: {
          attestationId: { type: 'string', format: 'uuid' },
          txId: { type: 'string', format: 'uuid' },
          attesterHash: { type: 'string' },
          score: { type: 'integer', minimum: 0, maximum: 100 },
          tags: { type: 'array', items: { type: 'string' } },
          evidenceHash: { type: ['string', 'null'] },
          timestamp: { type: 'integer' },
          category: { type: 'string', enum: ['successful_transaction', 'failed_transaction', 'dispute', 'fraud', 'unresponsive', 'general'] },
        },
      },
      CreateAttestationInput: {
        type: 'object',
        required: ['txId', 'attesterHash', 'subjectHash', 'score'],
        properties: {
          txId: { type: 'string', format: 'uuid' },
          attesterHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          subjectHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          score: { type: 'integer', minimum: 0, maximum: 100 },
          tags: { type: 'array', items: { type: 'string', maxLength: 50 }, maxItems: 10 },
          evidenceHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          category: {
            type: 'string',
            enum: ['successful_transaction', 'failed_transaction', 'dispute', 'fraud', 'unresponsive', 'general'],
            default: 'general',
            description: 'Attestation category. Use "fraud" or "dispute" to report negative interactions.',
          },
        },
      },
      VerdictResponse: {
        type: 'object',
        description: 'Binary trust decision for agent-to-agent evaluation. Designed for < 200ms decision loops.',
        properties: {
          verdict: { type: 'string', enum: ['SAFE', 'RISKY', 'UNKNOWN'], description: 'Trust verdict' },
          confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Confidence level (0-1)' },
          reason: { type: 'string', description: 'Human-readable summary of the verdict rationale' },
          flags: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['new_agent', 'low_volume', 'rapid_decline', 'rapid_rise', 'negative_reputation', 'high_demand', 'no_reputation_data', 'fraud_reported', 'dispute_reported', 'unreachable', 'unreachable_from_caller', 'stale_gossip', 'zombie_gossip', 'capacity_drain', 'severe_capacity_drain'],
            },
            description: 'Active flags that influenced the verdict',
          },
          personalTrust: {
            oneOf: [{ $ref: '#/components/schemas/PersonalTrust' }, { type: 'null' }],
            description: 'Personalized trust distance from caller to target. Null if caller_pubkey not provided.',
          },
          riskProfile: { $ref: '#/components/schemas/RiskProfile' },
          pathfinding: {
            oneOf: [{ $ref: '#/components/schemas/PathfindingResult' }, { type: 'null' }],
            description: 'Personalized pathfinding from caller to target. Null if caller_pubkey not provided, or if either node lacks a Lightning pubkey.',
          },
        },
        required: ['verdict', 'confidence', 'reason', 'flags', 'personalTrust', 'riskProfile', 'pathfinding'],
      },
      PersonalTrust: {
        type: 'object',
        description: 'Trust distance from the calling agent to the target, computed from the attestation graph.',
        properties: {
          distance: {
            type: ['integer', 'null'],
            minimum: 0,
            maximum: 2,
            description: '0 = direct attestation, 1 = friend-of-friend, 2 = two degrees, null = no connection',
          },
          sharedConnections: { type: 'integer', minimum: 0, description: 'Number of shared trusted agents in the path' },
          strongestConnection: {
            type: ['string', 'null'],
            description: 'Alias of the strongest shared connection, or null if none',
          },
        },
        required: ['distance', 'sharedConnections', 'strongestConnection'],
      },
      PathfindingResult: {
        type: 'object',
        description: 'Real-time personalized route query from the calling agent to the target, via LND QueryRoutes with source_pub_key. Proprietary data; no free alternative provides personalized pathfinding as a service.',
        properties: {
          reachable: { type: 'boolean', description: 'Whether a route exists from the caller to this target' },
          hops: { type: ['integer', 'null'], description: 'Number of hops in the best route from the caller' },
          estimatedFeeMsat: { type: ['integer', 'null'], description: 'Estimated total routing fee in millisatoshis from the caller' },
          alternatives: { type: 'integer', description: 'Number of alternative routes found' },
          latencyMs: { type: 'integer', description: 'Route query computation time in ms' },
          source: { type: 'string', enum: ['lnd_queryroutes'], description: 'Pathfinding engine used' },
          sourceNode: { type: 'string', description: 'Raw pubkey of the node used as pathfinding origin, or "satrank" when using the default position.' },
          sourceProvider: {
            type: 'string',
            enum: ['phoenix', 'wos', 'strike', 'blink', 'breez', 'zeus', 'coinos', 'cashapp'],
            description: 'Wallet provider label when walletProvider= was supplied. Absent when callerNodePubkey= is used or when no override was set.',
          },
        },
        required: ['reachable', 'hops', 'estimatedFeeMsat', 'alternatives', 'latencyMs', 'source'],
      },
      RiskProfile: {
        type: 'object',
        description: 'Behavioral risk classification based on observable properties.',
        properties: {
          name: {
            type: 'string',
            enum: ['established_hub', 'growing_node', 'declining_node', 'new_unproven', 'small_reliable', 'suspicious_rapid_rise', 'unrated'],
          },
          riskLevel: { type: 'string', enum: ['low', 'medium', 'high', 'unknown'] },
          description: { type: 'string', description: 'Human-readable explanation of the profile classification' },
        },
        required: ['name', 'riskLevel', 'description'],
      },
      HealthResponse: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'error'] },
          agentsIndexed: { type: 'integer', description: 'Active agents (not seen in the graph within 90 days are excluded)' },
          staleAgents: { type: 'integer', description: 'Fossil agents (not seen in 90+ days, kept for history but excluded from stats).' },
          totalTransactions: { type: 'integer' },
          lastUpdate: { type: 'integer' },
          uptime: { type: 'integer', description: 'Seconds since process start' },
          schemaVersion: { type: 'integer', description: 'Applied DB schema version' },
          expectedSchemaVersion: { type: 'integer', description: 'Expected DB schema version' },
          dbStatus: { type: 'string', enum: ['ok', 'error'] },
        },
      },
      NetworkStats: {
        type: 'object',
        properties: {
          totalAgents: { type: 'integer', description: 'Active Lightning agents indexed across all sources (stale >90d excluded)' },
          totalEndpoints: { type: 'integer', description: 'Total registered endpoints (agents + service_endpoints)' },
          nodesProbed: { type: 'integer', description: 'Nodes probed at least once via LND QueryRoutes (used as the denominator for phantomRate)' },
          phantomRate: { type: 'number', description: 'Percentage of probed nodes that are unreachable in routing (0 to 100). Computed live from the last 24h probe window.' },
          verifiedReachable: { type: 'integer', description: 'Nodes with at least one successful probe in the last 24h, i.e. "who you can actually pay".' },
          probes24h: { type: 'integer', description: 'Total QueryRoutes probes executed in the last 24h rolling window (all amount tiers combined)' },
          totalChannels: { type: 'integer', description: 'Sum of Lightning channels across all lightning_graph agents' },
          nodesWithRatings: { type: 'integer', description: 'Number of agents with non-zero sovereign reputation (PageRank > 0 on the SatRank peer-trust graph).' },
          networkCapacityBtc: { type: 'number', description: 'Total network capacity in BTC (sum of all validated channel capacities)' },
          totalVolumeBuckets: {
            type: 'object',
            properties: {
              micro: { type: 'integer' },
              small: { type: 'integer' },
              medium: { type: 'integer' },
              large: { type: 'integer' },
            },
          },
          serviceSources: {
            type: 'object',
            description: 'Breakdown of service_endpoints by discovery source. Exposes SatRank\'s sovereign oracle coverage of the L402 paid-service landscape.',
            properties: {
              '402index': { type: 'integer', description: 'Endpoints auto-discovered from 402index.io' },
              self_registered: { type: 'integer', description: 'Endpoints declared by operators via /api/declare-provider' },
              ad_hoc: { type: 'integer', description: 'Endpoints observed on-the-fly via legacy serviceUrl checks (historical, no new entries since Phase 10)' },
            },
          },
        },
      },
      ReportStatsResponse: {
        type: 'object',
        description: '30-day report-adoption dashboard. `bonus.*` is gated behind X-API-Key.',
        properties: {
          window: {
            type: 'object',
            properties: {
              sinceDays: { type: 'integer', description: 'Rolling window length (always 30)' },
              generatedAt: { type: 'integer', description: 'Unix epoch seconds when the cache was computed' },
            },
          },
          summary: {
            type: 'object',
            properties: {
              totalSubmitted: { type: 'integer', description: 'Reports submitted in the window' },
              totalVerified: { type: 'integer', description: 'Reports with verified=1 (payment hash matched an on-chain/LN payment)' },
              distinctReporters: { type: 'integer', description: 'Unique reporter npubs / keys in the window' },
              targetN: { type: 'integer', description: 'Target report count (200 by default).' },
              progressPct: { type: 'number', minimum: 0, maximum: 100, description: 'totalSubmitted / targetN, capped at 100, 1-decimal precision' },
            },
          },
          weekly: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                weekStart: { type: 'string', description: 'YYYY-MM-DD of the earliest report in the week (UTC)' },
                submitted: { type: 'integer' },
                verified: { type: 'integer' },
                distinctReporters: { type: 'integer' },
              },
            },
          },
          bonus: {
            type: 'object',
            description: 'Tier-2 economic-incentive payout counters. Only returned when X-API-Key is valid.',
            properties: {
              enabled: { type: 'boolean', description: 'Whether REPORT_BONUS_ENABLED env flag is on' },
              totalBonusesGranted: { type: 'integer' },
              totalSatsPaid: { type: 'integer' },
              distinctRecipients: { type: 'integer' },
            },
          },
        },
      },
      VersionResponse: {
        type: 'object',
        properties: {
          commit: { type: 'string' },
          buildDate: { type: 'string' },
          version: { type: 'string' },
        },
      },
      DepositTier: {
        type: 'object',
        required: ['tierId', 'minDepositSats', 'rateSatsPerRequest', 'discountPct', 'requestsPerDeposit'],
        properties: {
          tierId: { type: 'integer', description: 'Tier index (1 is the base tier, 5 is the deepest discount).' },
          minDepositSats: { type: 'integer', description: 'Lowest deposit amount that maps to this tier.' },
          rateSatsPerRequest: { type: 'number', description: 'Cost in sats charged per paid request for deposits at this tier.' },
          discountPct: { type: 'number', minimum: 0, maximum: 100, description: 'Discount vs the base tier-1 rate (0 at tier 1, up to 95 at tier 5).' },
          requestsPerDeposit: { type: 'number', description: 'How many requests a deposit exactly at this floor buys (minDepositSats / rateSatsPerRequest).' },
        },
      },
      DepositVerifiedResponse: {
        type: 'object',
        required: ['balance', 'balanceCredits', 'rateSatsPerRequest', 'tierId', 'paymentHash', 'instructions'],
        properties: {
          balance: { type: 'integer', description: 'Remaining sats on the token (matches token_balance.remaining).' },
          balanceCredits: { type: 'integer', description: 'Remaining request credits on the token (balance / rateSatsPerRequest).' },
          rateSatsPerRequest: { type: 'number', description: 'Rate engraved at deposit time. Immutable for the lifetime of the token.' },
          tierId: { type: 'integer', description: 'Tier id whose rate is engraved on this token.' },
          discountPct: { type: 'number', minimum: 0, maximum: 100, description: 'Discount engraved at deposit time (returned on fresh credits, omitted on alreadyRedeemed replays).' },
          paymentHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          alreadyRedeemed: { type: 'boolean', description: 'True when the verify call was a replay of an already-credited deposit.' },
          token: { type: 'string', description: 'Full Authorization header value to reuse on paid endpoints (format: L402 deposit:<preimage>).' },
          instructions: { type: 'string' },
        },
      },
      DepositInvoiceResponse: {
        type: 'object',
        required: ['invoice', 'paymentHash', 'amount', 'quotaGranted', 'tierId', 'rateSatsPerRequest', 'discountPct', 'expiresIn', 'instructions'],
        properties: {
          invoice: { type: 'string', description: 'BOLT11 invoice to pay.' },
          paymentHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          amount: { type: 'integer', description: 'Deposit amount in sats.' },
          quotaGranted: { type: 'integer', description: 'Sats that will be credited on the token after verification (equals amount; credits are amount / rateSatsPerRequest).' },
          tierId: { type: 'integer', description: 'The tier matched by the deposit amount (1 to 5).' },
          rateSatsPerRequest: { type: 'number', description: 'Effective rate for this deposit, in sats per request. Locked upon settlement of the Lightning invoice.' },
          discountPct: { type: 'number', minimum: 0, maximum: 100, description: 'Discount vs base rate (tier 1), for display purposes only.' },
          expiresIn: { type: 'integer', description: 'Invoice expiry in seconds.' },
          instructions: { type: 'string' },
        },
      },
      ProbeResult: {
        type: 'object',
        required: ['url', 'target', 'firstFetch', 'totalLatencyMs', 'cost'],
        properties: {
          url: { type: 'string', format: 'uri' },
          target: { type: 'string', enum: ['L402', 'NOT_L402', 'UNREACHABLE'], description: 'Classification of the target after the first fetch.' },
          firstFetch: { type: 'object', required: ['status', 'latencyMs'], properties: {
            status: { type: ['integer', 'null'] },
            latencyMs: { type: 'integer' },
            httpError: { type: 'string', description: 'Populated when the first fetch failed at the transport level.' },
          } },
          l402Challenge: { type: 'object', description: 'Parsed WWW-Authenticate when target is L402. Absent otherwise.', properties: {
            macaroonLen: { type: 'integer' },
            invoiceSats: { type: ['integer', 'null'] },
            invoicePaymentHash: { type: 'string' },
          } },
          payment: { type: 'object', description: 'SatRank-side payment attempt. Absent when no challenge was payable (target NOT_L402, unreachable, or invalid bolt11).', properties: {
            paymentHash: { type: 'string' },
            preimage: { type: 'string' },
            paymentError: { type: 'string' },
            durationMs: { type: 'integer' },
          } },
          secondFetch: { type: 'object', description: 'Authenticated retry after payment (absent if payment did not succeed).', properties: {
            status: { type: 'integer' },
            latencyMs: { type: 'integer' },
            bodyBytes: { type: 'integer' },
            bodyHash: { type: 'string' },
            bodyPreview: { type: 'string' },
          } },
          totalLatencyMs: { type: 'integer' },
          cost: { type: 'object', required: ['creditsDeducted'], properties: {
            creditsDeducted: { type: 'integer', description: 'Credits charged to the caller (5 per call: 1 via balanceAuth, 4 by the handler).' },
          } },
        },
      },
      ReportRequest: {
        type: 'object',
        required: ['target', 'reporter', 'outcome'],
        properties: {
          target: { type: 'string', description: 'Target agent identifier' },
          reporter: { type: 'string', description: 'Reporter agent identifier' },
          outcome: { type: 'string', enum: ['success', 'failure', 'timeout'] },
          paymentHash: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Payment hash for preimage verification' },
          preimage: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Preimage. SHA256(preimage) must equal paymentHash.' },
          amountBucket: { type: 'string', enum: ['micro', 'small', 'medium', 'large'] },
          memo: { type: 'string', maxLength: 280, description: 'Free-text note' },
        },
      },
      ReportResponse: {
        type: 'object',
        properties: {
          reportId: { type: 'string', format: 'uuid' },
          verified: { type: 'boolean', description: 'true if preimage verified successfully' },
          weight: { type: 'number', description: 'Applied weight (0.3-2.0)' },
          timestamp: { type: 'integer' },
          bonus: {
            oneOf: [
              {
                type: 'object',
                description: 'Tier 2 reporter-bonus outcome. Returned when REPORT_BONUS_ENABLED=true and the report service is wired.',
                properties: {
                  credited: { type: 'boolean' },
                  sats: { type: 'integer', description: 'Sats credited to the reporter deposit balance (only when credited=true)' },
                  gate: { type: 'string', description: 'Gate code explaining the decision (eligibility check or payout reason)' },
                },
                required: ['credited'],
              },
              { type: 'null' },
            ],
            description: 'Tier 2 reporter-bonus payload. Null when the bonus flag is off or the service is not wired.',
          },
        },
        required: ['reportId', 'verified', 'weight', 'timestamp'],
      },
      EndpointResponse: {
        type: 'object',
        description: 'Bayesian view of a single HTTP endpoint keyed by url_hash (sha256 of the canonical URL).',
        properties: {
          data: {
            type: 'object',
            required: ['urlHash', 'bayesian'],
            properties: {
              urlHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
              bayesian: { $ref: '#/components/schemas/BayesianScoreBlock' },
              metadata: {
                oneOf: [
                  { type: 'null' },
                  { type: 'object', properties: {
                    url: { type: 'string' },
                    name: { type: ['string', 'null'] },
                    description: { type: ['string', 'null'] },
                    category: { type: ['string', 'null'] },
                    provider: { type: ['string', 'null'] },
                    priceSats: { type: ['integer', 'null'] },
                    source: { type: 'string', enum: ['402index', 'self_registered', 'ad_hoc'] },
                  } },
                ],
                description: 'Light metadata pulled from service_endpoints when the url_hash matches a known row.',
              },
              http: {
                oneOf: [
                  { type: 'null' },
                  { type: 'object', properties: {
                    status: { type: ['integer', 'null'] },
                    latencyMs: { type: ['integer', 'null'] },
                    uptimeRatio: { type: ['number', 'null'] },
                    checkCount: { type: 'integer' },
                    lastCheckedAt: { type: ['integer', 'null'] },
                  } },
                ],
              },
              node: {
                oneOf: [
                  { type: 'null' },
                  { type: 'object', properties: {
                    publicKeyHash: { type: 'string' },
                    alias: { type: ['string', 'null'] },
                  } },
                ],
              },
            },
          },
          meta: { type: 'object', properties: { computedAt: { type: 'integer' } } },
        },
      },
      ProfileResponse: {
        type: 'object',
        description: 'Restructured agent profile with report statistics and probe uptime.',
        properties: {
          agent: { type: 'object', properties: {
            publicKeyHash: { type: 'string' },
            alias: { type: ['string', 'null'] },
            publicKey: { type: ['string', 'null'] },
            firstSeen: { type: 'integer' },
            lastSeen: { type: 'integer' },
            source: { type: 'string' },
          } },
          bayesian: { $ref: '#/components/schemas/BayesianScoreBlock' },
          rank: { type: ['integer', 'null'], description: '1-based rank among all agents by p_success (null when no posterior has converged).' },
          reports: { type: 'object', properties: {
            total: { type: 'integer' },
            successes: { type: 'integer' },
            failures: { type: 'integer' },
            timeouts: { type: 'integer' },
            successRate: { type: 'number', minimum: 0, maximum: 1 },
          } },
          probeUptime: { type: ['number', 'null'], description: 'Probe reachability ratio over 7 days (0-1)' },
          channelFlow: { oneOf: [{ type: 'object', properties: { net7d: { type: ['integer', 'null'] }, capacityDelta7d: { type: ['integer', 'null'] }, trend: { type: 'string', enum: ['growing', 'stable', 'declining'] } } }, { type: 'null' }], description: 'Net channel change over 7 days' },
          capacityHealth: { oneOf: [{ type: 'object', properties: { drainRate24h: { type: ['number', 'null'] }, drainRate7d: { type: ['number', 'null'] }, trend: { type: 'string', enum: ['growing', 'stable', 'declining'] } } }, { type: 'null' }], description: 'Capacity drain rate' },
          feeVolatility: { oneOf: [{ type: 'object', properties: { index: { type: 'integer' }, interpretation: { type: 'string', enum: ['stable', 'moderate', 'volatile'] }, changesLast7d: { type: 'integer' } } }, { type: 'null' }], description: 'Fee policy volatility index' },
          riskProfile: { $ref: '#/components/schemas/RiskProfile' },
          evidence: { $ref: '#/components/schemas/ScoreEvidence' },
          flags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    responses: {
      NotFound: {
        description: 'Resource not found',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      },
      ValidationError: {
        description: 'Validation error',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      },
      Unauthorized: {
        description: 'Missing or invalid API key',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      },
      AutoIndexing: {
        description: 'Unknown Lightning pubkey accepted for background indexing. Retry after 10 seconds.',
        content: { 'application/json': { schema: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['indexing'] },
            retryAfter: { type: 'integer', example: 10 },
          },
        } } },
      },
      PaymentRequired: {
        description: 'L402 payment required. Base rate is 1 sat per request (tier 1). Pay the Lightning invoice and retry with the L402 token. If the error code is BALANCE_EXHAUSTED, remove the Authorization header and retry to get a new tier-1 invoice, or use POST /api/deposit to buy a larger batch at a discounted rate (21 to 1,000,000 sats, see GET /api/deposit/tiers).',
        headers: {
          'WWW-Authenticate': {
            description: 'L402 challenge containing a macaroon and a Lightning invoice. Format: L402 macaroon="<base64>", invoice="<bolt11>"',
            schema: { type: 'string', example: 'L402 macaroon="AGIAJEemVQ...", invoice="lnbc10n1pj..."' },
          },
          'X-SatRank-Balance': {
            description: 'Remaining requests on the current L402 token. When 0, the next request returns BALANCE_EXHAUSTED.',
            schema: { type: 'integer', example: 15 },
          },
        },
      },
      RateLimited: {
        description: 'Free discovery rate limit exceeded (10 req/min/IP). Slow down or upgrade to a paid path (e.g. POST /intent with fresh=true).',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      },
    },
  },
};
