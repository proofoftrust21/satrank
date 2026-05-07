// Public API — main entry. Subpath-exported modules (`./wallet`, `./nlp`)
// live in their own files and are not re-exported here to keep the barrel
// narrow. Agents choose what they import:
//
//   import { SatRank } from '@satrank/sdk';
//   import { LndWallet } from '@satrank/sdk/wallet';
//   import { parseIntent } from '@satrank/sdk/nlp';
export { SatRank } from './SatRank';

export type {
  Intent,
  ResolvedIntent,
  IntentCandidate,
  IntentResponse,
  IntentResponseMeta,
  IntentCategory,
  IntentCategoriesResponse,
  BayesianBlock,
  AdvisoryBlock,
  HealthBlock,
  Wallet,
  FulfillOptions,
  FulfillRequest,
  FulfillResult,
  CandidateAttempt,
  CandidateOutcome,
  FulfillErrorShape,
  SelectionExplanation,
  SatRankOptions,
  // SDK 1.2.0 — register surface
  RegisterInput,
  RegisterResponse,
  // SDK 1.3.0 — server-side fulfill proxy
  ProxyFulfillInput,
  ProxyFulfillResult,
  ProxyFulfillStatus,
  ProxyFulfillAttempt,
  ProxyFulfillQuoteResult,
  ProxyFulfillQuoteCandidate,
  // SDK 1.4.0 — hold-invoice mode (Phase 6)
  ProxyFulfillExecuteInput,
  // SDK 1.5.0 — evidence receipts (Phase 8.3)
  EvidenceReceipt,
  // SDK 1.6.0 — AEPS §10 disputes
  AepsDisputeType,
  AepsAttestationOutcome,
  AepsDisputeState,
  AepsDisputeOpenInput,
  AepsDisputeOpenResult,
  AepsDisputeOutcomeMessage,
  AepsAttestationInput,
  AepsAttestationResult,
  AepsDisputeAttestationView,
  AepsDisputeView,
} from './types';

export {
  SatRankError,
  ValidationSatRankError,
  UnauthorizedError,
  PaymentRequiredError,
  BalanceExhaustedError,
  PaymentPendingError,
  NotFoundSatRankError,
  DuplicateReportError,
  RateLimitedError,
  ServiceUnavailableError,
  TimeoutError,
  NetworkError,
  WalletError,
  // SDK 1.2.0 — register-specific error subclasses
  Nip98InvalidError,
  AlreadyClaimedError,
  OwnershipMismatchError,
  // SDK 1.6.0 — AEPS §10 dispute-specific error subclasses
  AepsDisputeNotFoundError,
  AepsDisputeNotOpenError,
  AepsOracleNotInSetError,
  AepsSignatureInvalidError,
} from './errors';

// SDK 1.6 — AEPS canonical-bytes helpers (zero-dep ; agents bring their
// own crypto). buildOutcomeMessage / buildOutcomeMessageHash for §10
// oracle attestations ; buildNip98EventTemplate / encodeNip98AuthHeader
// for HTTP authentication on AEPS routes.
export {
  buildOutcomeMessage,
  buildOutcomeMessageHash,
  buildCapabilityCanonicalBytes,
  buildCapabilityEndpointId,
  buildNip98EventTemplate,
  encodeNip98AuthHeader,
} from './aeps';
export type {
  AepsOutcome,
  AepsCapabilityDescriptorLike,
  Nip98Template,
  Nip98SignedEvent,
  BuildNip98Input,
} from './aeps';

// Phase 7.2 — federation aggregation primitives.
export {
  fetchOraclePeers,
  filterByCalibrationError,
  aggregateOracles,
} from './aggregate';
export type {
  OraclePeer,
  FetchOraclePeersOptions,
  FetchOraclePeersResult,
  FilterPeersOptions,
  AggregateOraclesOptions,
} from './aggregate';
