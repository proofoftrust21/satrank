// Phase 12.5 (2026-05-05) — golden-set canary for ranking quality.
//
// Per audit semantic-rank-layer (lens L5 ops risk, finding "silent-quality-
// regression-undetected", impact 5) :
//   "If model file gets corrupted, ONNX version mismatches, or backfill cron
//    silently dies, ranking degrades but /api/intent still returns 200. No
//    mention of a quality canary."
//
// Audit must-change : "Ship golden-set quality canary (20 intent→endpoint
// pairs, recall@3 alert) on day 1 — this is non-negotiable for a ranking
// layer."
//
// Implementation : a small JSON fixture with (intent_text, category,
// expected_endpoint_substr) tuples. Every 5 minutes the canary calls the
// real intentService.resolveIntent (current ranker, current catalogue),
// checks if the expected substring is in any of the top-3 endpoint URLs,
// and emits a recall@3 metric. Below threshold → warn log + (future)
// alerting integration.
//
// V1 deliberately does NOT block /api/intent — observability first ;
// alarm + auto-fallback to legacy ranker is a P12.6 follow-up.

import { logger } from '../logger';
import type { IntentService } from './intentService';

export interface GoldenPair {
  intent_text: string;
  category: string;
  expected_endpoint_substr: string;
}

/** Golden-set fixture (compiled into the bundle).
 *  Initial 6 pairs from past Sim run verdicts. Each entry :
 *  (intent_text, category, expected_endpoint_substr). Substring matched
 *  case-insensitively against candidate endpoint URLs in the top-K of
 *  intentService.resolveIntent. Add more as new Sims surface gold-standard
 *  intents. */
export const GOLDEN_PAIRS: ReadonlyArray<GoldenPair> = [
  { intent_text: 'Bitcoin price OHLC realtime API', category: 'data/finance', expected_endpoint_substr: 'stock-quote' },
  { intent_text: 'summarize text content into a short brief', category: 'ai', expected_endpoint_substr: 'summarize' },
  { intent_text: 'classify text into categories', category: 'ai', expected_endpoint_substr: 'classify' },
  { intent_text: 'fetch federal economic data FRED series', category: 'data/finance', expected_endpoint_substr: 'fred' },
  { intent_text: 'currency exchange rate forex', category: 'data/finance', expected_endpoint_substr: 'currency' },
  { intent_text: 'Lightning Network mempool transactions', category: 'bitcoin', expected_endpoint_substr: 'mempool' },
];

export interface GoldenCanaryDeps {
  intentService: IntentService;
  pairs: ReadonlyArray<GoldenPair>;
  /** Default 0.7 ; below = warn-log alert. Tunable per environment. */
  alertThreshold?: number;
  /** Default 5 ; how many candidates to inspect for "expected match". */
  topK?: number;
  now?: () => number;
}

export interface CanaryResult {
  total: number;
  hits: number;
  recall_at_k: number;
  k: number;
  ranker_mode: string | null;
  per_pair: Array<{
    intent_text: string;
    category: string;
    expected: string;
    hit: boolean;
    top_urls: string[];
  }>;
  observed_at: number;
}

export class GoldenCanaryService {
  private readonly deps: GoldenCanaryDeps;
  private lastResult: CanaryResult | null = null;
  private readonly now: () => number;
  private readonly threshold: number;
  private readonly topK: number;

  constructor(deps: GoldenCanaryDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.threshold = deps.alertThreshold ?? 0.7;
    this.topK = deps.topK ?? 5;
  }

  /** Run every pair through resolveIntent (current ranker), measure
   *  recall@K. Stores last result for /api/oracle/canary-status. */
  async run(): Promise<CanaryResult> {
    const perPair: CanaryResult['per_pair'] = [];
    let hits = 0;
    for (const pair of this.deps.pairs) {
      try {
        const resp = await this.deps.intentService.resolveIntent(
          {
            category: pair.category,
            text: pair.intent_text,
          },
          this.topK,
          { fresh: false },
        );
        const topUrls = resp.candidates.slice(0, this.topK).map(c => c.endpoint_url);
        const hit = topUrls.some(u =>
          u.toLowerCase().includes(pair.expected_endpoint_substr.toLowerCase()),
        );
        if (hit) hits += 1;
        perPair.push({
          intent_text: pair.intent_text,
          category: pair.category,
          expected: pair.expected_endpoint_substr,
          hit,
          top_urls: topUrls,
        });
      } catch (err) {
        // Resolve failure on a single pair shouldn't break the canary.
        logger.warn(
          { pair, error: err instanceof Error ? err.message : String(err) },
          'GoldenCanary: resolveIntent threw on a pair',
        );
        perPair.push({
          intent_text: pair.intent_text,
          category: pair.category,
          expected: pair.expected_endpoint_substr,
          hit: false,
          top_urls: [],
        });
      }
    }
    const total = perPair.length;
    const recall = total > 0 ? hits / total : 0;
    const result: CanaryResult = {
      total,
      hits,
      recall_at_k: Math.round(recall * 1000) / 1000,
      k: this.topK,
      ranker_mode: process.env.RANKER_MODE ?? 'legacy',
      per_pair: perPair,
      observed_at: this.now(),
    };
    this.lastResult = result;
    if (recall < this.threshold) {
      logger.warn(
        {
          recall_at_k: result.recall_at_k,
          k: this.topK,
          hits,
          total,
          threshold: this.threshold,
          ranker_mode: result.ranker_mode,
        },
        'GoldenCanary: ranker recall below alert threshold',
      );
    } else {
      logger.info(
        { recall_at_k: result.recall_at_k, k: this.topK, hits, total, ranker_mode: result.ranker_mode },
        'GoldenCanary: ranker recall green',
      );
    }
    return result;
  }

  getLastResult(): CanaryResult | null {
    return this.lastResult;
  }
}
