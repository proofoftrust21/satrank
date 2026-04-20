// OpenAPI 3.1 specification for SatRank API
export const openapiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'SatRank API',
    version: '0.1.0',
    description: 'Trust score for AI agents on Bitcoin Lightning. The PageRank of the agentic economy.',
    license: { name: 'AGPL-3.0' },
  },
  servers: [{ url: '/api' }],
  paths: {
    '/agent/{publicKeyHash}': {
      get: {
        summary: 'Get agent score',
        operationId: 'getAgentScore',
        tags: ['Agents'],
        security: [{ l402: [] }],
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
          '402': { $ref: '#/components/responses/PaymentRequired' },
          '404': { $ref: '#/components/responses/NotFound' },
          '400': { $ref: '#/components/responses/ValidationError' },
        },
      },
    },
    '/agent/{publicKeyHash}/verdict': {
      get: {
        summary: 'Get agent verdict (SAFE / RISKY / UNKNOWN)',
        operationId: 'getAgentVerdict',
        description: 'Binary trust decision optimized for < 200ms agent-to-agent evaluation. Returns SAFE, RISKY, or UNKNOWN with confidence, flags, risk profile, and optional personalized trust distance.',
        tags: ['Agents'],
        security: [{ l402: [] }],
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
          '402': { $ref: '#/components/responses/PaymentRequired' },
          '400': { $ref: '#/components/responses/ValidationError' },
        },
      },
    },
    '/verdicts': {
      post: {
        summary: 'Batch verdict — up to 100 hashes in one request',
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
        description: 'Returns the current Bayesian posterior. Posterior-history samples (data[]) land with the Commit 8 aggregate tables; the response shape is stable.',
        tags: ['Agents'],
        security: [{ l402: [] }],
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
          '402': { $ref: '#/components/responses/PaymentRequired' },
          '400': { $ref: '#/components/responses/ValidationError' },
        },
      },
    },
    '/agent/{publicKeyHash}/attestations': {
      get: {
        summary: 'Get attestations received by an agent',
        operationId: 'getAgentAttestations',
        tags: ['Attestations'],
        security: [{ l402: [] }],
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
          '402': { $ref: '#/components/responses/PaymentRequired' },
          '404': { $ref: '#/components/responses/NotFound' },
          '400': { $ref: '#/components/responses/ValidationError' },
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
        summary: 'Submit an attestation (FREE — no L402 payment required)',
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
            description: 'Service degraded — database unreachable or schema mismatch',
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
        summary: 'Report transaction outcome',
        operationId: 'report',
        description: 'Submit a success/failure/timeout report. Authenticated (X-API-Key or an L402 deposit token that previously decided on this target — see decide_log scoping). Does not consume quota. Weighted by reporter trust score and reporter badge tier; preimage verification gives a 2x weight bonus.',
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
          '401': { description: 'Missing or invalid auth (no X-API-Key and no decide-scoped L402 token for this target)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          '403': { description: 'L402 token not scoped to this target (no decide_log row linking token→target within the auth window)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          '404': { $ref: '#/components/responses/NotFound' },
          '409': { description: 'Duplicate report — same reporter+target within 1 hour (error.code = DUPLICATE_REPORT)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
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
        description: 'QueryRoutes in real-time via LND. Returns whether a Lightning node is reachable right now, hops, and fees. Free — no L402 required. Use ?from=<your_pubkey> for personalized pathfinding.',
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
        summary: 'Buy requests via variable-amount Lightning invoice',
        operationId: 'deposit',
        description: 'Two-phase deposit (1 sat = 1 request). Phase 1: send { amount } (21-10,000) to receive a BOLT11 invoice. Phase 2: after payment, send { paymentHash, preimage } to verify and credit the balance. Use the resulting token on all paid endpoints: Authorization: L402 deposit:<preimage>. Rate limited to 3 invoices/min/IP.',
        tags: ['Payment'],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { oneOf: [
            { type: 'object', properties: { amount: { type: 'integer', minimum: 21, maximum: 10000, description: 'Sats to deposit (1 sat = 1 request)' } }, required: ['amount'] },
            { type: 'object', properties: { paymentHash: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Payment hash from the invoice' }, preimage: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Payment preimage (proof of payment)' } }, required: ['paymentHash', 'preimage'] },
          ] } } },
        },
        responses: {
          '201': { description: 'Deposit verified — balance credited', content: { 'application/json': { schema: { type: 'object', properties: {
            balance: { type: 'integer', description: 'Total requests available' },
            paymentHash: { type: 'string' },
            token: { type: 'string', example: 'L402 deposit:<preimage>', description: 'Use as Authorization header on paid endpoints' },
          } } } } },
          '402': { description: 'Phase 1: invoice generated. Phase 2: payment not yet settled.', content: { 'application/json': { schema: { type: 'object', properties: {
            invoice: { type: 'string', description: 'BOLT11 Lightning invoice (phase 1)' },
            paymentHash: { type: 'string' },
            amount: { type: 'integer' },
            quotaGranted: { type: 'integer', description: '1 sat = 1 request' },
            expiresIn: { type: 'integer', description: 'Invoice expiry in seconds (600)' },
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
        description: 'Returns verdicts that changed since the given timestamp. Free endpoint — use as a fallback when Nostr NIP-85 subscription is not available. For real-time updates, subscribe to kind 30382 events on relay.damus.io, nos.lol, or relay.primal.net (published every 30 min, delta-only).',
        tags: ['Monitoring'],
        parameters: [
          { name: 'targets', in: 'query', required: true, schema: { type: 'string' }, description: 'Comma-separated 64-char hex hashes (max 50)' },
          { name: 'since', in: 'query', required: false, schema: { type: 'integer', minimum: 0 }, description: 'Unix timestamp — only return changes after this time. Omit for all latest verdicts.' },
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
        description: 'Phase 5 discovery API. The agent provides a structured intent (category + optional keywords + budget + max_latency); SatRank returns up to 20 candidates ranked Bayesian-native (p_success DESC → ci95_low DESC → price_sats ASC) with advisory overlay and health snapshot. Free endpoint, neutral ordering (no paid listing). snake_case convention.\n\nCategory must be a known enum member (see GET /api/intent/categories). Unknown categories → 400 INVALID_CATEGORY. Malformed categories → 400 VALIDATION_ERROR.\n\nStrictness tiers (aligned with /api/services/best): strict (SAFE only) → relaxed (any non-RISKY, warning FALLBACK_RELAXED) → degraded (pool empty, warning NO_CANDIDATES). RISKY candidates are never returned.',
        tags: ['Discovery'],
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
                } },
                candidates: { type: 'array', items: { type: 'object', properties: {
                  rank: { type: 'integer' },
                  endpoint_url: { type: 'string', format: 'uri' },
                  endpoint_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
                  operator_pubkey: { type: ['string', 'null'], description: '66-char LN pubkey of the node operator.' },
                  service_name: { type: ['string', 'null'] },
                  price_sats: { type: ['integer', 'null'] },
                  median_latency_ms: { type: ['integer', 'null'], description: 'SQL median over service_probes within 7 days (null if < 3 probes).' },
                  bayesian: { $ref: '#/components/schemas/BayesianScoreBlock' },
                  advisory: { type: 'object', properties: {
                    advisory_level: { type: 'string', enum: ['green', 'yellow', 'orange', 'red'] },
                    risk_score: { type: 'number', minimum: 0, maximum: 1 },
                    advisories: { type: 'array', items: { type: 'object' } },
                    recommendation: { type: 'string', enum: ['proceed', 'proceed_with_caution', 'consider_alternative', 'avoid'] },
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
                } },
              },
            } } },
          },
          '400': { description: 'VALIDATION_ERROR (malformed body) or INVALID_CATEGORY (unknown category)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
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
        description: 'Browse and search the L402 service registry. Returns service metadata (name, description, category, provider, price) enriched with the SatRank canonical Bayesian block for the backing Lightning node. Free endpoint — no L402 required. Data sourced from 402index.io, refreshed every 24h.',
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
        summary: 'Self-register an L402 service',
        operationId: 'registerService',
        description: 'Service operators can submit their L402 endpoint URL. SatRank validates by GET-ing the URL and parsing the WWW-Authenticate header. Must return HTTP 402 with a valid BOLT11 invoice. Free, rate-limited (10/min/IP).',
        tags: ['Discovery'],
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
          '201': { description: 'Service registered', content: { 'application/json': { schema: { type: 'object', properties: {
            data: { type: 'object', properties: {
              url: { type: 'string' },
              registered: { type: 'boolean' },
              agentHash: { type: 'string' },
              priceSats: { type: ['integer', 'null'] },
              message: { type: 'string' },
            } },
          } } } } },
          '400': { description: 'URL is not a valid L402 endpoint' },
          '503': { description: 'Self-registration unavailable (LND BOLT11 decoder not configured)' },
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
  },
  components: {
    securitySchemes: {
      apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      l402: {
        type: 'http',
        scheme: 'L402',
        description: 'L402 Lightning payment authentication (1 sat = 1 request). Two options: (1) Standard L402 — send a request without credentials to receive HTTP 402 with a Lightning invoice for 21 sats (21 requests). Pay and include: Authorization: L402 <macaroon>:<preimage>. (2) Deposit — POST /api/deposit with { amount: N } (21-10,000 sats), pay the invoice, verify, and use: Authorization: L402 deposit:<preimage>. Both token types work on all paid endpoints. X-SatRank-Balance header tracks remaining requests.',
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
        description: 'Canonical Bayesian posterior block — shared shape across all public endpoints (verdict, intent, profile, service, endpoint). Phase 3 C9 : streaming exponential decay (τ=7d), plus de champ `window` — l\'ancienne fenêtre a été remplacée par `time_constant_days`, `recent_activity`, `risk_profile`, `last_update`.',
        required: ['p_success', 'ci95_low', 'ci95_high', 'n_obs', 'verdict', 'time_constant_days', 'last_update', 'sources', 'convergence', 'recent_activity', 'risk_profile'],
        properties: {
          p_success: { type: 'number', minimum: 0, maximum: 1, description: 'Beta-Binomial posterior mean (streaming, décroissance τ=7j).' },
          ci95_low:  { type: 'number', minimum: 0, maximum: 1, description: 'Lower bound of the 95% credible interval.' },
          ci95_high: { type: 'number', minimum: 0, maximum: 1, description: 'Upper bound of the 95% credible interval.' },
          n_obs: { type: 'number', description: 'Observations effectives (excès d\'évidence au-delà du prior) — somme décayée τ=7j des 3 sources.' },
          verdict: { type: 'string', enum: ['SAFE', 'UNKNOWN', 'RISKY', 'INSUFFICIENT'], description: 'Priority: INSUFFICIENT > RISKY > UNKNOWN > SAFE.' },
          time_constant_days: { type: 'number', description: 'Constante τ exposée (décroissance exponentielle, jours). Actuellement 7.' },
          last_update: { type: 'number', description: 'Unix seconds de la dernière ingestion connue — max sur les 3 sources. 0 si aucune observation.' },
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
            description: 'n_obs cumulé sur 24h/7d/30d (daily_buckets, observer inclus) — display-only, indépendant du verdict.',
            properties: {
              last_24h: { type: 'integer', minimum: 0 },
              last_7d:  { type: 'integer', minimum: 0 },
              last_30d: { type: 'integer', minimum: 0 },
            },
          },
          risk_profile: { type: 'string', enum: ['low', 'medium', 'high', 'unknown'], description: 'Trend delta success_rate 7j récents vs 23j antérieurs — Option B.' },
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
        description: 'Agent profile: identity + stats + evidence overlay + canonical Bayesian block. No composite score surface — `bayesian` is the source of truth.',
        required: ['agent', 'bayesian', 'stats', 'evidence', 'alerts'],
        properties: {
          agent: {
            type: 'object',
            properties: {
              publicKeyHash: { type: 'string' },
              alias: { type: ['string', 'null'] },
              firstSeen: { type: 'integer' },
              lastSeen: { type: 'integer' },
              source: { type: 'string', enum: ['observer_protocol', '4tress', 'lightning_graph', 'manual'] },
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
                properties: {
                  positiveRatings: { type: 'integer' },
                  negativeRatings: { type: 'integer' },
                  lnplusRank: { type: 'integer', minimum: 0, maximum: 10 },
                  hubnessRank: { type: 'integer', description: 'LN+ hubness rank — influence in the network (supplemented by sovereign PageRank)' },
                  betweennessRank: { type: 'integer', description: 'LN+ betweenness rank — frequency on shortest paths (supplemented by sovereign PageRank)' },
                  sourceUrl: { type: 'string', format: 'uri', description: 'Verify on LightningNetwork.plus' },
                },
              },
              { type: 'null' },
            ],
            description: 'LN+ community ratings. Null if no ratings exist.',
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
                description: 'Route probe data — proprietary reachability test from our Lightning node',
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
        description: 'Leaderboard row — identity + canonical Bayesian block.',
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
        description: 'Search result — identity + canonical Bayesian block.',
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
        description: 'Real-time personalized route query from the calling agent to the target, via LND QueryRoutes with source_pub_key. This is proprietary data — no free alternative provides personalized pathfinding as a service.',
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
          staleAgents: { type: 'integer', description: 'Fossil agents — not seen in 90+ days, kept for history but excluded from stats' },
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
          phantomRate: { type: 'number', description: 'Percentage of probed nodes that are unreachable in routing (0–100). Computed live from the last 24h probe window' },
          verifiedReachable: { type: 'integer', description: 'Nodes with at least one successful probe in the last 24h — "who you can actually pay"' },
          probes24h: { type: 'integer', description: 'Total QueryRoutes probes executed in the last 24h rolling window (all amount tiers combined)' },
          totalChannels: { type: 'integer', description: 'Sum of Lightning channels across all lightning_graph agents' },
          nodesWithRatings: { type: 'integer', description: 'Number of agents with non-zero sovereign reputation (PageRank > 0 on SatRank peer-trust graph; LN+ has been deprecated since v19)' },
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
              targetN: { type: 'integer', description: 'Target report count — 200 by default' },
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
      SurvivalResult: {
        type: 'object',
        description: 'Predicts whether a node will still be reachable in 7 days, based on score trajectory, probe stability, and gossip freshness.',
        properties: {
          score: { type: 'integer', minimum: 0, maximum: 100, description: 'Survival score (0 = likely dead, 100 = stable)' },
          prediction: { type: 'string', enum: ['stable', 'at_risk', 'likely_dead'] },
          signals: { type: 'object', properties: {
            scoreTrajectory: { type: 'string' },
            probeStability: { type: 'string' },
            gossipFreshness: { type: 'string' },
          } },
        },
        required: ['score', 'prediction', 'signals'],
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
          survival: { $ref: '#/components/schemas/SurvivalResult' },
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
        description: 'L402 payment required (1 sat = 1 request). Pay the Lightning invoice and retry with the L402 token. If the error code is BALANCE_EXHAUSTED, remove the Authorization header and retry to get a new 21-sat invoice, or use POST /api/deposit to buy 21-10,000 requests at once.',
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
    },
  },
};
