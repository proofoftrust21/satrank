// Health, stats, and version endpoint controller
import type { Request, Response, NextFunction } from 'express';
import type { StatsService } from '../services/statsService';
import { VERSION } from '../version';

export class HealthController {
  constructor(private statsService: StatsService) {}

  getHealth = (_req: Request, res: Response, next: NextFunction): void => {
    try {
      res.json({ data: this.statsService.getHealth() });
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
    res.json({ data: VERSION });
  };
}
