"""fulfill_intent() — the single-call API for agents. Mirrors TS fulfill.ts.

Flow:
  1. POST /api/intent → candidates
  2. For each candidate in rank order:
     a. GET/POST endpoint unauthenticated
     b. If 402 → parse WWW-Authenticate → (token, bolt11)
     c. Decode invoice amount, check against remaining budget
     d. wallet.pay_invoice(bolt11, max_fee_sats)
     e. Retry with Authorization: L402 <token>:<preimage>
     f. Return body + preimage on 2xx
  3. Optionally POST /api/report.
"""

from __future__ import annotations

import asyncio
import re
import time
from typing import Any

import httpx

from satrank.api_client import ApiClient
from satrank.bolt11 import decode_bolt11_amount
from satrank.errors import SatRankError, WalletError
from satrank.errors import TimeoutError as SatRankTimeout
from satrank.types import (
    CandidateAttempt,
    CandidateOutcome,
    FulfillOptions,
    FulfillResult,
    IntentCandidate,
    SelectionAlternative,
    SelectionExplanation,
    Wallet,
)

DEFAULT_TIMEOUT_MS = 30_000
DEFAULT_MAX_FEE_SATS = 10
DEFAULT_LIMIT = 5

# Constant policy string surfaced in selection_explanation.selection_strategy
# (1.0.3+). Mirrors TS SELECTION_STRATEGY so two integrators reading the same
# payload reach the same conclusion about how the SDK ranked endpoints.
SELECTION_STRATEGY = (
    "highest-ranked candidate by p_success (server-sorted), tried in rank "
    "order until one returns HTTP 2xx after L402 payment"
)


def _outcome_to_human_reason(
    outcome: CandidateOutcome, error: str | None = None
) -> str:
    """Map CandidateOutcome to a one-line, human-readable rationale."""
    if outcome == "paid_success":
        return "paid response returned 2xx"
    if outcome == "paid_failure":
        return "endpoint returned non-2xx after payment"
    if outcome == "pay_failed":
        return (
            f"wallet rejected the invoice ({error})"
            if error
            else "wallet rejected the invoice"
        )
    if outcome == "abort_budget":
        return "invoice price exceeds remaining budget"
    if outcome == "abort_timeout":
        return "wall-clock timeout reached before attempt"
    if outcome == "no_invoice":
        return "endpoint did not return a 402+BOLT11 challenge"
    if outcome == "network_error":
        return (
            f"network error before 402 ({error})"
            if error
            else "network error before 402"
        )
    if outcome == "skipped":
        return "skipped by retry_policy=none after a prior attempt"
    return outcome


def _build_selection_explanation(
    candidates: list[IntentCandidate],
    tried: list[CandidateAttempt],
    chosen_index: int | None,
) -> SelectionExplanation:
    """Build SelectionExplanation from candidates list, tried attempts, and
    the chosen index (None on total failure). Pure helper, no side effects."""
    alternatives: list[SelectionAlternative] = []
    for i, attempt in enumerate(tried):
        if i == chosen_index:
            continue
        cand = candidates[i] if i < len(candidates) else None
        score = float(cand["bayesian"].get("p_success", 0.0)) if cand else 0.0
        alternatives.append(
            {
                "endpoint": attempt["url"],
                "score": score,
                "rejected_reason": _outcome_to_human_reason(
                    attempt["outcome"], attempt.get("error")
                ),
            }
        )

    if chosen_index is None:
        return {
            "chosen_endpoint": None,
            "chosen_reason": None,
            "chosen_score": None,
            "alternatives_considered": alternatives,
            "candidates_evaluated": len(candidates),
            "selection_strategy": SELECTION_STRATEGY,
        }

    chosen_attempt = tried[chosen_index]
    chosen_candidate = (
        candidates[chosen_index] if chosen_index < len(candidates) else None
    )
    chosen_score = (
        float(chosen_candidate["bayesian"].get("p_success", 0.0))
        if chosen_candidate
        else 0.0
    )
    if chosen_index == 0:
        chosen_reason = "top-ranked candidate by p_success returned 2xx after payment"
    else:
        plural = "" if chosen_index == 1 else "s"
        chosen_reason = (
            f"first candidate to succeed at rank {chosen_index + 1} after "
            f"{chosen_index} prior rejection{plural}"
        )
    return {
        "chosen_endpoint": chosen_attempt["url"],
        "chosen_reason": chosen_reason,
        "chosen_score": chosen_score,
        "alternatives_considered": alternatives,
        "candidates_evaluated": len(candidates),
        "selection_strategy": SELECTION_STRATEGY,
    }


