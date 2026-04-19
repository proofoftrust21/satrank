// NLP helper — parseIntent() lands in C9. Importable subpath
// `@satrank/sdk/nlp` exists from C1 so docs/examples can reference it.
import type { Intent } from '../types';

export interface ParseIntentOptions {
  /** Known server categories — feeds fuzzy-matcher. Fetch via sr.listCategories(). */
  categories: string[];
  /** Preferred language for tokenization. Default 'auto' — heuristic detection. */
  lang?: 'auto' | 'fr' | 'en';
}

export interface ParsedIntent {
  intent: Intent;
  /** Fuzzy-matcher may return multiple candidate categories when ambiguous. */
  ambiguous_categories?: string[];
  /** Confidence in the top-ranked category match (0–1). */
  category_confidence: number;
}

export function parseIntent(
  _input: string,
  _opts: ParseIntentOptions,
): ParsedIntent {
  throw new Error('parseIntent: not implemented (landing in C9)');
}
