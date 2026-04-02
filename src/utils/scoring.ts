// Shared scoring utilities
import { POPULARITY_BONUS_CAP, POPULARITY_LOG_MULTIPLIER } from '../config/scoring';

/** Popularity bonus: log2-scaled, capped at POPULARITY_BONUS_CAP points */
export function computePopularityBonus(queryCount: number): number {
  if (queryCount <= 0) return 0;
  return Math.min(POPULARITY_BONUS_CAP, Math.round(Math.log2(queryCount + 1) * POPULARITY_LOG_MULTIPLIER));
}