_L402_RE = re.compile(r"^(?:L402|LSAT)\s+(.+)$", re.IGNORECASE)
_TOKEN_RE = re.compile(r"(?:macaroon|token)\s*=\s*(?:\"([^\"]+)\"|([^,\s]+))", re.IGNORECASE)
_INVOICE_RE = re.compile(r"invoice\s*=\s*(?:\"([^\"]+)\"|([^,\s]+))", re.IGNORECASE)


def parse_l402_challenge(header: str | None) -> tuple[str, str] | None:
    """Parse WWW-Authenticate L402/LSAT challenge → (token, invoice) or None."""
    if not header:
        return None
    m = _L402_RE.match(header.strip())
    if not m:
        return None
    body = m.group(1)
    tok = _TOKEN_RE.search(body)
    inv = _INVOICE_RE.search(body)
    if not tok or not inv:
        return None
    token = (tok.group(1) or tok.group(2)).strip()
    invoice = (inv.group(1) or inv.group(2)).strip()
    return token, invoice


def _amount_bucket(sats: int) -> str:
    if sats <= 21:
        return "micro"
    if sats <= 500:
        return "small"
    if sats <= 5000:
        return "medium"
    return "large"


def _outcome_to_report(outcome: CandidateOutcome) -> str | None:
    if outcome == "paid_success":
        return "success"
    if outcome == "paid_failure":
        return "failure"
    if outcome == "abort_timeout":
        return "timeout"
    return None


class _LastAttempt:
    __slots__ = ("endpoint_hash", "invoice", "preimage", "outcome", "cost_sats")

    def __init__(
        self,
        endpoint_hash: str,
        invoice: str | None,
        preimage: str | None,
        outcome: CandidateOutcome,
        cost_sats: int,
    ) -> None:
        self.endpoint_hash = endpoint_hash
        self.invoice = invoice
        self.preimage = preimage
        self.outcome = outcome
        self.cost_sats = cost_sats


class _AttemptInternal:
    __slots__ = ("summary", "body", "preimage", "invoice")

    def __init__(
        self,
        summary: CandidateAttempt,
        *,
        body: Any = None,
        preimage: str | None = None,
        invoice: str | None = None,
    ) -> None:
        self.summary = summary
        self.body = body
        self.preimage = preimage
        self.invoice = invoice


