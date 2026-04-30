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
} from './errors';

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
