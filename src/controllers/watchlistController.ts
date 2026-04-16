// Watchlist controller — poll for verdict changes on a set of targets
// Free endpoint. Agents use this as a fallback when Nostr subscription is not available.
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { AgentRepository } from '../repositories/agentRepository';
import type { SnapshotRepository } from '../repositories/snapshotRepository';
import type { ScoringService } from '../services/scoringService';
import { formatZodError } from '../utils/zodError';
import { ValidationError } from '../errors';
import { VERDICT_SAFE_THRESHOLD } from '../config/scoring';
import { cache } from '../cache/cacheProvider';

const VERDICT_UNKNOWN_THRESHOLD = 30;
const MAX_TARGETS = 50;
/** since is bucketed to 5-min precision for cache efficiency.
 *  An agent polling every minute hits the same bucket up to 5 times. */
const SINCE_BUCKET_SEC = 300;
const WATCHLIST_CACHE_TTL_MS = 60_000;

const watchlistSchema = z.object({
  targets: z.string().min(1, 'targets is required'),
  since: z.coerce.number().int().min(0).optional(),
});

export class WatchlistController {
  constructor(
    private agentRepo: AgentRepository,
    private snapshotRepo: SnapshotRepository,
    private scoringService: ScoringService,
  ) {}

  getChanges = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const parsed = watchlistSchema.safeParse(req.query);
      if (!parsed.success) throw new ValidationError(formatZodError(parsed.error, req.query));

      const hashes = parsed.data.targets.split(',').map(h => h.trim()).filter(Boolean);
      if (hashes.length > MAX_TARGETS) {
        throw new ValidationError(`Maximum ${MAX_TARGETS} targets per request, got ${hashes.length}`);
      }
      if (hashes.some(h => !/^[a-f0-9]{64}$/.test(h))) {
        throw new ValidationError('Each target must be a 64-char hex hash');
      }

      const since = parsed.data.since ?? 0;

      // Cache key: hashes (sorted for stability) + since bucket of 5 min.
      // Two polls with since=1776327000 and since=1776327200 share the cache
      // (both bucket to floor(.../300) = 5921090). This collapses N polling
      // agents on the same target list into a single DB query per bucket.
      const sortedHashes = [...hashes].sort();
      const sinceBucket = Math.floor(since / SINCE_BUCKET_SEC);
      const cacheKey = `watchlist:${crypto.createHash('sha256').update(sortedHashes.join(',')).digest('hex').slice(0, 16)}:${sinceBucket}`;

      const changes = cache.getOrCompute(cacheKey, WATCHLIST_CACHE_TTL_MS, () => {
        const snapshots = this.snapshotRepo.findChangedSince(hashes, since);
        return snapshots.map(snap => {
          const score = snap.score;
          const verdict = score >= VERDICT_SAFE_THRESHOLD ? 'SAFE' as const
            : score >= VERDICT_UNKNOWN_THRESHOLD ? 'UNKNOWN' as const : 'RISKY' as const;
          const agent = this.agentRepo.findByHash(snap.agent_hash);
          const components = safeParseJson(snap.components);
          return {
            publicKeyHash: snap.agent_hash,
            alias: agent?.alias ?? null,
            score,
            previousScore: snap.previous_score ?? null,
            verdict,
            components,
            changedAt: snap.computed_at,
          };
        });
      });

      res.json({
        data: changes,
        meta: {
          since,
          queriedAt: Math.floor(Date.now() / 1000),
          targets: hashes.length,
          changed: changes.length,
        },
      });
    } catch (err) {
      next(err);
    }
  };
}

function safeParseJson(val: string | null | undefined): Record<string, number> | null {
  if (!val) return null;
  try {
    const parsed = JSON.parse(val);
    return typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}