async def fulfill_intent(
    *,
    api: ApiClient,
    http: httpx.AsyncClient,
    wallet: Wallet | None,
    opts: FulfillOptions,
    default_caller: str | None,
    deposit_token: str | None,
) -> FulfillResult:
    _validate_opts(opts)
    intent = opts["intent"]
    budget_sats = int(opts["budget_sats"])
    timeout_ms = int(opts.get("timeout_ms", DEFAULT_TIMEOUT_MS))
    max_fee_sats = int(opts.get("max_fee_sats", DEFAULT_MAX_FEE_SATS))
    retry_policy = opts.get("retry_policy", "next_candidate")
    limit = int(opts.get("limit", DEFAULT_LIMIT))
    caller = opts.get("caller", default_caller)
    request = opts.get("request")
    auto_report = opts.get("auto_report", True)

    started_at = time.monotonic()
    deadline = started_at + (timeout_ms / 1000.0)

    tried: list[CandidateAttempt] = []
    spent = 0
    last: _LastAttempt | None = None

    try:
        intent_res = await api.post_intent(
            category=intent["category"],
            keywords=intent.get("keywords"),
            budget_sats=intent.get("budget_sats", budget_sats),
            max_latency_ms=intent.get("max_latency_ms"),
            caller=caller,
            limit=limit,
        )
    except SatRankError as exc:
        return _failure(tried, 0, exc.code or "INTENT_FAILED", str(exc))
    except Exception as exc:
        return _failure(tried, 0, "INTENT_FAILED", str(exc))

    candidates = intent_res.get("candidates", [])
    if not candidates:
        return _failure(
            tried,
            0,
            "NO_CANDIDATES",
            f"No candidates for category {intent['category']!r}",
        )

    for candidate in candidates:
        remaining_budget = budget_sats - spent
        remaining_time = deadline - time.monotonic()

        if remaining_time <= 0:
            tried.append(
                {
                    "url": candidate["endpoint_url"],
                    "verdict": candidate["bayesian"]["verdict"],
                    "outcome": "abort_timeout",
                }
            )
            break
        if remaining_budget <= 0:
            tried.append(
                {
                    "url": candidate["endpoint_url"],
                    "verdict": candidate["bayesian"]["verdict"],
                    "outcome": "abort_budget",
                }
            )
            break

        attempt = await _attempt_candidate(
            http=http,
            wallet=wallet,
            candidate=candidate,
            request=request,
            max_fee_sats=max_fee_sats,
            remaining_budget=remaining_budget,
            remaining_time=remaining_time,
        )
        tried.append(attempt.summary)
        spent += int(attempt.summary.get("cost_sats", 0) or 0)
        last = _LastAttempt(
            endpoint_hash=candidate["endpoint_hash"],
            invoice=attempt.invoice,
            preimage=attempt.preimage,
            outcome=attempt.summary["outcome"],
            cost_sats=int(attempt.summary.get("cost_sats", 0) or 0),
        )

        if attempt.summary["outcome"] == "paid_success":
            result: FulfillResult = {
                "success": True,
                "response_body": attempt.body,
                "response_code": attempt.summary.get("response_code"),  # type: ignore[typeddict-item]
                "response_latency_ms": int((time.monotonic() - started_at) * 1000),
                "cost_sats": spent,
                "preimage": attempt.preimage or "",
                "endpoint_used": {
                    "url": candidate["endpoint_url"],
                    "service_name": candidate.get("service_name"),
                    "operator_pubkey": candidate["operator_pubkey"],
                },
                "candidates_tried": tried,
                "selection_explanation": _build_selection_explanation(
                    candidates, tried, len(tried) - 1
                ),
            }
            result["report_submitted"] = await _maybe_auto_report(
                api=api,
                auto_report=auto_report,
                deposit_token=deposit_token,
                last=last,
            )
            return result

        if retry_policy == "none":
            break

    last_outcome: str = tried[-1]["outcome"] if tried else "NO_CANDIDATES"
    result = _failure(
        tried, spent, last_outcome.upper(), f"All {len(tried)} candidates failed"
    )
    result["selection_explanation"] = _build_selection_explanation(
        candidates, tried, None
    )
    result["report_submitted"] = await _maybe_auto_report(
        api=api,
        auto_report=auto_report,
        deposit_token=deposit_token,
        last=last,
    )
    return result


async def _attempt_candidate(
    *,
    http: httpx.AsyncClient,
    wallet: Wallet | None,
    candidate: IntentCandidate,
    request: Any,
    max_fee_sats: int,
    remaining_budget: int,
    remaining_time: float,
) -> _AttemptInternal:
    base_summary: CandidateAttempt = {
        "url": candidate["endpoint_url"],
        "verdict": candidate["bayesian"]["verdict"],
    }
    if (
        candidate.get("price_sats") is not None
        and int(candidate["price_sats"]) > remaining_budget  # type: ignore[arg-type]
    ):
        summary: CandidateAttempt = {**base_summary, "outcome": "abort_budget", "cost_sats": 0}
        return _AttemptInternal(summary)

    try:
        first = await _http_call(
            http,
            candidate["endpoint_url"],
            request=request,
            timeout_s=remaining_time,
        )
    except SatRankTimeout as exc:
        summary = {**base_summary, "outcome": "abort_timeout", "error": str(exc)}
        return _AttemptInternal(summary)
    except Exception as exc:
        summary = {**base_summary, "outcome": "network_error", "error": str(exc)}
        return _AttemptInternal(summary)

    if first.status_code != 402:
        if 200 <= first.status_code < 300:
            body = _safe_json(first)
            summary = {
                **base_summary,
                "outcome": "paid_success",
                "cost_sats": 0,
                "response_code": first.status_code,
            }
            return _AttemptInternal(summary, body=body)
        summary = {
            **base_summary,
            "outcome": "network_error",
            "response_code": first.status_code,
        }
        return _AttemptInternal(summary)

    challenge = parse_l402_challenge(first.headers.get("www-authenticate"))
    if not challenge:
        summary = {**base_summary, "outcome": "no_invoice", "response_code": 402}
        return _AttemptInternal(summary)
    token, invoice = challenge

    invoice_amount = decode_bolt11_amount(invoice)
    if invoice_amount is not None and invoice_amount > remaining_budget:
        summary = {**base_summary, "outcome": "abort_budget", "cost_sats": 0}
        return _AttemptInternal(summary)

    if wallet is None:
        summary = {
            **base_summary,
            "outcome": "pay_failed",
            "error": "no wallet configured (pass SatRank(wallet=...))",
        }
        return _AttemptInternal(summary)

    try:
        pay = await wallet.pay_invoice(invoice, max_fee_sats)
    except WalletError as exc:
        summary = {**base_summary, "outcome": "pay_failed", "error": exc.code}
        return _AttemptInternal(summary)
    except Exception as exc:
        summary = {**base_summary, "outcome": "pay_failed", "error": str(exc)}
        return _AttemptInternal(summary)

    preimage = pay["preimage"]
    paid_sats = (invoice_amount or 0) + int(pay.get("fee_paid_sats", 0) or 0)

    try:
        second = await _http_call(
            http,
            candidate["endpoint_url"],
            request=request,
            timeout_s=remaining_time,
            auth_header=f"L402 {token}:{preimage}",
        )
    except Exception as exc:
        summary = {
            **base_summary,
            "outcome": "paid_failure",
            "cost_sats": paid_sats,
            "error": str(exc),
        }
        return _AttemptInternal(summary, preimage=preimage, invoice=invoice)

    if 200 <= second.status_code < 300:
        body = _safe_json(second)
        summary = {
            **base_summary,
            "outcome": "paid_success",
            "cost_sats": paid_sats,
            "response_code": second.status_code,
        }
        return _AttemptInternal(summary, body=body, preimage=preimage, invoice=invoice)

    summary = {
        **base_summary,
        "outcome": "paid_failure",
        "cost_sats": paid_sats,
        "response_code": second.status_code,
    }
    return _AttemptInternal(summary, preimage=preimage, invoice=invoice)


