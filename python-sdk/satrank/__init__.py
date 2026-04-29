"""SatRank SDK: discover, score, and pay Lightning-native HTTP services.

Mirrors the TypeScript @satrank/sdk 1.1 API:

    from satrank import SatRank
    sr = SatRank(api_base="https://satrank.dev")
    result = await sr.fulfill(intent={"category": "data"}, budget_sats=100)

PR-7 federation primitives:

    from satrank.aggregate import aggregate_oracles
    fed = await aggregate_oracles(
        base_url="https://satrank.dev",
        max_stale_sec=7 * 86400,
        min_catalogue_size=50,
        require_calibration=True,
    )
"""

from satrank.aggregate import (
    aggregate_oracles,
    fetch_oracle_peers,
    filter_by_calibration_error,
)
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
    OraclePeer,
    ResolvedIntent,
    SatRankOptions,
    SelectionAlternative,
    SelectionExplanation,
    StagePosteriorEntry,
    StagePosteriorsBlock,
    Wallet,
)

__version__ = "1.1.0"

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
    "OraclePeer",
    "PaymentPendingError",
    "PaymentRequiredError",
    "RateLimitedError",
    "ResolvedIntent",
    "SatRankError",
    "SatRankOptions",
    "SelectionAlternative",
    "SelectionExplanation",
    "ServiceUnavailableError",
    "StagePosteriorEntry",
    "StagePosteriorsBlock",
    "TimeoutError",
    "UnauthorizedError",
    "ValidationSatRankError",
    "Wallet",
    "WalletError",
    "aggregate_oracles",
    "fetch_oracle_peers",
    "filter_by_calibration_error",
]
