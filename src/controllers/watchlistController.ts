// Watchlist controller — poll for verdict changes on a set of targets
// Free endpoint. Agents use this as a fallback when Nostr subscription is not available.
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { AgentRepository } from '../repositories/agentRepository';
import type { SnapshotRepository } from '../repositories/snapshotRepository';
import type { AgentService } from '../services/agentService';
import { formatZodError } from '../utils/zodError';
import { ValidationError } from '../errors';
import { cache } from '../cache/cacheProvider';
import { watchlistChanges } from '../middleware/metrics';
import { config } from '../config';

/** HMAC key for deterministic-but-unpredictable watchlist cache keys.
 *  Derived once from API_KEY so every instance of the app using the same
 *  API_KEY reuses the same cache namespace. If API_KEY is unset (dev/tests),
 *  falls back to a random per-process key — caches do not survive restart,
 *  but that's acceptable in dev. Audit H9 closes: cache keys are no longer
 *  attacker-enumerable by simply knowing a user's target list. */
const WATCHLIST_HMAC_KEY: string = config.API_KEY ?? crypto.randomBytes(32).toString('hex');

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
    private agentService: AgentService,
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
      // HMAC-SHA256 instead of plain SHA256 (audit H9). Without the server-
      // side secret, an attacker cannot pre-compute cache keys for a known
      // target list — even after C4's full-digest fix, predictable keys
      // meant the attacker could deterministically enumerate any target
      // set they suspected a user of watching. HMAC removes that.
      const cacheKey = `watchlist:${crypto.createHmac('sha256', WATCHLIST_HMAC_KEY).update(sortedHashes.join(',')).digest('hex')}:${sinceBucket}`;

      const cached = cache.getOrCompute(cacheKey, WATCHLIST_CACHE_TTL_MS, () => {
        // Change-detection is now on the posterior: findChangedSince surfaces
        // agents whose p_success moved by ≥ 0.005 since the watcher's last sync.
        const snapshots = this.snapshotRepo.findChangedSince(hashes, since);
        let up = 0, down = 0, fresh = 0;
        const changes = snapshots.map(snap => {
          const agent = this.agentRepo.findByHash(snap.agent_hash);
          const bayesian = this.agentService.toBayesianBlock(snap.agent_hash);
          if (snap.previous_p_success === null) fresh++;
          else if (snap.p_success > snap.previous_p_success) up++;
          else if (snap.p_success < snap.previous_p_success) down++;
          return {
            publicKeyHash: snap.agent_hash,
            alias: agent?.alias ?? null,
            bayesian,
            changedAt: snap.computed_at,
          };
        });
        if (up > 0) watchlistChanges.inc({ direction: 'up' }, up);
        if (down > 0) watchlistChanges.inc({ direction: 'down' }, down);
        if (fresh > 0) watchlistChanges.inc({ direction: 'fresh' }, fresh);
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

