// Phase 5.13 — Stage 5b body quality heuristics. Pure function, no I/O.
//
// Évalue si le body retourné par un recall L402 (Phase 5.12 stage 4) ressemble
// à un payload utile. NE remplace pas une schema validation (Phase 5.13 5a,
// déférée à OpenAPI scraping en Phase 5.11/B). Conçue pour distinguer :
//   - 200 OK + JSON structuré non vide → quality success
//   - 200 OK + body trivial ("{}", "null", "ok") → quality failure
//   - 200 OK + erreur applicative ("error", "limite atteinte") → quality failure
//   - 200 OK + placeholder ("lorem ipsum", "TODO") → quality failure
//
// Score : un check = 1 point. Threshold = 3/5 pour considérer "quality_ok".
// Caller traduit ça en stage 5 success/failure.

const ERROR_PATTERNS = [
  /\berror\b/i,
  /\bunavailable\b/i,
  /\binternal server error\b/i,
  /\brate.?limit/i,
  /\bunauthorized\b/i,
  /\bforbidden\b/i,
  /\bnot found\b/i,
  /\bquota.{0,15}exceeded\b/i,
  /\binsufficient\b/i,
];

const PLACEHOLDER_PATTERNS = [
  /\blorem ipsum\b/i,
  /\bdummy data\b/i,
  /\bplaceholder\b/i,
  /\bTODO\b/,
  /\bcoming soon\b/i,
  /\bunder construction\b/i,
];

const TRIVIAL_BODIES = new Set([
  '',
  '{}',
  '[]',
  'null',
  '""',
  'ok',
  'OK',
  'true',
  'false',
  '0',
]);

export interface BodyQualityResult {
  score: number; // 0-5
  passed: boolean; // score >= 3
  /** Détail des checks pour audit / log. */
  checks: {
    non_empty: boolean;
    non_trivial: boolean;
    no_error_pattern: boolean;
    no_placeholder: boolean;
    structured_when_json: boolean;
  };
}

export interface BodyQualityInput {
  body: string;
  contentType: string | null;
  /** Status HTTP du recall — si pas 2xx, on ne lance pas l'évaluation
   *  qualité (le caller a déjà classé delivery comme failure). Ce champ
   *  sert juste à ce que la function reste auto-contenue (caller peut
   *  appeler en aveugle, on retourne passed=false sur non-2xx). */
  status: number;
}

export function evaluateBodyQuality(input: BodyQualityInput): BodyQualityResult {
  // Un non-2xx ne devrait pas atteindre cette fonction depuis paidProbeRunner
  // (delivery déjà classé failure). Mais si jamais : passed=false, score=0.
  if (input.status < 200 || input.status >= 300) {
    return {
      score: 0,
      passed: false,
      checks: {
        non_empty: false,
        non_trivial: false,
        no_error_pattern: false,
        no_placeholder: false,
        structured_when_json: false,
      },
    };
  }

  const body = input.body.trim();
  const checks = {
    non_empty: body.length >= 10,
    non_trivial: !TRIVIAL_BODIES.has(body),
    no_error_pattern: !ERROR_PATTERNS.some(rx => rx.test(body)),
    no_placeholder: !PLACEHOLDER_PATTERNS.some(rx => rx.test(body)),
    structured_when_json: evaluateJsonStructure(body, input.contentType),
  };
  const score =
    Number(checks.non_empty) +
    Number(checks.non_trivial) +
    Number(checks.no_error_pattern) +
    Number(checks.no_placeholder) +
    Number(checks.structured_when_json);
  // Pass = score >= 3 ET aucun signal d'erreur/placeholder (hard requirements).
  // Un body avec "error" / "Lorem ipsum" est trompeur même si la structure
  // par ailleurs est correcte ; on doit le flagger comme low-quality.
  const passed =
    score >= 3 && checks.no_error_pattern && checks.no_placeholder;
  return { score, passed, checks };
}

/** Si content-type indique JSON, le body doit parser et contenir au moins un
 *  champ non-trivial. Si pas JSON, on considère "structured" comme true par
 *  défaut (un texte/markdown/CSV brut est légitime pour beaucoup d'endpoints). */
function evaluateJsonStructure(body: string, contentType: string | null): boolean {
  const isJson = contentType?.toLowerCase().includes('application/json') ?? false;
  if (!isJson) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (parsed === null) return false;
  if (Array.isArray(parsed)) return parsed.length > 0;
  if (typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return false;
    // Au moins une valeur non-empty
    return keys.some(k => {
      const v = obj[k];
      if (v == null) return false;
      if (typeof v === 'string') return v.length > 0;
      if (typeof v === 'number') return true;
      if (typeof v === 'boolean') return true;
      if (Array.isArray(v)) return v.length > 0;
      if (typeof v === 'object') return Object.keys(v).length > 0;
      return false;
    });
  }
  return true;
}
