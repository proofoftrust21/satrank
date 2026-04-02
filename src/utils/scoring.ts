// Shared scoring utilities
const POPULARITY_BONUS_CAP = 10;

/** Popularity bonus: log2-scaled, capped at 10 points */
export function computePopularityBonus(queryCount: number): number {
  if (queryCount <= 0) return 0;
  return Math.min(POPULARITY_BONUS_CAP, Math.round(Math.log2(queryCount + 1) * 2));
}
