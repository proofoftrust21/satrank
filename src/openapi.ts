// OpenAPI 3.1 specification for SatRank API v1
export const openapiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'SatRank API',
    version: '1.0.0',
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
        summary: 'Get agent score history',
        operationId: 'getAgentHistory',
        tags: ['Agents'],
        security: [{ l402: [] }],
        parameters: [
          { $ref: '#/components/parameters/publicKeyHash' },
          { $ref: '#/components/parameters/limit' },
          { $ref: '#/components/parameters/offset' },
        ],
        responses: {
          '200': {
            description: 'Paginated score history enriched with deltas',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                data: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/EnrichedSnapshot' },
                },
                delta: { $ref: '#/components/schemas/ScoreDelta' },
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
        summary: 'Top movers (7-day score change)',
        operationId: 'getTopMovers',
        tags: ['Agents'],
        responses: {
          '200': {
            description: 'Agents with biggest score changes in the last 7 days',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  properties: {
                    up: { type: 'array', items: { $ref: '#/components/schemas/TopMover' } },
                    down: { type: 'array', items: { $ref: '#/components/schemas/TopMover' } },
                  },
                },
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
              enum: ['score', 'volume', 'reputation', 'seniority', 'regularity', 'diversity'],
              default: 'score',
            },
            description: 'Sort leaderboard by total score (default) or individual component. Use reputation to find reliable small nodes.',
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
          '409': { description: 'Duplicate attestation', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
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
    // --- Decision endpoints ---
    '/decide': {
      post: {
        summary: 'GO / NO-GO decision with success probability',
        operationId: 'decide',
        description: 'Returns a boolean go/no-go, success rate (0-1), and the 4 probability components. The primary endpoint for pre-transaction decisions.',
        tags: ['Decision'],
        security: [{ l402: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/DecideRequest' } } },
        },
        responses: {
          '200': {
            description: 'Decision result',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/DecideResponse' } } } } },
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '402': { $ref: '#/components/responses/PaymentRequired' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/report': {
      post: {
        summary: 'Report transaction outcome',
        operationId: 'report',
        description: 'Submit a success/failure/timeout report. Free (no L402 payment). Weighted by reporter trust score. Preimage verification gives 2x weight bonus.',
        tags: ['Reports'],
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
          '404': { $ref: '#/components/responses/NotFound' },
          '409': { description: 'Duplicate report (same reporter+target within 1 hour)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
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
        description: 'L402 Lightning payment authentication. Send a request without credentials to receive HTTP 402 with a Lightning invoice (1 sat). Pay the invoice and include the token: Authorization: L402 <macaroon>:<preimage>',
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
            },
            required: ['code', 'message'],
          },
          requestId: { type: 'string' },
        },
      },
      ScoreComponents: {
        type: 'object',
        properties: {
          volume: { type: 'number' },
          reputation: { type: 'number' },
          seniority: { type: 'number' },
          regularity: { type: 'number' },
          diversity: { type: 'number' },
        },
      },
      AgentScoreResponse: {
        type: 'object',
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
          score: {
            type: 'object',
            properties: {
              total: { type: 'integer', minimum: 0, maximum: 100 },
              components: { $ref: '#/components/schemas/ScoreComponents' },
              confidence: { type: 'string', enum: ['very_low', 'low', 'medium', 'high', 'very_high'] },
              computedAt: { type: 'integer' },
            },
          },
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
          delta: { $ref: '#/components/schemas/ScoreDelta' },
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
                  hubnessRank: { type: 'integer', description: 'LN+ hubness rank — influence in the network' },
                  betweennessRank: { type: 'integer', description: 'LN+ betweenness rank — frequency on shortest paths' },
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
      ScoreSnapshot: {
        type: 'object',
        properties: {
          score: { type: 'integer' },
          components: { $ref: '#/components/schemas/ScoreComponents' },
          computedAt: { type: 'integer' },
        },
      },
      EnrichedSnapshot: {
        type: 'object',
        properties: {
          score: { type: 'integer' },
          components: { $ref: '#/components/schemas/ScoreComponents' },
          computedAt: { type: 'integer' },
          delta: { type: ['integer', 'null'], description: 'Score change vs previous snapshot' },
        },
      },
      ScoreDelta: {
        type: 'object',
        description: 'Temporal score deltas — the core differentiating product',
        properties: {
          delta24h: { type: ['integer', 'null'], description: 'Score change over 24 hours' },
          delta7d: { type: ['integer', 'null'], description: 'Score change over 7 days' },
          delta30d: { type: ['integer', 'null'], description: 'Score change over 30 days' },
          trend: { type: 'string', enum: ['rising', 'stable', 'falling'] },
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
      TopMover: {
        type: 'object',
        properties: {
          publicKeyHash: { type: 'string' },
          alias: { type: ['string', 'null'] },
          score: { type: 'integer' },
          delta7d: { type: 'integer', description: '7-day score change' },
          trend: { type: 'string', enum: ['rising', 'stable', 'falling'] },
        },
      },
      NetworkTrends: {
        type: 'object',
        description: 'Network-wide temporal trends',
        properties: {
          avgScoreDelta7d: { type: 'number', description: 'Average score change over 7 days' },
          topMoversUp: { type: 'array', items: { $ref: '#/components/schemas/TopMover' } },
          topMoversDown: { type: 'array', items: { $ref: '#/components/schemas/TopMover' } },
        },
      },
      AgentSummary: {
        type: 'object',
        properties: {
          publicKeyHash: { type: 'string' },
          alias: { type: ['string', 'null'] },
          score: { type: 'integer' },
          totalTransactions: { type: 'integer' },
          source: { type: 'string' },
          components: { $ref: '#/components/schemas/ScoreComponents' },
        },
      },
      AgentSearchResult: {
        type: 'object',
        properties: {
          publicKeyHash: { type: 'string' },
          alias: { type: ['string', 'null'] },
          score: { type: 'integer' },
          totalTransactions: { type: 'integer' },
          source: { type: 'string' },
          components: { $ref: '#/components/schemas/ScoreComponents' },
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
          source: { type: 'string', enum: ['lnd_queryroutes'], description: 'Pathfinding method used' },
        },
        required: ['reachable', 'hops', 'estimatedFeeMsat', 'alternatives', 'latencyMs', 'source'],
      },
      RiskProfile: {
        type: 'object',
        description: 'Behavioral risk classification based on observable properties.',
        properties: {
          name: {
            type: 'string',
            enum: ['established_hub', 'growing_node', 'declining_node', 'new_unproven', 'small_reliable', 'suspicious_rapid_rise', 'default'],
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
          agentsIndexed: { type: 'integer' },
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
          totalAgents: { type: 'integer', description: 'Total agents indexed across all sources' },
          totalChannels: { type: 'integer', description: 'Sum of Lightning channels across all lightning_graph agents' },
          nodesWithRatings: { type: 'integer', description: 'Number of agents with LN+ ratings (lnplus_rank > 0)' },
          networkCapacityBtc: { type: 'number', description: 'Total network capacity in BTC (sum of all agent capacities)' },
          avgScore: { type: 'number', description: 'Average score across all scored agents' },
          totalVolumeBuckets: {
            type: 'object',
            properties: {
              micro: { type: 'integer' },
              small: { type: 'integer' },
              medium: { type: 'integer' },
              large: { type: 'integer' },
            },
          },
          trends: { $ref: '#/components/schemas/NetworkTrends' },
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
      // --- Decision schemas ---
      DecideRequest: {
        type: 'object',
        required: ['target', 'caller'],
        properties: {
          target: { type: 'string', description: '64-char SHA256 hash or 66-char Lightning pubkey of the target agent' },
          caller: { type: 'string', description: '64-char SHA256 hash or 66-char Lightning pubkey of the calling agent' },
          amountSats: { type: 'integer', minimum: 1, description: 'Optional: transaction amount in sats (reserved for future amount-aware routing)' },
        },
      },
      DecideResponse: {
        type: 'object',
        description: 'GO / NO-GO decision with success probability components.',
        properties: {
          go: { type: 'boolean', description: 'true = proceed with transaction, false = abort' },
          successRate: { type: 'number', minimum: 0, maximum: 1, description: 'Combined success probability (0-1)' },
          components: {
            type: 'object',
            properties: {
              trustScore: { type: 'number', description: 'P_trust — sigmoid of the SatRank score' },
              routable: { type: 'number', description: 'P_routable — route exists from caller to target (0 or 1)' },
              available: { type: 'number', description: 'P_available — probe uptime over 7 days' },
              empirical: { type: 'number', description: 'P_empirical — historical success rate from reports' },
            },
          },
          basis: { type: 'string', enum: ['proxy', 'empirical'], description: 'proxy = <10 reports (using trust score), empirical = >=10 reports' },
          confidence: { type: 'string', enum: ['very_low', 'low', 'medium', 'high', 'very_high'] },
          verdict: { type: 'string', enum: ['SAFE', 'RISKY', 'UNKNOWN'] },
          flags: { type: 'array', items: { type: 'string' } },
          pathfinding: { oneOf: [{ $ref: '#/components/schemas/PathfindingResult' }, { type: 'null' }] },
          riskProfile: { $ref: '#/components/schemas/RiskProfile' },
          reason: { type: 'string' },
          survival: { $ref: '#/components/schemas/SurvivalResult' },
          latencyMs: { type: 'integer', description: 'Total decision computation time in ms' },
        },
        required: ['go', 'successRate', 'components', 'basis', 'confidence', 'verdict', 'flags', 'reason', 'survival', 'latencyMs'],
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
        },
        required: ['reportId', 'verified', 'weight', 'timestamp'],
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
          score: { type: 'object', properties: {
            total: { type: 'integer' },
            components: { $ref: '#/components/schemas/ScoreComponents' },
            confidence: { type: 'string' },
            rank: { type: ['integer', 'null'], description: '1-based rank among all agents by score' },
          } },
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
          delta: { $ref: '#/components/schemas/ScoreDelta' },
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
        description: 'L402 payment required. Pay the Lightning invoice (1 sat) and retry with the L402 token.',
        headers: {
          'WWW-Authenticate': {
            description: 'L402 challenge containing a macaroon and a Lightning invoice. Format: L402 macaroon="<base64>", invoice="<bolt11>"',
            schema: { type: 'string', example: 'L402 macaroon="AGIAJEemVQ...", invoice="lnbc10n1pj..."' },
          },
        },
      },
    },
  },
};
