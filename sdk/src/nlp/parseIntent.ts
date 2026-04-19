// parseIntent() — deterministic English-only natural-language → structured
// Intent. Zero runtime deps, no LLM. Designed as a convenience for agents
// whose upstream prompt is plain text; anything sophisticated (multi-turn,
// translation, fuzzy resolution) stays the agent's job.
//
// Scope (SDK 1.0):
//  - category match: prefix/substring/keyword against the server-provided list
//  - keywords: stopword-filtered content words (≤5)
//  - budget_sats: "X sats" / "$X" / "under/max/up to X sats"
//  - max_latency_ms: "fast/urgent/quick", "within Xs", "under X seconds", "< Xms"
//
// Explicit non-goals: FR/multilingual (Phase 6bis), tokenizer-grade NLP,
// semantic embeddings, LLM calls. If the agent wants better parsing, it
// should do that upstream and call sr.fulfill() with a structured Intent.

import type { Intent } from '../types';

export interface ParseIntentOptions {
  /** Known server categories — feeds the matcher. Fetch via sr.listCategories(). */
  categories: string[];
  /** Optional synonyms: map from a user phrase to an official category.
   *  Example: `{ "weather forecast": "data" }`. Lowercased before matching. */
  synonyms?: Record<string, string>;
}

export interface ParsedIntent {
  intent: Intent;
  /** Alternative category matches when the top score is close to runner-up. */
  ambiguous_categories?: string[];
  /** Confidence 0–1 for the top-ranked category match. 0 = no match. */
  category_confidence: number;
}

const STOPWORDS_EN = new Set<string>([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'he', 'she', 'it', 'its',
  'they', 'them', 'their', 'this', 'that', 'these', 'those',
  'and', 'or', 'but', 'if', 'then', 'else', 'so', 'because', 'as', 'of', 'at',
  'by', 'for', 'with', 'about', 'against', 'between', 'into', 'through',
  'during', 'before', 'after', 'above', 'below', 'to', 'from', 'up', 'down',
  'in', 'out', 'on', 'off', 'over', 'under', 'again', 'further', 'once',
  'here', 'there', 'when', 'where', 'why', 'how',
  'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
  'no', 'nor', 'not', 'only', 'own', 'same', 'than', 'too', 'very',
  'can', 'will', 'just', 'don', 'should', 'now', 'would', 'could', 'must',
  'do', 'does', 'did', 'doing', 'have', 'has', 'had', 'having',
  'get', 'got', 'give', 'given', 'need', 'needs', 'want', 'wants',
  'please', 'want', 'look', 'looking', 'find', 'show', 'tell', 'ask',
  'thanks', 'thank', 'hi', 'hello', 'hey',
  // Intent-shaping words we explicitly consume via regex — no value as keywords.
  'sats', 'sat', 'satoshi', 'satoshis', 'fast', 'quick', 'urgent', 'slow',
  'cheap', 'budget', 'under', 'max', 'within', 'seconds', 'second', 'ms',
  'pay', 'paying', 'cost', 'costs', 'price', 'priced', 'around', 'about',
  'service', 'services', 'api',
]);

const BUDGET_PATTERNS: RegExp[] = [
  // "under/up to/max/at most/below 500 sats"
  /(?:under|up\s+to|max(?:imum)?|at\s+most|below|less\s+than)\s+(\d[\d_,]*)\s*(?:sat|sats|satoshi|satoshis)\b/i,
  // "for 100 sats" / "pay 100 sats" / "budget of 100 sats" / "100 sats"
  /(?:for|pay|paying|budget(?:\s+of)?|cost(?:\s+of)?|price)?\s*(\d[\d_,]*)\s*(?:sat|sats|satoshi|satoshis)\b/i,
  // "$5" (rough ≈ 5 * 1000 sats is out of scope — treat $ as literal sats for SDK purposes)
];

const LATENCY_PATTERNS: RegExp[] = [
  // "within 3 seconds" / "under 3 seconds" / "in 3 seconds"
  /(?:within|under|in|less\s+than|at\s+most)\s+(\d[\d_,]*)\s*(?:s|sec|secs|second|seconds)\b/i,
  // "under 500ms" / "<500ms"
  /(?:under\s+|below\s+|less\s+than\s+|<\s*)(\d[\d_,]*)\s*ms\b/i,
];

const LATENCY_KEYWORDS: Array<{ match: RegExp; ms: number }> = [
  { match: /\b(?:urgent|asap|right\s+now|immediately)\b/i, ms: 1000 },
  { match: /\b(?:fast|quick|quickly|speedy|snappy|low[-\s]?latency)\b/i, ms: 2000 },
];

