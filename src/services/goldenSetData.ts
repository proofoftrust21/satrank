// Phase 12.5 (2026-05-05) — golden-set fixture (compiled into the bundle).
//
// Initial 6 pairs from past Sim run verdicts. Add more as Sim 15+ surfaces
// new gold-standard intents. Each entry : (intent_text, category,
// expected_endpoint_substr). Substring matched case-insensitively against
// candidate endpoint URLs in the top-K of intentService.resolveIntent.

import type { GoldenPair } from './goldenCanaryService';

export const GOLDEN_PAIRS: ReadonlyArray<GoldenPair> = [
  {
    intent_text: 'Bitcoin price OHLC realtime API',
    category: 'data/finance',
    expected_endpoint_substr: 'stock-quote',
  },
  {
    intent_text: 'summarize text content into a short brief',
    category: 'ai',
    expected_endpoint_substr: 'summarize',
  },
  {
    intent_text: 'classify text into categories',
    category: 'ai',
    expected_endpoint_substr: 'classify',
  },
  {
    intent_text: 'fetch federal economic data FRED series',
    category: 'data/finance',
    expected_endpoint_substr: 'fred',
  },
  {
    intent_text: 'currency exchange rate forex',
    category: 'data/finance',
    expected_endpoint_substr: 'currency',
  },
  {
    intent_text: 'Lightning Network mempool transactions',
    category: 'bitcoin',
    expected_endpoint_substr: 'mempool',
  },
];
