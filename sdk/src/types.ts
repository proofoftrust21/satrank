// Public types for @satrank/sdk 1.0. Mirrors the shape of POST /api/intent
// on the server side — snake_case kept on the wire, exposed in this SDK as
// typed TS interfaces so agents get end-to-end static typing on fulfill().

/** Input intent an agent hands to the SDK. Only `category` is required; the
 *  rest narrow the candidate pool. */
export interface Intent {
  category: string;
  keywords?: string[];
  budget_sats?: number;
  max_latency_ms?: number;
}

export interface BayesianBlock {
  p_success: number;
  ci95_low: number;
  ci95_high: number;
  n_obs: number;
  verdict: 'SAFE' | 'RISKY' | 'UNKNOWN' | 'INSUFFICIENT';
  risk_profile: 'low' | 'medium' | 'high' | 'unknown';
  time_constant_days: number;
  last_update: number;
  /**
   * Vague 1 B (server 1.3.0, SDK 1.0.5) — true when the score aggregates
   * enough recent evidence to drive a decision; false when the response is
   * mostly the prior shining through (stale probe and/or thin data). On the
   * /api/intent surface the threshold is freshness_status in {fresh, recent}
   * AND n_obs >= 5. Optional for SDK back-compat against pre-1.3.0 servers.
   */
  is_meaningful?: boolean;
  sources?: {
    probe: unknown | null;
    report: unknown | null;
    paid: unknown | null;
  };
  convergence?: {
    converged: boolean;
    sources_above_threshold: string[];
    threshold: number;
  };
  recent_activity?: {
    last_24h: number;
    last_7d: number;
    last_30d: number;
  };
}

export interface AdvisoryBlock {
  advisory_level: 'green' | 'yellow' | 'orange' | 'red' | 'insufficient_freshness';
  risk_score: number;
  recommendation: 'proceed' | 'proceed_with_caution' | 'consider_alternative' | 'avoid';
  advisories: Array<{
    code: string;
    level: 'info' | 'warning' | 'critical';
    msg: string;
    signal_strength: number;
    data?: Record<string, unknown>;
  }>;
}

export interface HealthBlock {
  reachability: number | null;
  http_health_score: number | null;
  health_freshness: number | null;
  last_probe_age_sec: number | null;
}

/** Phase 5.14 — Beta posterior par stage du contrat L402. Cinq stages :
 *  challenge / invoice / payment / delivery / quality. */
export interface StagePosteriorEntry {
  stage: 'challenge' | 'invoice' | 'payment' | 'delivery' | 'quality';
  alpha: number;
  beta: number;
  p_success: number;
  ci95_low: number;
  ci95_high: number;
  n_obs: number;
  is_meaningful: boolean;
}

export interface StagePosteriorsBlock {
  stages: Record<string, StagePosteriorEntry>;
  /** Produit des p_success des stages avec n_obs >= IS_MEANINGFUL_MIN_N_OBS.
   *  null = aucun stage meaningful, l'agent retombe sur bayesian.p_success. */
  p_e2e: number | null;
  p_e2e_pessimistic: number | null;
  p_e2e_optimistic: number | null;
  meaningful_stages: string[];
  measured_stages: number;
}

/** Candidate endpoint as returned by /api/intent. snake_case preserved so
 *  the JSON round-trips cleanly. */
export interface IntentCandidate {
  rank: number;
  endpoint_url: string;
  endpoint_hash: string;
  operator_pubkey: string;
  service_name: string | null;
  price_sats: number | null;
  median_latency_ms: number | null;
  /** Phase 5.10A — méthode HTTP attendue par l'endpoint, persistée depuis
   *  402index. fulfill() l'utilise par défaut quand opts.request.method
   *  n'est pas fourni explicitement, ce qui évite le 405-puis-fallback sur
   *  les endpoints POST-only. Optional côté SDK pour compat avec un oracle
   *  pré-v48 qui ne le retournerait pas. */
  http_method?: 'GET' | 'POST';
  /** Phase 5.14 — décomposition 5-stage du contrat L402 (challenge / invoice
   *  / payment / delivery / quality). Émis quand l'oracle a au moins un
   *  stage en DB pour cet endpoint. Optional côté SDK pour compat avec un
   *  oracle pré-v49. Agents fine-grained lisent stages.delivery.p_success ;
   *  agents simples utilisent p_e2e ou retombent sur bayesian.p_success. */
  stage_posteriors?: StagePosteriorsBlock;
  bayesian: BayesianBlock;
  advisory: AdvisoryBlock;
  health: HealthBlock;
}

