"""Error hierarchy — mirrors @satrank/sdk/errors in TypeScript.

SatRankError is the base for anything coming from the SatRank API. WalletError
is a parallel hierarchy (plain Exception) because wallet problems are orthogonal
to API responses.
"""

from __future__ import annotations

from typing import Any


class SatRankError(Exception):
    """Base class for errors surfaced by the SatRank SDK (API-side)."""

    code: str = "SATRANK_ERROR"

    def __init__(self, message: str, code: str | None = None, *, data: Any = None) -> None:
        super().__init__(message)
        if code is not None:
            self.code = code
        self.data = data

    def __repr__(self) -> str:
        return f"{type(self).__name__}(code={self.code!r}, message={str(self)!r})"


class ValidationSatRankError(SatRankError):
    code = "VALIDATION_ERROR"


class UnauthorizedError(SatRankError):
    code = "UNAUTHORIZED"


class PaymentRequiredError(SatRankError):
    code = "PAYMENT_REQUIRED"


class BalanceExhaustedError(SatRankError):
    code = "BALANCE_EXHAUSTED"


class PaymentPendingError(SatRankError):
    code = "PAYMENT_PENDING"


class NotFoundSatRankError(SatRankError):
    code = "NOT_FOUND"


class DuplicateReportError(SatRankError):
    code = "DUPLICATE_REPORT"


class RateLimitedError(SatRankError):
    code = "RATE_LIMITED"


class ServiceUnavailableError(SatRankError):
    code = "SERVICE_UNAVAILABLE"


class TimeoutError(SatRankError):  # noqa: A001 — intentional shadow of builtins.TimeoutError
    code = "TIMEOUT"


class NetworkError(SatRankError):
    code = "NETWORK_ERROR"


class WalletError(Exception):
    """Wallet driver failure. Parallel to SatRankError — not an API response."""

    def __init__(self, message: str, code: str = "WALLET_ERROR") -> None:
        super().__init__(message)
        self.code = code

    def __repr__(self) -> str:
        return f"WalletError(code={self.code!r}, message={str(self)!r})"


_HTTP_CODE_MAP: dict[int, type[SatRankError]] = {
    400: ValidationSatRankError,
    401: UnauthorizedError,
    402: PaymentRequiredError,
    403: BalanceExhaustedError,
    404: NotFoundSatRankError,
    409: DuplicateReportError,
    425: PaymentPendingError,
    429: RateLimitedError,
    503: ServiceUnavailableError,
}


def error_from_response(
    status: int, payload: dict[str, Any] | None
) -> SatRankError:
    """Map a non-2xx server response to a typed SatRankError."""
    cls = _HTTP_CODE_MAP.get(status, SatRankError)
    err_block = (payload or {}).get("error") or {}
    code = err_block.get("code") or cls.code
    message = err_block.get("message") or f"HTTP {status}"
    data = err_block.get("data")
    return cls(message, code=code, data=data)
