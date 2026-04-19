// Validation et normalisation des catégories de services.
//
// Phase 5 — /api/intent impose une forme stricte sur la colonne
// `service_endpoints.category`. Pas de table dédiée ni d'enum figé (la liste
// vivante des catégories = `findCategories()` au moment de la requête), mais
// un garde-fou regex à l'ingest empêche les valeurs parasites d'entrer.
//
// Sources d'ingest couvertes par ce module :
//   - self-register (`serviceRegisterController.register`) → 400 sur invalid
//   - crawler 402index (`registryCrawler.run`) → skip + warn sur invalid
//
// Regex : commence par une lettre bas-casse, 2-32 chars parmi [a-z0-9/_-].
// Les 22 valeurs en prod au 2026-04-19 matchent toutes (data, data/finance,
// ai/text, bitcoin, …).

/** Forme canonique d'une catégorie valide. Longueur totale ∈ [2, 32]. */
export const CATEGORY_REGEX = /^[a-z][a-z0-9/_-]{1,31}$/;

/** Alias historiques repris du crawler (v26). Lookup avant le regex — si la
 *  valeur brute (lowercased) est une clé connue, on la remplace par la forme
 *  canonique associée. */
const CATEGORY_ALIASES: Record<string, string> = {
  'ai': 'ai',
  'ai/ml': 'ai',
  'ai/llm': 'ai',
  'ai/agents': 'ai',
  'ai/embeddings': 'ai',
  'data': 'data',
  'data/oracle': 'data',
  'real-time-data': 'data',
  'crypto/prices': 'data',
  'tools': 'tools',
  'tools/directory': 'tools',
  'bitcoin': 'bitcoin',
  'lightning': 'bitcoin',
  'media': 'media',
  'social': 'social',
  'earn/cashback': 'earn',
  'earn/optimization': 'earn',
};

/** Prédicat pur — vérifie qu'une string matche la forme canonique. */
export function isValidCategoryFormat(value: string): boolean {
  return CATEGORY_REGEX.test(value);
}

/** Normalise une catégorie brute : trim + lowercase + application des alias.
 *  Ne valide pas le format — utiliser `validateCategoryOrNull()` pour ça. */
export function normalizeCategory(raw: string | undefined | null): string | null {
  if (raw == null) return null;
  const key = raw.trim().toLowerCase();
  if (key.length === 0) return null;
  return CATEGORY_ALIASES[key] ?? key;
}

/** Pipeline complet d'ingest — normalise puis valide. Retourne la forme
 *  canonique si valide, `null` sinon (input absent OU format rejeté par le
 *  regex). Utilisé par le crawler (skip silencieux) et le validator zod. */
export function validateCategoryOrNull(raw: string | undefined | null): string | null {
  const normalized = normalizeCategory(raw);
  if (normalized == null) return null;
  if (!isValidCategoryFormat(normalized)) return null;
  return normalized;
}
