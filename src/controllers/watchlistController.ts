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

      // Cache key = targets hash + since bucketed to 5-min precision.
      // Behavior guarantees:
      //   - Staleness upper bound: WATCHLIST_CACHE_TTL_MS (60s) after a verdict change.
      //     Polls within the same 5-min bucket share the cache; the entry refreshes
      //     every 60s via stale-while-revalidate (first caller after TTL serves stale
      //     and triggers background refresh).
      //   - Bucket crossing: every 5 min the cache key changes → next poll is a cold
      //     miss → fresh DB query. New bucket seeds from the exact since the caller
      //     supplied.
      //   - Cache sharing: two agents polling the same targets with different since
      //     values in the same bucket will see the cached result seeded by whichever
      //     poll arrived first. Both receive changes going back to the first poll's
      //     `since` — always a superset. Agents should dedupe by changedAt > their
      //     last-seen timestamp.
      //   - meta.effectiveSince is echoed in the response so the agent knows which
      //     `since` was actually used for the DB query.
      const sortedHashes = [...hashes].sort();
      const sinceBucket = Math.floor(since / SINCE_BUCKET_SEC);
      const cacheKey = `watchlist:${crypto.createHash('sha256').update(sortedHashes.join(',')).digest('hex').slice(0, 16)}:${sinceBucket}`;

      const cached = cache.getOrCompute(cacheKey, WATCHLIST_CACHE_TTL_MS, () => {
        const snapshots = this.snapshotRepo.findChangedSince(hashes, since);
        const changes = snapshots.map(snap => {
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
        return { changes, effectiveSince: since };
      });

      res.json({
        data: cached.changes,
        meta: {
          since,
          effectiveSince: cached.effectiveSince,
          queriedAt: Math.floor(Date.now() / 1000),
          targets: hashes.length,
          changed: cached.changes.length,
          cacheBucketSec: SINCE_BUCKET_SEC,
          cacheTtlMs: WATCHLIST_CACHE_TTL_MS,
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
