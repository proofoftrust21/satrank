// Watchlist controller — poll for verdict changes on a set of targets
// Free endpoint. Agents use this as a fallback when Nostr subscription is not available.
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { AgentRepository } from '../repositories/agentRepository';
import type { SnapshotRepository } from '../repositories/snapshotRepository';
import type { ScoringService } from '../services/scoringService';
import { formatZodError } from '../utils/zodError';
import { ValidationError } from '../errors';
import { VERDICT_SAFE_THRESHOLD } from '../config/scoring';

const VERDICT_UNKNOWN_THRESHOLD = 30;
const MAX_TARGETS = 50;

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

      // Find snapshots that changed since the given timestamp
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
