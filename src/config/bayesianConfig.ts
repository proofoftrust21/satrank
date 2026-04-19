// Bayesian scoring engine configuration — Phase 3.
// Toutes les constantes numériques du moteur de scoring bayésien vivent ici
// pour permettre un tuning centralisé sans toucher à la logique.
//
// Modèle : Beta-Binomial conjugué. Chaque cible (endpoint, node, service,
// operator, route) maintient un couple (α, β) par fenêtre temporelle. On
// dérive p_success = α / (α + β) et un intervalle de crédibilité à 95%.

// --- Prior hiérarchique ---
// Fallback flat quand aucun parent n'a de données suffisantes. 1.5/1.5
// est légèrement plus informatif qu'un uniforme (1/1) pour éviter la
// variance excessive sur n_obs faibles, tout en restant quasi-neutre.
export const DEFAULT_PRIOR_ALPHA = 1.5;
export const DEFAULT_PRIOR_BETA = 1.5;

/** Minimum n_obs qu'un niveau hiérarchique doit avoir pour qu'on l'adopte
 *  comme prior au niveau enfant. Sous ce seuil, on remonte d'un cran. */
export const MIN_N_OBS_FOR_PRIOR_INHERITANCE = 30;

// --- Fenêtres temporelles (LEGACY — à supprimer en fin de chaîne Phase 3) ---
// Trois horizons parallèles. L'auto-sélection prend la plus courte qui a
// atteint MIN_N_OBS_FOR_WINDOW — principe : réagir vite si on a des
// données fraîches, sinon se rabattre sur plus long.
// Ces constantes restent le temps que tous les callers basculent sur le
// modèle streaming. Les nouveaux callers doivent utiliser TAU_SECONDS.
export const WINDOW_24H_SEC = 24 * 3600;
export const WINDOW_7D_SEC = 7 * 24 * 3600;
export const WINDOW_30D_SEC = 30 * 24 * 3600;

export type BayesianWindow = '24h' | '7d' | '30d';

export const BAYESIAN_WINDOWS: readonly BayesianWindow[] = ['24h', '7d', '30d'] as const;

export const WINDOW_SECONDS: Record<BayesianWindow, number> = {
  '24h': WINDOW_24H_SEC,
  '7d': WINDOW_7D_SEC,
  '30d': WINDOW_30D_SEC,
};

/** Minimum n_obs pour qu'une fenêtre soit sélectionnable. */
export const MIN_N_OBS_FOR_WINDOW = 20;

/** Décroissance exponentielle legacy : τ = fenêtre / 3. Observation à t=τ → poids e⁻¹ ≈ 0.368. */
export const DECAY_TAU_FRACTION = 1 / 3;

// --- Streaming exponential (Phase 3 C1-C14) ---
// Modèle unique remplaçant les 3 fenêtres ci-dessus. Une paire (α, β) par
// (cible, source), décroissance exponentielle appliquée à la fois à
// l'ingestion (α ← α·exp(-Δt/τ)) et à la lecture (pour la cohérence temporelle).
// τ=7 jours donne un poids ≈ 0.368 à une observation d'il y a une semaine,
// ≈ 0.135 à deux semaines, ≈ 0.018 à un mois — se comporte comme un "7d glissant"
// mais sans effet de bord aux bornes de fenêtre.
export const TAU_DAYS = 7;
export const TAU_SECONDS = TAU_DAYS * 24 * 3600;

// --- Daily buckets (display-only) ---
/** Rétention des daily_buckets en jours — au-delà, purgés par cron. */
export const BUCKET_RETENTION_DAYS = 30;

// --- Risk profile (Option B : comparaison success_rate récent vs antérieur) ---
// Dérivé du delta success_rate(7j récents) - success_rate(23j antérieurs).
// low = stable ou en progrès, medium = léger déclin, high = dégradation marquée.
/** Fenêtre récente pour le calcul de tendance. */
export const RISK_PROFILE_RECENT_WINDOW_DAYS = 7;
/** Fenêtre antérieure pour comparaison (prev_N_days avant la fenêtre récente). */
export const RISK_PROFILE_PRIOR_WINDOW_DAYS = 23;
/** Delta en dessous duquel le profil est medium (légère dégradation). */
export const RISK_PROFILE_DELTA_MEDIUM = -0.10;
/** Delta en dessous duquel le profil est high (dégradation marquée). */
export const RISK_PROFILE_DELTA_HIGH = -0.25;
/** Minimum n_obs sur les deux fenêtres combinées avant de classer le risque.
 *  Sous ce seuil, le profil est 'unknown'. */
export const RISK_PROFILE_MIN_N_OBS = 5;

// --- Source weighting ---
// Trois sources distinctes, calculées en parallèle par cible.
export type BayesianSource = 'probe' | 'report' | 'paid';

/** Poids de base pour un sovereign probe (preuve on-chain / on-LN). */
export const WEIGHT_SOVEREIGN_PROBE = 1.0;

/** Poids de base pour un paid probe (double-check payant). */
export const WEIGHT_PAID_PROBE = 2.0;

/** Poids d'un agent_report selon le tier de confiance du reporter. */
export const WEIGHT_REPORT_LOW = 0.3;
export const WEIGHT_REPORT_MEDIUM = 0.5;
export const WEIGHT_REPORT_HIGH = 0.7;

/** NIP-98 authentifié (clé Nostr signée) = poids plein. */
export const WEIGHT_REPORT_NIP98 = 1.0;

// --- Verdict thresholds ---
// Mapping déterministe (p_success, ci95, n_obs, convergence) → verdict.

/** SAFE exige : p ≥ threshold ET ci95_low ≥ ci_low_min ET n_obs ≥ n_min ET convergence. */
export const SAFE_P_THRESHOLD = 0.80;
export const SAFE_CI95_LOW_MIN = 0.65;
export const SAFE_MIN_N_OBS = 10;

/** RISKY : p < threshold OU ci95_high < ci_high_max. Priorité RISKY > UNKNOWN. */
export const RISKY_P_THRESHOLD = 0.50;
export const RISKY_CI95_HIGH_MAX = 0.65;

/** UNKNOWN si intervalle trop large (incertitude) OU n_obs < minimum. */
export const UNKNOWN_CI95_INTERVAL_MAX = 0.40;
export const UNKNOWN_MIN_N_OBS = 10;

// --- Source convergence ---
/** Nombre minimum de sources qui doivent converger (p ≥ threshold) pour autoriser SAFE. */
export const CONVERGENCE_MIN_SOURCES = 2;

/** Seuil de probabilité au-dessus duquel une source compte dans la convergence. */
export const CONVERGENCE_P_THRESHOLD = 0.80;

// --- Cache ---
/** TTL du cache verdict en secondes. Les aggregates sont recomputés incrémentalement
 *  côté INSERT transaction ; le cache verdict évite juste de relire les agrégats. */
export const BAYESIAN_VERDICT_CACHE_TTL = 60;

// --- Validation ---
/** Seuil Kendall τ requis pour valider le switch bayésien vs legacy. */
export const KENDALL_TAU_THRESHOLD = 0.90;

/** Budget benchmark : N UPDATEs incrémentaux sur endpoint_aggregates. */
export const BENCHMARK_UPDATE_COUNT = 1000;
export const BENCHMARK_MAX_MS = 5000;