async def _http_call(
    http: httpx.AsyncClient,
    base_url: str,
    *,
    request: Any,
    timeout_s: float,
    auth_header: str | None = None,
) -> httpx.Response:
    method = (request or {}).get("method", "GET")
    url = _build_url(base_url, (request or {}).get("path"), (request or {}).get("query"))
    headers: dict[str, str] = {"Accept": "application/json"}
    if request and request.get("headers"):
        headers.update(request["headers"])
    if auth_header:
        headers["Authorization"] = auth_header
    body = (request or {}).get("body")
    json_body: Any = None
    data_body: str | None = None
    if body is not None:
        if isinstance(body, str):
            data_body = body
            headers.setdefault("Content-Type", "application/json")
        else:
            json_body = body

    try:
        return await http.request(
            method,
            url,
            headers=headers,
            json=json_body,
            content=data_body,
            timeout=max(0.001, timeout_s),
        )
    except httpx.TimeoutException as exc:
        raise SatRankTimeout(f"request to {base_url} timed out") from exc
    except asyncio.CancelledError:
        raise SatRankTimeout(f"request to {base_url} cancelled/timed out") from None


def _build_url(base: str, path: str | None, query: dict[str, str] | None) -> str:
    url = base
    if path:
        url = url.rstrip("/") + ("/" + path.lstrip("/"))
    if query:
        sep = "&" if "?" in url else "?"
        from urllib.parse import urlencode

        url += sep + urlencode(query)
    return url


def _safe_json(res: httpx.Response) -> Any:
    ct = res.headers.get("content-type", "")
    if "application/json" in ct:
        try:
            return res.json()
        except ValueError:
            return None
    try:
        return res.text
    except Exception:
        return None


def _validate_opts(opts: FulfillOptions) -> None:
    if not opts or "intent" not in opts or not opts["intent"].get("category"):
        raise ValueError("fulfill: opts['intent']['category'] is required")
    budget = opts.get("budget_sats")
    if not isinstance(budget, int) or budget <= 0:
        raise ValueError("fulfill: opts['budget_sats'] must be > 0")


def _failure(
    tried: list[CandidateAttempt],
    spent: int,
    code: str,
    message: str,
) -> FulfillResult:
    return {
        "success": False,
        "cost_sats": spent,
        "candidates_tried": tried,
        "error": {"code": code, "message": message},
    }


async def _maybe_auto_report(
    *,
    api: ApiClient,
    auto_report: bool,
    deposit_token: str | None,
    last: _LastAttempt | None,
) -> bool:
    if not auto_report or last is None or not deposit_token:
        return False
    outcome = _outcome_to_report(last.outcome)
    if outcome is None:
        return False
    if not last.preimage and outcome != "timeout":
        return False
    try:
        await api.post_report(
            target=last.endpoint_hash,
            outcome=outcome,
            preimage=last.preimage,
            bolt11_raw=last.invoice,
            amount_bucket=_amount_bucket(last.cost_sats),
        )
        return True
    except Exception:
        return False
