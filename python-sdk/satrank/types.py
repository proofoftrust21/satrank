"""Python types mirroring @satrank/sdk TypeScript definitions.

Wire format is snake_case JSON — preserved on both ends. We use TypedDicts
for JSON payloads (so dicts coming back from httpx deserialize cleanly) and
Protocol for the Wallet driver contract.
"""

from __future__ import annotations

from typing import (
    Any,
    Literal,
    Protocol,
    TypedDict,
    runtime_checkable,
)

CandidateOutcome = Literal[
    "paid_success",
    "paid_failure",
    "skipped",
    "abort_budget",
    "abort_timeout",
    "pay_failed",
    "no_invoice",
    "network_error",
]


class Intent(TypedDict, total=False):
    category: str
    keywords: list[str]
    budget_sats: int
    max_latency_ms: int


class ResolvedIntent(TypedDict, total=False):
    category: str
    keywords: list[str]
    budget_sats: int | None
    max_latency_ms: int | None
    resolved_at: int


class BayesianSources(TypedDict, total=False):
    probe: Any
    report: Any
    paid: Any


class BayesianConvergence(TypedDict, total=False):
    converged: bool
    sources_above_threshold: list[str]
    threshold: float


class BayesianRecentActivity(TypedDict, total=False):
    last_24h: int
    last_7d: int
    last_30d: int


class BayesianBlock(TypedDict, total=False):
    p_success: float
    ci95_low: float
    ci95_high: float
    n_obs: float
    verdict: Literal["SAFE", "RISKY", "UNKNOWN", "INSUFFICIENT"]
    risk_profile: Literal["low", "medium", "high", "unknown"]
    time_constant_days: int
    last_update: int
    sources: BayesianSources
    convergence: BayesianConvergence
    recent_activity: BayesianRecentActivity


class AdvisoryEntry(TypedDict, total=False):
    code: str
    level: Literal["info", "warning", "critical"]
    msg: str
    signal_strength: float
    data: dict[str, Any]


class AdvisoryBlock(TypedDict, total=False):
    advisory_level: Literal["green", "yellow", "orange", "red"]
    risk_score: float
    recommendation: Literal["proceed", "proceed_with_caution", "consider_alternative", "avoid"]
    advisories: list[AdvisoryEntry]


class HealthBlock(TypedDict, total=False):
    reachability: float | None
    http_health_score: float | None
    health_freshness: float | None
    last_probe_age_sec: float | None


class IntentCandidate(TypedDict):
    rank: int
    endpoint_url: str
    endpoint_hash: str
    operator_pubkey: str
    service_name: str | None
    price_sats: int | None
    median_latency_ms: int | None
    bayesian: BayesianBlock
    advisory: AdvisoryBlock
    health: HealthBlock


class IntentResponseMeta(TypedDict):
    total_matched: int
    returned: int
    strictness: Literal["strict", "relaxed", "degraded"]
    warnings: list[str]


class IntentResponse(TypedDict):
    intent: ResolvedIntent
    candidates: list[IntentCandidate]
    meta: IntentResponseMeta


class IntentCategory(TypedDict):
    name: str
    endpoint_count: int
    active_count: int


class IntentCategoriesResponse(TypedDict):
    categories: list[IntentCategory]


class PayInvoiceResult(TypedDict):
    preimage: str
    fee_paid_sats: int


@runtime_checkable
class Wallet(Protocol):
    """Wallet driver contract. Implemented by LndWallet / NwcWallet / LnurlWallet."""

    async def pay_invoice(
        self, bolt11: str, max_fee_sats: int
    ) -> PayInvoiceResult: ...

    async def is_available(self) -> bool: ...


class FulfillRequest(TypedDict, total=False):
    method: Literal["GET", "POST", "PUT", "DELETE"]
    path: str
    query: dict[str, str]
    headers: dict[str, str]
    body: Any


class FulfillOptions(TypedDict, total=False):
    intent: Intent
    budget_sats: int
    timeout_ms: int
    retry_policy: Literal["next_candidate", "none"]
    auto_report: bool
    caller: str
    limit: int
    request: FulfillRequest
    max_fee_sats: int


class CandidateAttempt(TypedDict, total=False):
    url: str
    verdict: str
    outcome: CandidateOutcome
    cost_sats: int
    response_code: int
    error: str


class FulfillErrorShape(TypedDict):
    code: str
    message: str


class EndpointUsed(TypedDict):
    url: str
    service_name: str | None
    operator_pubkey: str


class SelectionAlternative(TypedDict):
    endpoint: str
    score: float
    rejected_reason: str


class SelectionExplanation(TypedDict, total=False):
    """Human-readable trace of fulfill()'s candidate selection (1.0.3+).

    `chosen_*` fields are None when no candidate produced a paid_success;
    `alternatives_considered` then enumerates every attempt with its rejection
    reason. `selection_strategy` is a constant string documenting the SDK's
    policy so two integrators reading the same payload reach the same
    conclusion about how endpoints were ranked.
    """

    chosen_endpoint: str | None
    chosen_reason: str | None
    chosen_score: float | None
    alternatives_considered: list[SelectionAlternative]
    candidates_evaluated: int
    selection_strategy: str


class FulfillResult(TypedDict, total=False):
    success: bool
    response_body: Any
    response_code: int
    response_latency_ms: int
    cost_sats: int
    preimage: str
    endpoint_used: EndpointUsed
    candidates_tried: list[CandidateAttempt]
    selection_explanation: SelectionExplanation
    report_submitted: bool
    error: FulfillErrorShape


class SatRankOptions(TypedDict, total=False):
    api_base: str
    deposit_token: str
    wallet: Wallet
    caller: str
    request_timeout_ms: int
