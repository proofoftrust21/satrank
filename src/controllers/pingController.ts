// Ping controller — real-time QueryRoutes check for any Lightning pubkey
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { LndGraphClient } from '../crawler/lndGraphClient';
import type { AgentRepository } from '../repositories/agentRepository';
import type { ProbeRepository } from '../repositories/probeRepository';
import { ValidationError } from '../errors';
import { sha256 } from '../utils/crypto';
import { logger } from '../logger';

const pubkeySchema = z.string().regex(/^(02|03)[a-f0-9]{64}$/, 'Expected 66-char Lightning pubkey (02/03 prefix)');
const DEFAULT_AMOUNT_SATS = 1000;
const QUERY_TIMEOUT_MS = 5000;

export class PingController {
  constructor(
    private lndClient?: LndGraphClient,
    private agentRepo?: AgentRepository,
    private probeRepo?: ProbeRepository,
  ) {}

  ping = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = pubkeySchema.safeParse(req.params.pubkey);
      if (!parsed.success) throw new ValidationError(parsed.error.errors[0].message);
      const pubkey = parsed.data;

      // Mark as hot node for priority probing
      const hash = sha256(pubkey);
      this.agentRepo?.touchLastQueried(hash);

      // Last probe age
      const lastProbe = this.probeRepo?.findLatest(hash);
      const lastProbeAgeMs = lastProbe ? (Date.now() - lastProbe.probed_at * 1000) : null;

      // Optional caller for personalized pathfinding
      const fromRaw = typeof req.query.from === 'string' ? req.query.from : undefined;
      let fromPubkey: string | undefined;
      if (fromRaw) {
        const fromParsed = pubkeySchema.safeParse(fromRaw);
        if (!fromParsed.success) throw new ValidationError('Invalid from pubkey: expected 66-char Lightning pubkey');
        fromPubkey = fromParsed.data;
      }

      if (!this.lndClient) {
        res.json({
          data: {
            pubkey,
            reachable: null,
            hops: null,
            totalFeeMsat: null,
            routeFound: false,
            fromCaller: !!fromPubkey,
            checkedAt: Math.floor(Date.now() / 1000),
            latencyMs: 0,
            lastProbeAgeMs: lastProbeAgeMs !== null ? Math.round(lastProbeAgeMs) : null,
            error: 'lnd_not_configured',
          },
        });
        return;
      }

      const startMs = Date.now();
      try {
        const response = await Promise.race([
          this.lndClient.queryRoutes(pubkey, DEFAULT_AMOUNT_SATS, fromPubkey),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('QueryRoutes timeout')), QUERY_TIMEOUT_MS)),
        ]);
        const latencyMs = Date.now() - startMs;

        const routes = response.routes ?? [];
        const hasRoute = routes.length > 0;

        const result = {
          pubkey,
          reachable: hasRoute,
          hops: hasRoute ? routes[0].hops.length : null,
          totalFeeMsat: hasRoute ? parseInt(routes[0].total_fees_msat, 10) || null : null,
          routeFound: hasRoute,
          fromCaller: !!fromPubkey,
          checkedAt: Math.floor(Date.now() / 1000),
          latencyMs,
          lastProbeAgeMs: lastProbeAgeMs !== null ? Math.round(lastProbeAgeMs) : null,
          error: hasRoute ? null : 'no_route',
        };

        logger.info({ pubkey: pubkey.slice(0, 12), reachable: hasRoute, hops: result.hops, latencyMs, from: fromPubkey?.slice(0, 12) }, 'Ping result');
        res.json({ data: result });
      } catch (err: unknown) {
        const latencyMs = Date.now() - startMs;
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ pubkey: pubkey.slice(0, 12), error: msg, latencyMs }, 'Ping failed');
        res.json({
          data: {
            pubkey,
            reachable: false,
            hops: null,
            totalFeeMsat: null,
            routeFound: false,
            fromCaller: !!fromPubkey,
            checkedAt: Math.floor(Date.now() / 1000),
            latencyMs,
            lastProbeAgeMs: lastProbeAgeMs !== null ? Math.round(lastProbeAgeMs) : null,
            error: msg.includes('timeout') ? 'timeout' : 'no_route',
          },
        });
      }
    } catch (err) {
      next(err);
    }
  };
}
