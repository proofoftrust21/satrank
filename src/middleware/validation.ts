// Zod validation schemas for API inputs
import { z } from 'zod';

export const publicKeyHashSchema = z.string().regex(/^[a-f0-9]{64}$/, 'Invalid SHA256 hash (expected 64 hex characters)');

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const createAttestationSchema = z.object({
  txId: z.string().uuid('txId must be a valid UUID'),
  attesterHash: publicKeyHashSchema,
  subjectHash: publicKeyHashSchema,
  score: z.number().int().min(0).max(100),
  tags: z.array(z.string().max(50).regex(/^[\w\-]+$/, 'Invalid tag')).max(10).optional(),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

export const searchQuerySchema = z.object({
  alias: z.string().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const topQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
