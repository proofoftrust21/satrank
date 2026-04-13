// Zod validation schemas for API inputs
import { z } from 'zod';
import { VALID_PROVIDERS } from '../config/walletProviders';

export const publicKeyHashSchema = z.string().regex(/^[a-f0-9]{64}$/, 'Invalid SHA256 hash (expected 64 hex characters)');

// Accepts both a 64-char SHA256 hash and a 66-char compressed Lightning pubkey (02/03 prefix)
export const agentIdentifierSchema = z.string().regex(
  /^(?:[a-f0-9]{64}|(02|03)[a-f0-9]{64})$/,
  'Expected 64-char SHA256 hash or 66-char Lightning pubkey (02/03 prefix)',
);

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const attestationCategoryValues = ['successful_transaction', 'failed_transaction', 'dispute', 'fraud', 'unresponsive', 'general'] as const;

export const createAttestationSchema = z.object({
  txId: z.string().uuid('txId must be a valid UUID'),
  attesterHash: publicKeyHashSchema,
  subjectHash: publicKeyHashSchema,
  score: z.number().int().min(0).max(100),
  tags: z.array(z.string().max(50).regex(/^[\w\-]+$/, 'Invalid tag')).max(10).optional(),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  category: z.enum(attestationCategoryValues).default('general'),
});

export const searchQuerySchema = z.object({
  alias: z.string().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const batchVerdictsSchema = z.object({
  hashes: z.array(agentIdentifierSchema).min(1).max(100),
});

const sortByValues = ['score', 'volume', 'reputation', 'seniority', 'regularity', 'diversity'] as const;

export const topQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  sort_by: z.enum(sortByValues).default('score'),
});

// --- v2 schemas ---

const lnPubkeySchema = z.string().regex(/^(02|03)[a-f0-9]{64}$/, '66-char compressed Lightning pubkey (02/03 prefix)');

export const decideSchema = z.object({
  target: agentIdentifierSchema,
  caller: agentIdentifierSchema,
  amountSats: z.number().int().positive().optional(),
  walletProvider: z.enum(VALID_PROVIDERS as [string, ...string[]]).optional(),
  callerNodePubkey: lnPubkeySchema.optional(),
});

export const bestRouteSchema = z.object({
  targets: z.array(agentIdentifierSchema).min(1).max(50),
  caller: agentIdentifierSchema,
  amountSats: z.number().int().positive().optional(),
});

const reportOutcomeValues = ['success', 'failure', 'timeout'] as const;

export const reportSchema = z.object({
  target: agentIdentifierSchema,
  reporter: agentIdentifierSchema,
  outcome: z.enum(reportOutcomeValues),
  // L4: reject all-zero values
  paymentHash: z.string().regex(/^[a-f0-9]{64}$/).refine(v => v !== '0'.repeat(64), 'All-zero paymentHash rejected').optional(),
  preimage: z.string().regex(/^[a-f0-9]{64}$/).refine(v => v !== '0'.repeat(64), 'All-zero preimage rejected').optional(),
  amountBucket: z.enum(['micro', 'small', 'medium', 'large']).optional(),
  // S6: reject control characters in memo
  memo: z.string().max(280).regex(/^[^\x00-\x1f]*$/, 'Memo must not contain control characters').optional(),
}).refine(
  // S5: preimage requires paymentHash
  (data) => !data.preimage || !!data.paymentHash,
  { message: 'preimage requires paymentHash', path: ['preimage'] },
);