export interface IntentResponseMeta {
  total_matched: number;
  returned: number;
  strictness: 'strict' | 'relaxed' | 'degraded';
  warnings: string[];
}

export interface ResolvedIntent extends Intent {
  resolved_at: number;
}

/** Input for SatRank.register() — operator self-listing a new L402 endpoint
 *  via NIP-98. The Authorization header must be signed by the caller (the
 *  SDK is zero-dep and does not bundle a Nostr signer); pass any nostr-tools-
 *  compatible signed envelope as a string in the form `Nostr <base64-event>`. */
export interface RegisterInput {
  /** The L402 endpoint URL to register. The server fetches it, parses the
   *  L402 challenge, and ingests the BOLT11 → agent_hash mapping. */
  url: string;
  /** Optional metadata. The server applies a no-overwrite policy: existing
   *  402index data is never replaced; null fields are filled in. */
  name?: string;
  description?: string;
  category?: string;
  provider?: string;
  /** Pre-signed NIP-98 Authorization header value, e.g.
   *  `Nostr <base64-encoded-kind-27235-event>`. Must be signed with the npub
   *  that should own the endpoint. The signed event MUST bind to:
   *  - tag `["u", "<apiBase>/api/services/register"]`
   *  - tag `["method", "POST"]`
   *  - tag `["payload", "<sha256-hex of the JSON request body>"]`
   *  See nostr-tools or the worked example in docs/sdk/register-tutorial.md. */
  authorization: string;
}

export interface RegisterResponse {
  /** Echo of the registered URL. */
  url: string;
  /** sha256 hex of the canonicalized URL (= endpoint_hash, the canonical
   *  identifier used elsewhere in the API). */
  url_hash: string;
  /** Always true on a 201 response. */
  registered: boolean;
  /** sha256 hex of the LN destination pubkey decoded from the BOLT11 invoice. */
  agentHash: string;
  /** Price in sats decoded from the invoice, or null if amount-less. */
  priceSats: number | null;
  /** Metadata fields the server actually wrote (no-overwrite policy means
   *  this can be empty even when the client passed name/description/etc). */
  fieldsUpdated: string[];
  /** The npub_hex of the claiming operator (= the signer of the NIP-98). */
  operator_id: string;
  /** Human-readable status string. */
  message: string;
}

export interface IntentResponse {
  intent: ResolvedIntent;
  candidates: IntentCandidate[];
  meta: IntentResponseMeta;
}

export interface IntentCategory {
  name: string;
  endpoint_count: number;
  active_count: number;
}

export interface IntentCategoriesResponse {
  categories: IntentCategory[];
}

/** Wallet driver contract — implemented by LndWallet, NwcWallet, LnurlWallet.
 *  Intentionally narrow: the SDK only needs "pay this invoice" + liveness. */
export interface Wallet {
  /** Pay a BOLT11 invoice, capping fees. Returns the preimage on success. */
  payInvoice(
    bolt11: string,
    maxFeeSats: number,
  ): Promise<{ preimage: string; feePaidSats: number }>;
  /** Cheap liveness check — used to fail fast before a fulfill() attempt. */
  isAvailable(): Promise<boolean>;
}

/** Optional request shaping for the downstream service call. Defaults to
 *  `GET <endpoint_url>` with no body. fulfill() doesn't know the agent's
 *  use case; this lets them pass method/body/headers through. */
export interface FulfillRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path segment appended to the candidate endpoint_url (rarely needed — the
   *  /api/intent response already points at the exact URL). */
  path?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
}

/** Arguments to sr.fulfill(). Only `intent` and `budget_sats` are required. */
export interface FulfillOptions {
  intent: Intent;
  /** Hard cap on total sats the SDK is allowed to spend across all attempts.
   *  Any individual BOLT11 exceeding the remaining budget aborts that candidate
   *  without paying it. */
  budget_sats: number;
  /** Wall-clock cap (ms) — when exceeded, no new candidate is attempted. */
  timeout_ms?: number;
  /** Whether to try the next candidate if the current one fails. */
  retry_policy?: 'next_candidate' | 'none';
  /** Auto-submit outcome to /api/report (anonymous report). Default true. */
  auto_report?: boolean;
  /** Pass-through to /api/intent — snake_case agent identifier. */
  caller?: string;
  /** Max candidates returned by /api/intent (default 5, max 20 server-side). */
  limit?: number;
  /** Shape the outbound request to the downstream service. */
  request?: FulfillRequest;
  /** Per-candidate fee cap handed to Wallet.payInvoice. Default 10 sats. */
  max_fee_sats?: number;
}

