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


# SDK 1.2.0 — register surface (NIP-98 + ownership proof).
class Nip98InvalidError(UnauthorizedError):
    """Raised on 401 with code NIP98_INVALID — the Authorization header was
    missing, malformed, expired, or replayed (audit Tier 2F replay cache)."""

    code = "NIP98_INVALID"


class AlreadyClaimedError(SatRankError):
    """Raised on 409 with code ALREADY_CLAIMED — the endpoint URL was already
    claimed by another npub under first-claim semantics. Distinct from
    DuplicateReportError (also 409 but on /report)."""

    code = "ALREADY_CLAIMED"


class OwnershipMismatchError(SatRankError):
    """Raised on 403 with code OWNERSHIP_MISMATCH — the L402 endpoint declares
    a different Nostr pubkey as its owner via the `nostr-pubkey` tag in
    WWW-Authenticate (audit Tier 4N). Cryptographic proof of ownership takes
    precedence over first-claim."""

    code = "OWNERSHIP_MISMATCH"


class WalletError(Exception):
    """Wallet driver failure. Parallel to SatRankError — not an API response."""

    def __init__(self, message: str, code: str = "WALLET_ERROR") -> None:
        super().__init__(message)
        self.code = code

    def __repr__(self) -> str:
        return f"WalletError(code={self.code!r}, message={str(self)!r})"


# SDK 1.6.0 (2026-05-08) — AEPS §10 dispute-specific error subclasses.
# Mirror the TypeScript SDK 1.6.0 hierarchy. The server's structured
# error envelope (Phase 11A.2) ships lowercase codes for these cases ;
# Python callers can `except` on them instead of string-matching.

class AepsDisputeNotFoundError(NotFoundSatRankError):
    """Raised on 404 with code 'dispute_not_found' — the dispute_id was
    not registered on this server (typo, expired purge, etc.)."""

    code = "dispute_not_found"


class AepsDisputeNotOpenError(SatRankError):
    """Raised on 409 with code 'dispute_not_open' — the dispute already
    resolved, expired, or aborted ; new attestations are no longer accepted."""

    code = "dispute_not_open"


class AepsOracleNotInSetError(SatRankError):
    """Raised on 403 with code 'oracle_not_in_set' — the caller's NIP-98
    pubkey is not in the dispute's pre-agreed `dlc_oracles` threshold set,
    so its attestation is not eligible."""

    code = "oracle_not_in_set"


class AepsSignatureInvalidError(ValidationSatRankError):
    """Raised on 400 with code 'signature_invalid' — the BIP-340 Schnorr
    signature on the canonical outcome message did not verify against the
    declared oracle pubkey. Either the wrong key signed, or the signature
    was crafted over a different message."""

    code = "signature_invalid"


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
    """Map a non-2xx server response to a typed SatRankError.

    SDK 1.2.0 — when the server returns a fine-grained `error.code` we
    can dispatch to a more specific subclass than the HTTP-status fallback.
    Used for register-surface error codes (NIP98_INVALID, ALREADY_CLAIMED,
    OWNERSHIP_MISMATCH).
    """
    # Two server-side shapes coexist:
    #   {"error": {"code": "X", "message": "Y", "data": ...}}  (legacy / register)
    #   {"error": "X", "message": "Y", ...}                    (SDK 1.3+ fulfill)
    # Tolerate both so neither caller has to special-case the wire format.
    raw_err = (payload or {}).get("error")
    if isinstance(raw_err, dict):
        err_block = raw_err
        code = err_block.get("code")
        message = err_block.get("message") or f"HTTP {status}"
        data = err_block.get("data")
    elif isinstance(raw_err, str):
        code = raw_err
        message = (payload or {}).get("message") or f"HTTP {status}"
        data = None
    else:
        code = None
        message = (payload or {}).get("message") or f"HTTP {status}"
        data = None

    # Code-driven dispatch first (most specific). Falls through to the
    # status-driven map when the server didn't surface a known code.
    code_cls: type[SatRankError] | None = None
    if code == "NIP98_INVALID":
        code_cls = Nip98InvalidError
    elif code == "ALREADY_CLAIMED":
        code_cls = AlreadyClaimedError
    elif code == "OWNERSHIP_MISMATCH":
        code_cls = OwnershipMismatchError
    # SDK 1.6.0 — AEPS §10 dispute-specific codes.
    elif code == "dispute_not_found":
        code_cls = AepsDisputeNotFoundError
    elif code == "dispute_not_open":
        code_cls = AepsDisputeNotOpenError
    elif code == "oracle_not_in_set":
        code_cls = AepsOracleNotInSetError
    elif code == "signature_invalid":
        code_cls = AepsSignatureInvalidError

    cls = code_cls or _HTTP_CODE_MAP.get(status, SatRankError)
    return cls(message, code=code or cls.code, data=data)
