// Phase 3 (2026-05-01) — POST/GET /api/schemas
//
// Operators register canonical JSON Schemas (draft-07) for their endpoints.
// Agents reference schemas by hash in fulfill's expected_schema_hash.
//
//   POST /api/schemas (NIP-98 gated)
//     body: { schema, name?, content_type? }
//     → 201 { schema_hash, created: true|false }   (idempotent)
//
//   GET /api/schemas/:hash (free)
//     → 200 { data: { schema_hash, schema_json, ... } }
//     → 404 not found
//
// Validation at registration: schema must be a valid JSON Schema (ajv
// compile() must succeed). Anything that compiles is accepted — we don't
// enforce a particular profile (agents pick their level of strictness).
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import Ajv from 'ajv';
import { verifyNip98 } from '../middleware/nip98';
import { ValidationError } from '../errors';
import { formatZodError } from '../utils/zodError';
import { logger } from '../logger';
import type { EndpointSchemaRepository } from '../repositories/endpointSchemaRepository';

const SCHEMA_BYTE_CAP = 256 * 1024; // 256 KB — generous for any reasonable JSON Schema

const registerSchemaBody = z.object({
  schema: z.unknown(),
  name: z.string().min(1).max(120).optional(),
  content_type: z.string().min(1).max(80).optional(),
});

export interface SchemaControllerDeps {
  endpointSchemaRepo: EndpointSchemaRepository;
}

export class SchemaController {
  private readonly endpointSchemaRepo: EndpointSchemaRepository;

  constructor(deps: SchemaControllerDeps) {
    this.endpointSchemaRepo = deps.endpointSchemaRepo;
  }

  private fullUrl(req: Request): string {
    return `${req.protocol}://${req.get('host') ?? ''}${req.originalUrl}`;
  }

  register = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Step 1 — NIP-98 auth.
      const authHeader = req.headers.authorization;
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? null;
      const auth = await verifyNip98(authHeader, 'POST', this.fullUrl(req), rawBody);
      if (!auth.valid || !auth.pubkey || !auth.event_id) {
        logger.warn(
          { detail: auth.detail, route: '/api/schemas' },
          'NIP-98 rejected on /api/schemas',
        );
        res.status(401).json({ error: 'invalid_auth' });
        return;
      }

      // Step 2 — body byte cap (defense-in-depth past express body-parser limit).
      const bodyLen = (rawBody?.length ?? 0);
      if (bodyLen > SCHEMA_BYTE_CAP) {
        res.status(413).json({
          error: 'schema_too_large',
          max_bytes: SCHEMA_BYTE_CAP,
          observed_bytes: bodyLen,
        });
        return;
      }

      // Step 3 — body validation.
      const parsed = registerSchemaBody.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(formatZodError(parsed.error, req.body));
      }
      const { schema, name, content_type } = parsed.data;

      // Step 4 — JSON Schema compile check. The schema must be at least a
      // plain object; ajv.compile() throws on anything else (string, number,
      // null, array). We don't enforce a $schema reference — a schema that
      // ajv accepts is valid for our purposes.
      if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
        res.status(400).json({
          error: 'invalid_schema',
          message: 'schema must be a JSON object',
        });
        return;
      }
      const ajv = new Ajv({ strict: false });
      try {
        ajv.compile(schema);
      } catch (err) {
        res.status(400).json({
          error: 'invalid_schema',
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      // Step 5 — register (idempotent on canonical hash).
      const result = await this.endpointSchemaRepo.register({
        schema_json: schema,
        operator_pubkey: auth.pubkey,
        signed_event_id: auth.event_id,
        name,
        content_type,
        registered_at: Math.floor(Date.now() / 1000),
      });

      logger.info(
        {
          schema_hash: result.schema_hash,
          operator: auth.pubkey.slice(0, 12),
          created: result.created,
          name: name ?? null,
        },
        'SchemaController: schema registered',
      );
      res.status(result.created ? 201 : 200).json({
        data: {
          schema_hash: result.schema_hash,
          created: result.created,
        },
      });
    } catch (err) {
      next(err);
    }
  };

  show = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const hashParam = req.params.hash;
      const hash = Array.isArray(hashParam) ? hashParam[0] : hashParam;
      if (!hash || !/^[a-f0-9]{64}$/.test(hash)) {
        res.status(400).json({ error: 'invalid_hash' });
        return;
      }
      const found = await this.endpointSchemaRepo.findByHash(hash);
      if (!found) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ data: found });
    } catch (err) {
      next(err);
    }
  };

  list = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const recent = await this.endpointSchemaRepo.listRecent(50);
      res.json({ data: recent });
    } catch (err) {
      next(err);
    }
  };
}
