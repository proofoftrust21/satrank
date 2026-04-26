// Main class. C2: listCategories + resolveIntent go live. fulfill() still
// stubbed (lands in C5).

import { ApiClient } from './client/apiClient';
import { fulfillIntent } from './fulfill';
import type {
  FulfillOptions,
  FulfillResult,
  IntentCategoriesResponse,
  IntentResponse,
  SatRankOptions,
} from './types';

interface InternalOptions {
  apiBase: string;
  request_timeout_ms: number;
  fetch: typeof fetch;
  depositToken?: string;
  caller?: string;
  wallet?: SatRankOptions['wallet'];
}

export class SatRank {
  private readonly options: InternalOptions;
  private readonly api: ApiClient;

  constructor(options: SatRankOptions) {
    if (!options.apiBase) {
      throw new Error('SatRank: apiBase is required');
    }
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new Error(
        'SatRank: no fetch available. Pass options.fetch in Node <18 or polyfill globalThis.fetch.',
      );
    }
    this.options = {
      apiBase: options.apiBase.replace(/\/$/, ''),
      request_timeout_ms: options.request_timeout_ms ?? 10_000,
      fetch: fetchImpl,
      depositToken: options.depositToken,
      caller: options.caller,
      wallet: options.wallet,
    };
    this.api = new ApiClient({
      apiBase: this.options.apiBase,
      fetch: this.options.fetch,
      request_timeout_ms: this.options.request_timeout_ms,
      depositToken: this.options.depositToken,
    });
  }

  async fulfill(opts: FulfillOptions): Promise<FulfillResult> {
    return fulfillIntent(
      {
        api: this.api,
        wallet: this.options.wallet,
        fetchImpl: this.options.fetch,
        defaultCaller: this.options.caller,
        depositToken: this.options.depositToken,
      },
      opts,
    );
  }

  async listCategories(): Promise<IntentCategoriesResponse> {
    return this.api.getIntentCategories();
  }

  async resolveIntent(input: {
    category: string;
    keywords?: string[];
    budget_sats?: number;
    max_latency_ms?: number;
    caller?: string;
    limit?: number;
    /** Mix A+D — paid path (2 sats via L402). The server runs a synchronous
     *  HTTP probe on the top candidates before returning so `health.last_probe_age_sec`
     *  is < 60s and `advisory.freshness_status === 'fresh'`. Default: false. */
    fresh?: boolean;
  }): Promise<IntentResponse> {
    const caller = input.caller ?? this.options.caller;
    return this.api.postIntent({ ...input, caller });
  }

  _options(): Readonly<InternalOptions> {
    return this.options;
  }

  _api(): ApiClient {
    return this.api;
  }
}