function parseIntAbbrev(raw: string): number {
  return parseInt(raw.replace(/[_,]/g, ''), 10);
}

function extractBudget(text: string): number | undefined {
  for (const re of BUDGET_PATTERNS) {
    const m = re.exec(text);
    if (m && m[1]) {
      const n = parseIntAbbrev(m[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return undefined;
}

function extractLatency(text: string): number | undefined {
  const ms = /(?:under\s+|below\s+|less\s+than\s+|<\s*)(\d[\d_,]*)\s*ms\b/i.exec(text);
  if (ms && ms[1]) return parseIntAbbrev(ms[1]);
  const sec = /(?:within|under|in|less\s+than|at\s+most)\s+(\d[\d_,]*)\s*(?:s|sec|secs|second|seconds)\b/i.exec(
    text,
  );
  if (sec && sec[1]) return parseIntAbbrev(sec[1]) * 1000;
  for (const { match, ms: ms2 } of LATENCY_KEYWORDS) {
    if (match.test(text)) return ms2;
  }
  return undefined;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s/_-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function scoreCategory(
  categoryName: string,
  inputTokens: string[],
  joinedInput: string,
): number {
  const catLower = categoryName.toLowerCase();
  // 1.0 if the full category string (incl. "/") appears verbatim.
  if (joinedInput.includes(catLower)) return 1.0;
  // Split "ai/code" → ["ai", "code"] and measure how many parts are present.
  const parts = catLower.split(/[\/_-]/).filter((p) => p.length > 1);
  if (parts.length === 0) return 0;
  let hits = 0;
  for (const p of parts) {
    if (inputTokens.includes(p)) hits += 1;
  }
  return hits / parts.length;
}

function resolveCategory(
  text: string,
  tokens: string[],
  categories: string[],
  synonyms: Record<string, string> | undefined,
): {
  category: string;
  confidence: number;
  ambiguous?: string[];
} {
  const joined = text.toLowerCase();
  // Synonyms are the highest-priority signal — exact phrase match wins.
  if (synonyms) {
    for (const [phrase, cat] of Object.entries(synonyms)) {
      if (joined.includes(phrase.toLowerCase())) {
        return { category: cat, confidence: 1.0 };
      }
    }
  }

  const scored = categories
    .map((c) => ({ cat: c, score: scoreCategory(c, tokens, joined) }))
    // Primary: score desc. Tiebreak: longer (more specific) category wins —
    // "ai/code" beats "ai" when both score 1.0 on "ai/code helper…".
    .sort((a, b) => b.score - a.score || b.cat.length - a.cat.length);

  if (scored.length === 0 || scored[0].score === 0) {
    return { category: '', confidence: 0 };
  }

  const top = scored[0];
  const runnerUp = scored[1];
  const ambiguous: string[] = [];

  if (runnerUp && runnerUp.score > 0 && top.score - runnerUp.score < 0.15) {
    for (const s of scored) {
      if (s.score > 0 && top.score - s.score < 0.15) ambiguous.push(s.cat);
    }
  }

  return {
    category: top.cat,
    confidence: Number(top.score.toFixed(3)),
    ambiguous: ambiguous.length > 1 ? ambiguous : undefined,
  };
}

function extractKeywords(
  tokens: string[],
  category: string,
): string[] {
  const catParts = new Set(category.toLowerCase().split(/[\/_-]/).filter(Boolean));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (t.length < 3) continue; // drop "a", "is", tiny connectors
    if (/^\d+$/.test(t)) continue; // pure numbers handled elsewhere
    if (STOPWORDS_EN.has(t)) continue;
    if (catParts.has(t)) continue; // don't duplicate category parts
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 5) break;
  }
  return out;
}

export function parseIntent(
  input: string,
  opts: ParseIntentOptions,
): ParsedIntent {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error('parseIntent: input must be a non-empty string');
  }
  if (!Array.isArray(opts.categories)) {
    throw new Error('parseIntent: opts.categories must be an array');
  }

  const text = input.trim();
  const tokens = tokenize(text);
  const { category, confidence, ambiguous } = resolveCategory(
    text,
    tokens,
    opts.categories,
    opts.synonyms,
  );
  const keywords = extractKeywords(tokens, category);
  const budget_sats = extractBudget(text);
  const max_latency_ms = extractLatency(text);

  const intent: Intent = {
    category,
    ...(keywords.length > 0 ? { keywords } : {}),
    ...(budget_sats !== undefined ? { budget_sats } : {}),
    ...(max_latency_ms !== undefined ? { max_latency_ms } : {}),
  };

  const result: ParsedIntent = {
    intent,
    category_confidence: confidence,
  };
  if (ambiguous) result.ambiguous_categories = ambiguous;
  return result;
}
