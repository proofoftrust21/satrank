// Rank correlation utilities — utilisées par compareLegacyVsBayesian.ts pour
// valider que le nouveau ranking préserve l'ordre relatif (τ ≥ 0.90).
//
// Kendall τ-b (version avec correction des égalités) implémentée en O(n²) —
// suffisant pour le top-500 (< 125k comparaisons). Pour un passage à l'échelle
// plus large, passer à l'algo Knight 1966 en O(n log n).

export interface KendallResult {
  /** Kendall τ-b normalisé avec correction des égalités dans (0, 1]. Peut être négatif si anti-corrélation. */
  tau: number;
  /** Nombre de paires concordantes */
  concordant: number;
  /** Nombre de paires discordantes */
  discordant: number;
  /** Nombre de paires à égalité sur x uniquement */
  tiesX: number;
  /** Nombre de paires à égalité sur y uniquement */
  tiesY: number;
  /** Paires à égalité sur x ET y (non comptées) */
  tiesBoth: number;
  /** Nombre total de paires = n(n-1)/2 */
  totalPairs: number;
}

/** Kendall τ-b sur deux séries de même longueur.
 *
 *  τ-b corrige les égalités : τ = (C − D) / sqrt((C+D+Tx)(C+D+Ty))
 *  où C=concordant, D=discordant, Tx/Ty=paires à égalité sur une seule variable.
 *
 *  Retourne τ dans [-1, 1]. +1 = ordres identiques, -1 = ordres inverses,
 *  0 = indépendants. */
export function kendallTau(xs: readonly number[], ys: readonly number[]): KendallResult {
  if (xs.length !== ys.length) {
    throw new Error(`kendallTau: length mismatch xs=${xs.length} ys=${ys.length}`);
  }
  const n = xs.length;
  if (n < 2) {
    return { tau: 0, concordant: 0, discordant: 0, tiesX: 0, tiesY: 0, tiesBoth: 0, totalPairs: 0 };
  }

  let concordant = 0;
  let discordant = 0;
  let tiesX = 0;
  let tiesY = 0;
  let tiesBoth = 0;

  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = xs[i] - xs[j];
      const dy = ys[i] - ys[j];
      if (dx === 0 && dy === 0) {
        tiesBoth++;
      } else if (dx === 0) {
        tiesX++;
      } else if (dy === 0) {
        tiesY++;
      } else if (Math.sign(dx) === Math.sign(dy)) {
        concordant++;
      } else {
        discordant++;
      }
    }
  }

  const totalPairs = (n * (n - 1)) / 2;
  const denom = Math.sqrt((concordant + discordant + tiesX) * (concordant + discordant + tiesY));
  const tau = denom === 0 ? 0 : (concordant - discordant) / denom;

  return { tau, concordant, discordant, tiesX, tiesY, tiesBoth, totalPairs };
}

/** Utilitaire : dérive un vecteur de ranks depuis une liste de valeurs.
 *  Ranks = positions 1..n après tri décroissant. Les égalités reçoivent un rank moyen.
 *  Utile quand on veut comparer deux ordres plutôt que deux séries brutes. */
export function toRanks(values: readonly number[]): number[] {
  const n = values.length;
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => b.v - a.v); // desc
  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n - 1 && indexed[j + 1].v === indexed[i].v) j++;
    const avgRank = (i + j) / 2 + 1; // 1-based rank moyen
    for (let k = i; k <= j; k++) {
      ranks[indexed[k].i] = avgRank;
    }
    i = j + 1;
  }
  return ranks;
}
