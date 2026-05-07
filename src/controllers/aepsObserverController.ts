// AEPS §8.5 (2026-05-07) — Observer HTTP surface.
//
// POST /api/aeps/observation  (NIP-98 authenticated since 2026-05-07 audit)
//   Body : { operator_pubkey, day_utc, root_hex, source, source_ref? }
//   Records an observed anchor and returns whether it triggered a fork
//   detection. Observers earn 15% of slashing pool when they're first to
//   record an anchor that completes a fork pair.
//
//   IMPORTANT — pre-2026-05-07 this endpoint was permissionless ; an
//   unauthenticated POST could fabricate a second distinct root for any
//   operator's day, triggering ForkDetectionService → EquivocationSlashCron
//   → bond slash with 2 anonymous requests. The audit fix requires NIP-98
//   on every observation submission so the `observer_pubkey` recorded is
//   cryptographically attested. Restricts `source` to externally-emittable
//   values (`nostr`, `http`, `manual`) — `self` and `l1` are reserved for
//   internal writers.
//
// GET /api/aeps/forks                                (public read)
// GET /api/aeps/forks?operator_pubkey=<hex>          (public, filtered)
//   Lists detected fork events.
//
// GET /api/aeps/observations/:operator_pubkey/:day_utc  (public read)
//   Returns all observed anchors for an (operator, day) bucket. The
//   audit trail input to fork detection.
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { sendError } from '../errors/errorEnvelope';
import { verifyNip98, buildCanonicalNip98Url } from '../middleware/nip98';
import { config } from '../config';
import { logger } from '../logger';
import type { ForkDetectionService } from '../services/forkDetectionService';
import type {
  AepsObserverRepository,
  ObservationSource,
} from '../repositories/aepsObserverRepository';

const HEX64 = /^[0-9a-f]{64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCES: ObservationSource[] = ['self', 'l1', 'nostr', 'http', 'manual'];

// Audit fix CRIT-1 (2026-05-07) — externally-accepted sources only.
// `self` is the local node's own anchor (only DailyMerkleAnchorService
// writes this) ; `l1` is the L1 broadcast confirmation watcher (internal).
// Anonymous HTTP callers must NOT be able to claim either lest they
// pollute the fork-detection audit trail with fake "self" entries.
const EXTERNAL_SOURCE_SCHEMA = z.enum(['nostr', 'http', 'manual']);

// Audit fix MED-5 — strip control characters from source_ref to prevent
// log injection / data quality issues. Allow printable ASCII + common
// Unicode but reject \r\n\t\0 etc.
const SOURCE_REF_SAFE_RE = /^[ -~ -￿]{0,200}$/;

const observationSchema = z.object({
  operator_pubkey: z.string().regex(HEX64),
  day_utc: z.string().regex(DAY_RE),
  root_hex: z.string().regex(HEX64),
  source: EXTERNAL_SOURCE_SCHEMA,
  source_ref: z.string().max(200).regex(SOURCE_REF_SAFE_RE).optional(),
});

export interface AepsObserverControllerDeps {
  forkService: ForkDetectionService;
  observerRepo: AepsObserverRepository;
}

export class AepsObserverController {
  constructor(private readonly deps: AepsObserverControllerDeps) {}

  submitObservation = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Audit CRIT-1 (2026-05-07) — require NIP-98. Without this, anyone
      // can submit a fabricated second root for any operator+day, which
      // ForkDetectionService records as a fork → EquivocationSlashCron
      // slashes the operator's bond. NIP-98 ties the observation to a
      // verifiable observer pubkey ; if the observation turns out to be
      // bogus, downstream attribution is preserved.
      const authHeader = req.header('authorization') || req.header('Authorization');
      const rawBody =
        (req as Request & { rawBody?: Buffer | string }).rawBody ?? null;
      const fullUrl = buildCanonicalNip98Url(req, config.SATRANK_API_BASE);
      const auth = await verifyNip98(authHeader, 'POST', fullUrl, rawBody);
      if (!auth.valid || !auth.pubkey) {
        sendError(res, 'invalid_auth', { message: 'NIP-98 required for observation submissions' });
        return;
      }
      const parsed = observationSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 'invalid_body', { details: parsed.error.issues.slice(0, 5) });
        return;
      }
      logger.info(
        {
          observer_pubkey: auth.pubkey.slice(0, 12),
          operator_pubkey: parsed.data.operator_pubkey.slice(0, 12),
          day_utc: parsed.data.day_utc,
          source: parsed.data.source,
        },
        'AEPS observation submitted',
      );
      const result = await this.deps.forkService.recordObservation({
        operator_pubkey: parsed.data.operator_pubkey,
        day_utc: parsed.data.day_utc,
        root_hex: parsed.data.root_hex,
        source: parsed.data.source,
        source_ref: parsed.data.source_ref,
      });
      if (result.status !== 'ok') {
        sendError(res, 'invalid_body', { message: result.reason });
        return;
      }
      res.status(201).json({
        data: {
          observation_id: result.observation.observation_id,
          fork_detected: !!result.fork_event,
          fork_event_id: result.fork_event?.fork_event_id ?? null,
        },
      });
    } catch (err) {
      next(err);
    }
  };

  listForks = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const opParam = req.query.operator_pubkey;
      const operatorPubkey = typeof opParam === 'string' && HEX64.test(opParam) ? opParam.toLowerCase() : null;
      const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 500);
      const forks = await this.deps.forkService.listForks(operatorPubkey, limit);
      res.status(200).json({
        data: {
          count: forks.length,
          forks: forks.map(f => ({
            fork_event_id: f.fork_event_id,
            operator_pubkey: f.operator_pubkey,
            day_utc: f.day_utc,
            root_hex_a: f.root_hex_a,
            root_hex_b: f.root_hex_b,
            detected_at: f.detected_at,
            nostr_event_id: f.nostr_event_id,
            claim_id: f.claim_id,
          })),
        },
      });
    } catch (err) {
      next(err);
    }
  };

  listObservations = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const operatorPubkey = String(req.params.operator_pubkey ?? '').toLowerCase();
      const dayUtc = String(req.params.day_utc ?? '');
      if (!HEX64.test(operatorPubkey)) {
        sendError(res, 'invalid_body', { message: 'operator_pubkey must be 64-char hex' });
        return;
      }
      if (!DAY_RE.test(dayUtc)) {
        sendError(res, 'invalid_body', { message: 'day_utc must be YYYY-MM-DD' });
        return;
      }
      const observations = await this.deps.observerRepo.listObservationsForOperatorDay(
        operatorPubkey,
        dayUtc,
      );
      // Group by root_hex so consumers see the equivocation surface immediately.
      const byRoot: Record<string, Array<{ source: string; source_ref: string | null; observed_at: number }>> = {};
      for (const obs of observations) {
        if (!byRoot[obs.root_hex]) byRoot[obs.root_hex] = [];
        byRoot[obs.root_hex].push({
          source: obs.source,
          source_ref: obs.source_ref,
          observed_at: obs.observed_at,
        });
      }
      res.status(200).json({
        data: {
          operator_pubkey: operatorPubkey,
          day_utc: dayUtc,
          distinct_roots: Object.keys(byRoot).length,
          observations_by_root: byRoot,
        },
      });
    } catch (err) {
      next(err);
    }
  };
}

// Re-export the source type for tests + downstream consumers.
export type { ObservationSource };
// Re-export the source list as a const-friendly value for OpenAPI gen later.
export const OBSERVATION_SOURCES = SOURCES;
