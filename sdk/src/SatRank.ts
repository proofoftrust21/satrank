// Main class. C1 scaffolding: constructor stores options and the method
// signatures throw "not implemented". Logic lands in C2-C7.

import type {
  FulfillOptions,
  FulfillResult,
  IntentCategoriesResponse,
  IntentResponse,
  SatRankOptions,
} from './types';

export class SatRank {
  private readonly options: Required<
    Pick<SatRankOptions, 'apiBase' | 'request_timeout_ms'>
  > &
    SatRankOptions;

  constructor(options: SatRankOptions) {
    if (!options.apiBase) {
      throw new Error('SatRank: apiBase is required');
    }
    const apiBase = options.apiBase.replace(/\/$/, '');
    this.options = {
      ...options,
      apiBase,
      request_timeout_ms: options.request_timeout_ms ?? 10_000,
      fetch: options.fetch ?? globalThis.fetch,
    };
  }

  /** One-call discovery + payment + fulfillment. See FulfillOptions. */
  async fulfill(_opts: FulfillOptions): Promise<FulfillResult> {
    throw new Error('SatRank.fulfill: not implemented (landing in C5)');
  }

  /** Lightweight discovery — useful for NLP helpers that want the category enum. */
  async listCategories(): Promise<IntentCategoriesResponse> {
    throw new Error('SatRank.listCategories: not implemented (landing in C2)');
  }

  /** Direct passthrough to /api/intent for agents that want the raw candidates. */
  async resolveIntent(_intent: {
    category: string;
    keywords?: string[];
    budget_sats?: number;
    max_latency_ms?: number;
    caller?: string;
    limit?: number;
  }): Promise<IntentResponse> {
    throw new Error('SatRank.resolveIntent: not implemented (landing in C2)');
  }

  /** Exposed for tests and introspection — not part of the stable public API. */
  _options(): Readonly<SatRankOptions> {
    return this.options;
  }
}
