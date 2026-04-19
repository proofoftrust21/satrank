"""SatRank SDK — discover, score, and pay Lightning-native HTTP services.

Mirrors the TypeScript @satrank/sdk 1.0 API:

    from satrank import SatRank
    sr = SatRank(api_base="https://satrank.dev")
    result = await sr.fulfill(intent={"category": "data"}, budget_sats=100)
"""

from satrank.client import SatRank
from satrank.errors import (
    BalanceExhaustedError,
    DuplicateReportError,
    NetworkError,
    NotFoundSatRankError,
    PaymentPendingError,
    PaymentRequiredError,
    RateLimitedError,
    SatRankError,
    ServiceUnavailableError,
    TimeoutError,
    UnauthorizedError,
    ValidationSatRankError,
    WalletError,
)
from satrank.types import (
    AdvisoryBlock,
    BayesianBlock,
    CandidateAttempt,
    CandidateOutcome,
    FulfillOptions,
    FulfillRequest,
    FulfillResult,
    HealthBlock,
    Intent,
    IntentCandidate,
    IntentCategoriesResponse,
    IntentCategory,
    IntentResponse,
    IntentResponseMeta,
    ResolvedIntent,
    SatRankOptions,
    Wallet,
)

__version__ = "1.0.0rc1"

__all__ = [
    "SatRank",
    "__version__",
    "AdvisoryBlock",
    "BalanceExhaustedError",
    "BayesianBlock",
    "CandidateAttempt",
    "CandidateOutcome",
    "DuplicateReportError",
    "FulfillOptions",
    "FulfillRequest",
    "FulfillResult",
    "HealthBlock",
    "Intent",
    "IntentCandidate",
    "IntentCategoriesResponse",
    "IntentCategory",
    "IntentResponse",
    "IntentResponseMeta",
    "NetworkError",
    "NotFoundSatRankError",
    "PaymentPendingError",
    "PaymentRequiredError",
    "RateLimitedError",
    "ResolvedIntent",
    "SatRankError",
    "SatRankOptions",
    "ServiceUnavailableError",
    "TimeoutError",
    "UnauthorizedError",
    "ValidationSatRankError",
    "Wallet",
    "WalletError",
]
