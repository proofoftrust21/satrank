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
  ProxyFulfillInput,
  ProxyFulfillResult,
  ProxyFulfillQuoteResult,
  ProxyFulfillExecuteInput,
  EvidenceReceipt,
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

  /** SDK 1.3.0 — server-side fulfill proxy.
   *
   *  This is the Phase 1+ flow: the agent prepays SatRank with a deposit,
   *  signs an NIP-98 envelope binding the request, and SatRank pays the
   *  candidate operator on the agent's behalf. The proxy retries on
   *  failure, validates the body (heuristics + optional JSON Schema
   *  via expected_schema_hash), and returns the body OR refunds. The
   *  agent never touches Lightning, retries, macaroons, or pay-gap
   *  upstream — that's the indispensability primitive.
   *
   *  Five lines, end-to-end:
   *
   *    const sr = new SatRank({ apiBase: 'https://satrank.dev' });
   *    const auth = signNip98({ url: sr.fulfillEndpoint(), method: 'POST', body });
   *    const result = await sr.proxyFulfill({ ...body, authorization: auth });
   *    if (result.status === 'success') console.log(result.body);
   *    else console.warn('refunded:', result.reason);
   *
   *  The result is a discriminated union — switch on `result.status` to
   *  handle each business outcome. Genuine errors (auth invalid, network
   *  timeout) throw via SatRankError. See docs/FULFILL.md. */
  async proxyFulfill(input: ProxyFulfillInput): Promise<ProxyFulfillResult> {
    const { authorization, ...body } = input;
    return this.api.postFulfill(body, authorization);
  }

  /** SDK 1.3.0 — preview the cost of a proxyFulfill without engagement.
   *  No NIP-98 needed (the endpoint is read-only). Returns the top
   *  candidates with invoice + premium estimates and a `reserve_sats_max`
   *  the agent should pre-deposit before launching the actual fulfill. */
  async proxyFulfillQuote(input: {
    intent: ProxyFulfillInput['intent'];
    max_sats: number;
  }): Promise<ProxyFulfillQuoteResult> {
    return this.api.postFulfillQuote(input);
  }

  /** SDK 1.3.0 — canonical URL for proxyFulfill's NIP-98 `u` tag. */
  fulfillEndpoint(): string {
    return `${this.options.apiBase}/api/fulfill`;
  }

  /** SDK 1.4.0 — second step of hold-invoice fulfill (Phase 6).
   *
   *  After proxyFulfill({mode:'hold'}) returns {status:'hold_invoice_required'},
   *  the agent pays the BOLT11 with their wallet, then calls this to trigger
   *  the orchestrator. The intent must be re-supplied (server stores
   *  intent_hash, not the full intent shape, between the two calls).
   *
   *  Returns the same discriminated ProxyFulfillResult as proxyFulfill —
   *  switch on `result.status` for success / refunded / hold_invoice_required
   *  (still awaiting payment) / hold_mode_unavailable. */
  async proxyFulfillExecute(input: ProxyFulfillExecuteInput): Promise<ProxyFulfillResult> {
    return this.api.postFulfillExecute(input.job_id, input.intent, input.authorization);
  }

  /** SDK 1.4.0 — canonical URL the NIP-98 `u` tag must contain when calling
   *  proxyFulfillExecute. The job_id comes from the prior proxyFulfill
   *  response (status='hold_invoice_required'). */
  fulfillExecuteEndpoint(jobId: string): string {
    return `${this.options.apiBase}/api/fulfill/${encodeURIComponent(jobId)}/execute`;
  }

  /** SDK 1.5.0 (Phase 8.3) — fetch the SatRank-signed evidence receipt for
   *  a successful fulfill_jobs.job_id. Receipt binds preimage + body_sha256
   *  + intent_hash + operator_pubkey + timestamps under SatRank's Ed25519
   *  identity. Verifiers fetch the public key from /.well-known/satrank-key
   *  and validate offline.
   *
   *  NIP-98 sign for `evidenceEndpoint(jobId)` with method='GET'. Body is empty.
   *  The receipt is lazy-issued + cached server-side, so re-calling returns
   *  the same signed bytes. */
  async evidence(input: { job_id: string; authorization: string }): Promise<EvidenceReceipt> {
    return this.api.getEvidence(input.job_id, input.authorization);
  }

  /** SDK 1.5.0 — canonical URL agents must sign in their NIP-98 `u` tag for
   *  evidence(). */
  evidenceEndpoint(jobId: string): string {
    return `${this.options.apiBase}/api/fulfill/${encodeURIComponent(jobId)}/evidence`;
  }

  _options(): Readonly<InternalOptions> {
    return this.options;
  }

  _api(): ApiClient {
    return this.api;
  }
}
