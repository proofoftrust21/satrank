// Health, stats, and version endpoint controller
import type { Request, Response, NextFunction } from 'express';
import type { StatsService } from '../services/statsService';
import { VERSION } from '../version';

export class HealthController {
  constructor(private statsService: StatsService) {}

  getHealth = (_req: Request, res: Response, next: NextFunction): void => {
    try {
      const health = this.statsService.getHealth();
      const status = health.status === 'ok' ? 200 : 503;
      res.status(status).json({ data: health });
    } catch (err) {
      next(err);
    }
  };

  getStats = (_req: Request, res: Response, next: NextFunction): void => {
    try {
      res.json({ data: this.statsService.getNetworkStats() });
    } catch (err) {
      next(err);
    }
  };

  getVersion = (_req: Request, res: Response): void => {
    // Version is immutable per build — let clients cache for 60s so status
    // pages polling every few seconds don't keep tripping the rate-limiter.
    // Sim #9 FINDING #13.
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({ data: VERSION });
  };
}