/** Outcome classification for a single candidate attempt. */
export type CandidateOutcome =
  | 'paid_success' // BOLT11 paid and service responded 2xx
  | 'paid_failure' // BOLT11 paid but service returned 4xx/5xx
  | 'skipped' // retry_policy=none and a prior candidate already fulfilled
  | 'abort_budget' // BOLT11 amount would exceed remaining budget
  | 'abort_timeout' // wall-clock timeout reached before attempt
  | 'pay_failed' // wallet rejected the invoice (no route / no funds / etc.)
  | 'no_invoice' // candidate didn't return a 402+BOLT11 flow
  | 'network_error'; // transport-level failure before 402

export interface CandidateAttempt {
  url: string;
  verdict: string;
  outcome: CandidateOutcome;
  cost_sats?: number;
  response_code?: number;
  error?: string;
}

export interface FulfillErrorShape {
  code: string;
  message: string;
}

/** Human-readable trace of fulfill()'s candidate selection. The agent already
 *  has `candidates_tried` for the raw outcome list; this block makes the
 *  ranking and rejection rationale legible without parsing enums. The
 *  `selection_strategy` constant documents the SDK's policy so two integrators
 *  reading the same payload reach the same conclusion. `chosen_*` fields are
 *  null when no candidate produced a paid_success — `alternatives_considered`
 *  then enumerates every attempt with its rejection reason. */
export interface SelectionExplanation {
  chosen_endpoint: string | null;
  chosen_reason: string | null;
  chosen_score: number | null;
  alternatives_considered: Array<{
    endpoint: string;
    score: number;
    rejected_reason: string;
  }>;
  candidates_evaluated: number;
  selection_strategy: string;
}

export interface FulfillResult {
  success: boolean;
  response_body?: unknown;
  response_code?: number;
  response_latency_ms?: number;
  /** Total sats spent across all attempts. Always ≤ budget_sats. */
  cost_sats: number;
  preimage?: string;
  endpoint_used?: {
    url: string;
    service_name: string | null;
    operator_pubkey: string;
  };
  candidates_tried: CandidateAttempt[];
  /** Optional. Present whenever fulfill() actually evaluated at least one
   *  candidate (i.e. the intent resolution returned a non-empty list). */
  selection_explanation?: SelectionExplanation;
  report_submitted?: boolean;
  error?: FulfillErrorShape;
}

// ─── SDK 1.3.0 — server-side fulfill proxy ────────────────────────────────
//
// `sr.proxyFulfill()` is the Phase 1+ flow: agent prepays SatRank with a
// deposit, sends an intent + max budget, SatRank picks the candidate, pays
// the operator on the agent's behalf, validates the response, returns the
// body OR refunds. The agent never touches Lightning, retries, macaroons,
// or pay-gap upstream. This is the indispensability primitive (success-only
// billing). See docs/FULFILL.md.

export interface ProxyFulfillInput {
  /** Same intent shape as resolveIntent — category + optional filters. */
  intent: {
    category: string;
    keywords?: string[];
    budget_sats?: number;
    max_latency_ms?: number;
    optimize?: 'p_success' | 'latency' | 'reliability' | 'cost';
  };
  /** Hard cap on sats the agent will spend on candidate invoices. SatRank
   *  refuses to start any candidate whose decoded invoice exceeds the
   *  remaining budget. */
  max_sats: number;
  /** Total time budget for the entire fulfill (probe + pay + recall +
   *  retries across candidates). 5000–30000 ms typical. */
  max_latency_ms: number;
  /** Optional canonical sha256 hex of a JSON Schema previously registered
   *  via POST /api/schemas. When supplied, the orchestrator validates each
   *  successful 2xx body against the schema; mismatches are treated as
   *  delivery failures (Tier 2 refund). */
  expected_schema_hash?: string;
  /** SDK 1.4.0 — payment mode. 'deposit' (default, custodial via
   *  /api/deposit + token_balance) or 'hold' (non-custodial via Lightning
   *  hold invoice). When 'hold', proxyFulfill returns
   *  {status: 'hold_invoice_required'} with the BOLT11; the agent pays it
   *  then calls proxyFulfillExecute() to trigger orchestrator. */
  mode?: 'deposit' | 'hold';
  /** SDK 1.4.1 (Phase 6.1) — open-amount BOLT11 the agent owns; SatRank
   *  pays the residue (= reserve_sats_max − sats_spent − premium) here on
   *  a hold-mode success. Must be open-amount: encoded BOLT11 amount must
   *  be 0 or omitted, otherwise the orchestrator rejects with
   *  hold_mode_unavailable. Without it, residue is absorbed by the pool. */
  refund_bolt11?: string;
  /** Pre-signed `Authorization: Nostr <base64-event>` header. The signed
   *  NIP-98 event MUST bind to:
   *    - `u` tag = `${apiBase}/api/fulfill`
   *    - `method` tag = `POST`
   *    - `payload` tag = sha256 of the raw JSON body the SDK will send
   *  See docs/FULFILL.md for a worked end-to-end example. The SDK is
   *  zero-dep and does not bundle a Nostr signer. */
  authorization: string;
}

