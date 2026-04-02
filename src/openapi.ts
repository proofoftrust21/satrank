// OpenAPI 3.1 specification for SatRank API v1
export const openapiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'SatRank API',
    version: '1.0.0',
    description: 'Trust score for AI agents on Bitcoin Lightning. The PageRank of the agentic economy.',
    license: { name: 'AGPL-3.0' },
  },
  servers: [{ url: '/api/v1' }],
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
          '402': { $ref: '#/components/responses/PaymentRequired' },
          '404': { $ref: '#/components/responses/NotFound' },
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
            description: 'Paginated score history',
            content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                data: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/ScoreSnapshot' },
                },
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
    '/agents/top': {
      get: {
        summary: 'Leaderboard by score',
        operationId: 'getTopAgents',
        tags: ['Agents'],
        security: [{ l402: [] }],
        parameters: [
          { $ref: '#/components/parameters/limit' },
          { $ref: '#/components/parameters/offset' },
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
          '402': { $ref: '#/components/responses/PaymentRequired' },
        },
      },
    },
    '/agents/search': {
      get: {
        summary: 'Search agents by alias',
        operationId: 'searchAgents',
        tags: ['Agents'],
        security: [{ l402: [] }],
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
          '402': { $ref: '#/components/responses/PaymentRequired' },
          '400': { $ref: '#/components/responses/ValidationError' },
        },
      },
    },
    '/attestation': {
      post: {
        summary: 'Submit an attestation',
        operationId: 'createAttestation',
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
      AgentSummary: {
        type: 'object',
        properties: {
          publicKeyHash: { type: 'string' },
          alias: { type: ['string', 'null'] },
          score: { type: 'integer' },
          totalTransactions: { type: 'integer' },
          source: { type: 'string' },
        },
      },
      AgentSearchResult: {
        type: 'object',
        properties: {
          publicKeyHash: { type: 'string' },
          alias: { type: ['string', 'null'] },
          score: { type: 'integer' },
          source: { type: 'string' },
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
        },
      },
      HealthResponse: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'error'] },
          agentsIndexed: { type: 'integer' },
          totalTransactions: { type: 'integer' },
          lastUpdate: { type: 'integer' },
          uptime: { type: 'integer' },
        },
      },
      NetworkStats: {
        type: 'object',
        properties: {
          totalAgents: { type: 'integer' },
          totalTransactions: { type: 'integer' },
          totalAttestations: { type: 'integer' },
          avgScore: { type: 'number' },
          totalVolumeBuckets: {
            type: 'object',
            properties: {
              micro: { type: 'integer' },
              small: { type: 'integer' },
              medium: { type: 'integer' },
              large: { type: 'integer' },
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
