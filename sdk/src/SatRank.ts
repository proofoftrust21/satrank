// Main class. C2: listCategories + resolveIntent go live. fulfill() still
// stubbed (lands in C5).

import { ApiClient } from './client/apiClient';
import { fulfillIntent } from './fulfill';
import type {
  FulfillOptions,
  FulfillResult,
  IntentCategoriesResponse,
  IntentResponse,
  RegisterInput,
  RegisterResponse,
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

  /** SDK 1.2.0 — operator self-listing of an L402 endpoint via NIP-98.
   *
   *  The SDK is zero-dep, so it does NOT bundle a Nostr signer. The caller
   *  signs a kind 27235 NIP-98 event externally (with `nostr-tools`,
   *  `noble-secp256k1`, or any other lib) and passes the resulting
   *  `Authorization: Nostr <base64-event>` header value as
   *  `input.authorization`.
   *
   *  The signed event MUST bind to the canonical URL the SDK will call:
   *    `${apiBase}/api/services/register`  (POST)
   *  and the `payload` tag MUST be `sha256(jsonBody)` where `jsonBody` is
   *  the request body produced by this SDK (the SDK strips `undefined`
   *  fields, so the agent must reconstruct the same JSON when computing
   *  the hash).
   *
   *  See `docs/sdk/register-tutorial.md` for a worked end-to-end example.
   *
   *  Errors thrown:
   *    - `Nip98InvalidError` (401, code NIP98_INVALID): missing / malformed
   *      / expired / replayed Authorization header.
   *    - `OwnershipMismatchError` (403, code OWNERSHIP_MISMATCH): the
   *      endpoint declares a different `nostr-pubkey` in WWW-Authenticate
   *      (audit Tier 4N — cryptographic ownership proof).
   *    - `AlreadyClaimedError` (409, code ALREADY_CLAIMED): the URL was
   *      already claimed by another npub under first-claim semantics.
   *    - `ValidationSatRankError` (400): URL is not a valid L402 endpoint
   *      (no 402 challenge, no decodable BOLT11). */
  async register(input: RegisterInput): Promise<RegisterResponse> {
    const { authorization, ...body } = input;
    const result = await this.api.postServicesRegister(body, authorization);
    return result.data;
  }

  /** SDK 1.2.0 — return the canonical URL clients must sign in their
   *  NIP-98 `u` tag when calling `register()`. Saves clients from
   *  hard-coding string concatenation themselves. */
  registerEndpoint(): string {
    return `${this.options.apiBase}/api/services/register`;
  }

  _options(): Readonly<InternalOptions> {
    return this.options;
  }

  _api(): ApiClient {
    return this.api;
  }
}