export type ProxyFulfillStatus =
  | 'success'
  | 'refunded'
  | 'insufficient_balance'
  | 'daily_cap_reached'
  | 'circuit_breaker_open'
  | 'hold_invoice_required'
  | 'hold_mode_unavailable';

/** SDK 1.4.0 — input for the second step of hold-mode fulfill. The agent
 *  has paid the hold-invoice from a prior proxyFulfill({mode:'hold'})
 *  call; this triggers the orchestrator. The intent must be re-supplied
 *  because SatRank stores intent_hash, not the full intent shape, between
 *  the two calls. */
export interface ProxyFulfillExecuteInput {
  job_id: string;
  intent: ProxyFulfillInput['intent'];
  authorization: string;
}

export interface ProxyFulfillAttempt {
  candidate_url: string;
  rank: number;
  payment_outcome: string;
  delivery_outcome: string;
  http_status: number | null;
  sats_paid: number;
  detail?: string;
  preimage?: string;
}

export interface ProxyFulfillResult {
  status: ProxyFulfillStatus;
  /** Present when status='success': the validated 2xx body the operator
   *  returned, the Lightning preimage that proves payment, and the
   *  candidate URL that delivered. */
  job_id?: string;
  body?: string;
  preimage?: string;
  candidate_url?: string;
  attempts?: ProxyFulfillAttempt[];
  sats_spent?: number;
  premium_sats?: number;
  /** Present when status='refunded': diagnostics about why every candidate
   *  failed. The agent was NOT debited (success-only billing). */
  reason?: string;
  /** Present when status='insufficient_balance': how many sats the agent
   *  needs to top up. */
  required_sats?: number;
  available_sats?: number;
  /** Present when status='daily_cap_reached': drain protection ceiling
   *  hit. retry_after_sec tells the agent how long to back off. */
  cap_sats?: number;
  used_24h_sats?: number;
  agent_age_bucket?: 'fresh' | 'established';
  retry_after_sec?: number;
  /** Present when status='circuit_breaker_open': SatRank's pool is below
   *  the safe floor. /api/oracle/fulfill exposes the live balance. */
  pool_balance_sats?: number;
  min_pool_sats?: number;
  /** SDK 1.4.0 — present when status='hold_invoice_required'. The agent
   *  pays this BOLT11, then calls proxyFulfillExecute(job_id, intent,
   *  authorization) to trigger the orchestrator. */
  payment_request?: string;
  payment_hash?: string;
  invoice_amount_sats?: number;
  expires_at?: number;
  execute_endpoint?: string;
  /** SDK 1.4.1 (Phase 6.1) — echoes back the refund_bolt11 the server stored,
   *  for the agent to confirm. Empty / undefined when none was supplied. */
  refund_bolt11?: string;
  /** SDK 1.4.1 (Phase 6.1) — populated on hold-mode success when residue > 0.
   *  refund_state telegrams the outbound-pay outcome:
   *    - 'paid'           : residue paid to refund_bolt11 (single attempt OK)
   *    - 'pending'        : residue pay failed transiently; cron retries
   *    - 'failed_absorbed': retries exhausted OR no refund_bolt11 supplied;
   *                         residue stays in SatRank pool (audit-visible)
   *    - 'not_required'   : residue == 0 (rare, only when reserve == actual) */
  residue_sats?: number;
  refund_state?: 'paid' | 'pending' | 'failed_absorbed' | 'not_required';
}

export interface ProxyFulfillQuoteCandidate {
  rank: number;
  endpoint_url: string;
  operator_pubkey: string | null;
  invoice_sats_estimate: number;
  premium_estimate: number;
  total_estimate: number;
  p_e2e: number | null;
  p_e2e_pessimistic: number | null;
  median_latency_ms: number | null;
}

export interface ProxyFulfillQuoteResult {
  candidates: ProxyFulfillQuoteCandidate[];
  reserve_sats_max: number;
  circuit_breaker_open: boolean;
}

