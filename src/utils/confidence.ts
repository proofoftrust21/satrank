// Canonical ConfidenceLevel → number (0-1) mapping used by every public API
// response. Sim #5 finding: /decide and /profile returned the string tier
// ('very_low' ...) while /verdicts returned the number. Normalized to number
// everywhere — agents parse a single type and ML pipelines can do arithmetic.
import type { ConfidenceLevel } from '../types';

export const CONFIDENCE_NUMERIC: Record<ConfidenceLevel, number> = {
  very_low: 0.1,
  low: 0.25,
  medium: 0.5,
  high: 0.75,
  very_high: 0.9,
};

export function confidenceToNumber(level: ConfidenceLevel): number {
  return CONFIDENCE_NUMERIC[level];
}
