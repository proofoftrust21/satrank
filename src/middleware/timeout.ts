// Request timeout middleware — returns 504 if a request exceeds the configured duration
import type { Request, Response, NextFunction } from 'express';

export function requestTimeout(ms: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        res.status(504).json({
          error: {
            code: 'GATEWAY_TIMEOUT',
            message: 'Request timed out',
          },
          requestId: req.requestId,
        });
      }
    }, ms);

    res.on('close', () => clearTimeout(timer));
    next();
  };
}