/** Constructor options for the SatRank client. */
export interface SatRankOptions {
  apiBase: string;
  /** Optional Authorization header value (e.g. "L402 deposit:<preimage>").
   *  Sent with /api/report only — /api/intent is unauthenticated discovery. */
  depositToken?: string;
  /** Wallet driver used to pay candidate invoices during fulfill(). */
  wallet?: Wallet;
  /** Dependency injection point for tests — defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Default caller identifier piped into /api/intent logs. */
  caller?: string;
  /** Request timeout for individual API calls (ms). Default 10_000. */
  request_timeout_ms?: number;
}


/** SDK 1.5.0 (Phase 8.3) — SatRank-signed evidence receipt for a successful
 *  fulfill_jobs.job_id. Verifiers fetch SatRank's pubkey from
 *  /.well-known/satrank-key and validate offline. */
export interface EvidenceReceipt {
  receipt_id: number;
  job_id: string;
  attempt_index: number;
  /** Canonical (deterministic-key-order) JSON the signature was computed
   *  over. Verifiers reconstruct + sha256 + ed25519.verify against
   *  satrank_pubkey. */
  payload_canonical_json: string;
  payload_sha256: string;
  signature_b64: string;
  satrank_pubkey: string;
  signed_at_iso: string;
  /** Optional RFC-3161 timestamp authority countersignature (Phase 8.2.1+). */
  tsa_token_b64: string | null;
  tsa_authority_url: string | null;
  algorithm: 'ed25519';
  verifier_doc: string;
  well_known_pubkey_url: string;
}

// SDK 1.6 (2026-05-08) — AEPS §10 dispute types.

export type AepsDisputeType =
  | 'content_correctness'
  | 'sla_breach'
  | 'fork'
  | 'non_payment'
  | 'false_dispute';

export type AepsAttestationOutcome = 'disputant_wins' | 'respondent_wins';

export type AepsDisputeState =
  | 'open'
  | 'resolved_disputant'
  | 'resolved_respondent'
  | 'expired'
  | 'aborted';

export interface AepsDisputeOpenInput {
  /** 64-char hex pubkey of the party being disputed. */
  respondent_pubkey: string;
  dispute_type: AepsDisputeType;
  /** Optional pointer to evidence_receipts.receipt_id (content/SLA disputes). */
  receipt_id?: number;
  /** Optional pointer to aeps_fork_events.fork_event_id (fork disputes). */
  fork_event_id?: number;
  /** Pre-agreed oracle threshold set. 64-char hex BIP-340 x-only pubkeys. */
  oracle_pubkeys: string[];
  /** n-of-m. Must be in [1, oracle_pubkeys.length]. */
  oracle_threshold: number;
  ttl_sec?: number;
  dispute_reason?: string;
}

export interface AepsDisputeOutcomeMessage {
  /** Canonical-JSON bytes the oracle signs (UTF-8 string). */
  canonical: string;
  /** SHA-256 hex of the canonical bytes — the 32 bytes BIP-340 signs. */
  hash_hex: string;
}

export interface AepsDisputeOpenResult {
  dispute_id: string;
  state: AepsDisputeState;
  multiplier: 1 | 2 | 3 | 5;
  oracle_pubkeys: string[];
  oracle_threshold: number;
  expires_at: number;
  outcome_messages: {
    disputant_wins: AepsDisputeOutcomeMessage;
    respondent_wins: AepsDisputeOutcomeMessage;
  };
}

export interface AepsAttestationInput {
  outcome: AepsAttestationOutcome;
  /** 128-char hex BIP-340 Schnorr signature of the canonical outcome
   *  message hash (returned by AepsDisputeOpenResult.outcome_messages). */
  signature_hex: string;
}

export interface AepsAttestationResult {
  dispute_id: string;
  attestation_id: number;
  dispute_state: AepsDisputeState;
}

export interface AepsDisputeAttestationView {
  oracle_pubkey: string;
  outcome: AepsAttestationOutcome;
  signed_at: number;
}

export interface AepsDisputeView {
  dispute_id: string;
  disputant_pubkey: string;
  respondent_pubkey: string;
  dispute_type: AepsDisputeType;
  multiplier: number;
  oracle_pubkeys: string[];
  oracle_threshold: number;
  state: AepsDisputeState;
  expires_at: number;
  created_at: number;
  resolved_at: number | null;
  claim_id: number | null;
  attestation_counts: {
    disputant_wins: number;
    respondent_wins: number;
  };
  attestations: AepsDisputeAttestationView[];
}
