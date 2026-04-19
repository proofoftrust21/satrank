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
  if (status === 401) return new UnauthorizedError(msg);
  if (status === 402) {
    if (code === 'BALANCE_EXHAUSTED') return new BalanceExhaustedError(msg);
    if (code === 'PAYMENT_PENDING') return new PaymentPendingError(msg);
    return new PaymentRequiredError(msg);
  }
  if (status === 404) return new NotFoundSatRankError(msg);
  if (status === 409) return new DuplicateReportError(msg);
  if (status === 429) return new RateLimitedError(msg);
  if (status === 503) return new ServiceUnavailableError(msg);
  if (status === 504) return new TimeoutError(msg);
  return new SatRankError(msg, status, code ?? 'UNKNOWN');
}
