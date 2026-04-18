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

const httpUrlSchema = z.string().url().refine(url => {
  try { return ['http:', 'https:'].includes(new URL(url).protocol); }
  catch { return false; }
}, 'Only http:// and https:// URLs allowed');

// BOLT11 schema : accepts `lnbc...`, `lntb...`, `lntbs...`, `lnbcrt...`,
// bornée à 2048 caractères pour éviter des abuses. Le parsing fin (payment_hash,
// amount, network) est délégué à utils/bolt11Parser à la consommation.
const bolt11Schema = z.string().min(10).max(2048).regex(/^ln(bc|tb|tbs|bcrt)[a-z0-9]+$/i, 'BOLT11 must start with lnbc/lntb/lntbs/lnbcrt');

export const decideSchema = z.object({
  target: agentIdentifierSchema,
  caller: agentIdentifierSchema,
  amountSats: z.number().int().positive().optional(),
  walletProvider: z.enum(VALID_PROVIDERS as [string, ...string[]]).optional(),
  callerNodePubkey: lnPubkeySchema.optional(),
  serviceUrl: httpUrlSchema.optional(),
  // Phase 2 voie 2 : l'agent peut soumettre le BOLT11 de l'invoice qu'il est
  // sur le point de payer. S'il est valide, on pré-alimente preimage_pool
  // (tier='medium', source='intent') pour autoriser le report anonyme ultérieur.
  bolt11Raw: bolt11Schema.optional(),
});

export const bestRouteSchema = z.object({
  targets: z.array(agentIdentifierSchema).min(1).max(50),
  caller: agentIdentifierSchema,
  amountSats: z.number().int().positive().optional(),
  walletProvider: z.enum(VALID_PROVIDERS as [string, ...string[]]).optional(),
  callerNodePubkey: lnPubkeySchema.optional(),
  serviceUrls: z.record(publicKeyHashSchema, httpUrlSchema).optional(),
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

// Phase 2 voie 3 — anonymous report. Agent prouve sa preimage (sha256 =
// payment_hash présent dans preimage_pool) sans NIP-98 ni API-key. Pas de
// champ `reporter` : l'identité anonyme est dérivée du payment_hash. La
// preimage est fournie soit via header X-L402-Preimage (pattern L402 standard)
// soit dans body.preimage (fallback) — le middleware createReportDispatchAuth
// extrait les deux et pose req.anonymousPreimage. Donc la preimage est
// optional au niveau zod (validée format strict côté controller).
export const anonymousReportSchema = z.object({
  target: agentIdentifierSchema,
  outcome: z.enum(reportOutcomeValues),
  preimage: z.string().regex(/^[a-f0-9]{64}$/, 'preimage must be 64 hex chars').refine(v => v !== '0'.repeat(64), 'All-zero preimage rejected').optional(),
  bolt11Raw: bolt11Schema.optional(),
  amountBucket: z.enum(['micro', 'small', 'medium', 'large']).optional(),
  memo: z.string().max(280).regex(/^[^\x00-\x1f]*$/, 'Memo must not contain control characters').optional(),
});
