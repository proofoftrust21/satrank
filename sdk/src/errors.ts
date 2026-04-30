// Error hierarchy — agents can `catch (e)` and dispatch on `instanceof` rather
// than string-matching error codes. Preserved from SDK 0.2.x because this is
// the most stable part of the public surface.

export class SatRankError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'SatRankError';
  }

  isRetryable(): boolean {
    return (
      this.statusCode === 429 ||
      this.statusCode === 503 ||
      this.statusCode === 504 ||
      this.code === 'NETWORK_ERROR' ||
      this.code === 'TIMEOUT'
    );
  }

  isClientError(): boolean {
    return (
      this.statusCode >= 400 && this.statusCode < 500 && !this.isRetryable()
    );
  }
}

export class ValidationSatRankError extends SatRankError {
  constructor(message: string) {
    super(message, 400, 'VALIDATION_ERROR');
    this.name = 'ValidationSatRankError';
  }
}

export class UnauthorizedError extends SatRankError {
  constructor(message: string) {
    super(message, 401, 'UNAUTHORIZED');
    this.name = 'UnauthorizedError';
  }
}

/** SDK 1.2.0 — NIP-98 Authorization missing, malformed, expired, or
 *  replayed. Server returns the public reason 'NIP98_INVALID' uniformly to
 *  avoid leaking forgery hints (audit M2). The SDK exposes this as a
 *  separate catch-target so callers wiring the register surface can
 *  branch on `instanceof Nip98InvalidError`. */
export class Nip98InvalidError extends UnauthorizedError {
  constructor(message: string) {
    super(message);
    this.name = 'Nip98InvalidError';
    (this as unknown as { code: string }).code = 'NIP98_INVALID';
  }
}

/** SDK 1.2.0 — operator/endpoint claim already taken by another npub
 *  under first-claim semantics. Returned 409 with code 'ALREADY_CLAIMED'.
 *  Distinct from `DuplicateReportError` (which is also 409 but on /report). */
export class AlreadyClaimedError extends SatRankError {
  constructor(message: string) {
    super(message, 409, 'ALREADY_CLAIMED');
    this.name = 'AlreadyClaimedError';
  }
}

/** SDK 1.2.0 — register attempt rejected because the L402 endpoint declares
 *  a different Nostr pubkey as its owner via the `nostr-pubkey` tag in
 *  WWW-Authenticate (audit Tier 4N). Cryptographic proof of ownership
 *  takes precedence over first-claim. */
export class OwnershipMismatchError extends SatRankError {
  constructor(message: string) {
    super(message, 403, 'OWNERSHIP_MISMATCH');
    this.name = 'OwnershipMismatchError';
  }
}

export class PaymentRequiredError extends SatRankError {
  constructor(message: string, code = 'PAYMENT_REQUIRED') {
    super(message, 402, code);
    this.name = 'PaymentRequiredError';
  }
}

export class BalanceExhaustedError extends PaymentRequiredError {
  constructor(message: string) {
    super(message, 'BALANCE_EXHAUSTED');
    this.name = 'BalanceExhaustedError';
  }
}

export class PaymentPendingError extends PaymentRequiredError {
  constructor(message: string) {
    super(message, 'PAYMENT_PENDING');
    this.name = 'PaymentPendingError';
  }
}

export class NotFoundSatRankError extends SatRankError {
  constructor(message: string) {
    super(message, 404, 'NOT_FOUND');
    this.name = 'NotFoundSatRankError';
  }
}

export class DuplicateReportError extends SatRankError {
  constructor(message: string) {
    super(message, 409, 'DUPLICATE_REPORT');
    this.name = 'DuplicateReportError';
  }
}

export class RateLimitedError extends SatRankError {
  constructor(message: string) {
    super(message, 429, 'RATE_LIMITED');
    this.name = 'RateLimitedError';
  }
}

export class ServiceUnavailableError extends SatRankError {
  constructor(message: string) {
    super(message, 503, 'SERVICE_UNAVAILABLE');
    this.name = 'ServiceUnavailableError';
  }
}

export class TimeoutError extends SatRankError {
  constructor(message = 'Request timeout') {
    super(message, 504, 'TIMEOUT');
    this.name = 'TimeoutError';
  }
}

export class NetworkError extends SatRankError {
  constructor(message: string) {
    super(message, 0, 'NETWORK_ERROR');
    this.name = 'NetworkError';
  }
}

/** Wallet-layer failure (no route, insufficient balance, driver refused invoice).
 *  Kept separate from SatRankError since the SatRank server was never hit. */
export class WalletError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'WalletError';
  }
}

/** Map an HTTP response to a typed SatRankError subclass. */
export function errorFromResponse(
  status: number,
  code: string | undefined,
  message: string,
): SatRankError {
  const msg = message || `HTTP ${status}`;
  if (status === 400) return new ValidationSatRankError(msg);
  if (status === 401) {
    if (code === 'NIP98_INVALID') return new Nip98InvalidError(msg);
    return new UnauthorizedError(msg);
  }
  if (status === 402) {
    if (code === 'BALANCE_EXHAUSTED') return new BalanceExhaustedError(msg);
    if (code === 'PAYMENT_PENDING') return new PaymentPendingError(msg);
    return new PaymentRequiredError(msg);
  }
  if (status === 403) {
    if (code === 'OWNERSHIP_MISMATCH') return new OwnershipMismatchError(msg);
    return new SatRankError(msg, 403, code ?? 'FORBIDDEN');
  }
  if (status === 404) return new NotFoundSatRankError(msg);
  if (status === 409) {
    if (code === 'ALREADY_CLAIMED') return new AlreadyClaimedError(msg);
    return new DuplicateReportError(msg);
  }
  if (status === 429) return new RateLimitedError(msg);
  if (status === 503) return new ServiceUnavailableError(msg);
  if (status === 504) return new TimeoutError(msg);
  return new SatRankError(msg, status, code ?? 'UNKNOWN');
}
