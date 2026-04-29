"""Phase 7.2 — federation aggregation primitive.

The agent SDK uses this utility to discover SatRank-compatible oracles and
filter the ones whose calibration history meets its trust criteria. Pure
helper — not auto-wired into ``fulfill()`` (the agent decides when and how
to federate).

Mirrors @satrank/sdk's ``aggregate.ts``. See the TS file for the original
docstring.

Typical usage::

    from satrank.aggregate import fetch_oracle_peers, aggregate_oracles

    # 1) Discover peers from one seed oracle:
    fetched = await fetch_oracle_peers(base_url="https://satrank.dev")

    # 2) Filter by your own trust criteria:
    result = await aggregate_oracles(
        base_url="https://satrank.dev",
        max_stale_sec=7 * 86400,
        min_catalogue_size=50,
        require_calibration=True,
    )
    # result["peers"] = list of OraclePeer matching the criteria.
    # The agent then queries each via /api/intent or its DVM.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

import httpx

from satrank.types import OraclePeer


def _validate_oracle_url(url: str) -> str:
    """Security audit (Finding 5) — validate scheme + host before issuing
    the GET. Without this, a caller passing ``base_url='file:///etc/passwd'``
    or ``base_url='http://169.254.169.254'`` (AWS metadata) would either
    crash deep in httpx or successfully exfiltrate. The SDK is consumed by
    agent code that may take ``base_url`` from a Nostr event or another
    peer's response — defence in depth is required.

    Returns the original URL on success; raises ``ValueError`` on rejection.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(
            f"oracle base_url must use http or https scheme, got: {parsed.scheme!r}"
        )
    if not parsed.netloc:
        raise ValueError("oracle base_url must have a valid host")
    return url


async def fetch_oracle_peers(
    *,
    base_url: str = "https://satrank.dev",
    limit: int = 50,
    http: httpx.AsyncClient | None = None,
    timeout_s: float = 15.0,
) -> dict[str, Any]:
    """Fetch the peer list of a SatRank-compatible oracle.

    Returns a dict::

        {
            "peers": list[OraclePeer],
            "count": int,
            "source_oracle": str,
        }

    Server-side ``limit`` clamps to 200.

    Raises :class:`ValueError` if ``base_url`` is not http(s).
    """
    _validate_oracle_url(base_url)
    url = f"{base_url.rstrip('/')}/api/oracle/peers"
    params = {"limit": str(limit)}
    own_client = http is None
    client = http or httpx.AsyncClient(timeout=timeout_s)
    try:
        resp = await client.get(
            url, params=params, headers={"Accept": "application/json"}
        )
        resp.raise_for_status()
        body = resp.json()
    finally:
        if own_client:
            await client.aclose()
    data = body.get("data") or {}
    peers: list[OraclePeer] = list(data.get("peers") or [])
    count = int(data.get("count") or len(peers))
    return {"peers": peers, "count": count, "source_oracle": base_url}


def filter_by_calibration_error(
    peers: list[OraclePeer],
    *,
    max_stale_sec: int = 7 * 86400,
    min_catalogue_size: int = 50,
    require_calibration: bool = True,
    min_age_sec: int = 0,
) -> list[OraclePeer]:
    """Filter a peer list against the agent's trust criteria. Pure function.

    Defaults match the TypeScript ``filterByCalibrationError``.
    """
    out: list[OraclePeer] = []
    for p in peers:
        if int(p.get("stale_sec", 0)) > max_stale_sec:
            continue
        if int(p.get("catalogue_size", 0)) < min_catalogue_size:
            continue
        if require_calibration and not p.get("calibration_event_id"):
            continue
        if int(p.get("age_sec", 0)) < min_age_sec:
            continue
        out.append(p)
    return out


async def aggregate_oracles(
    *,
    base_url: str = "https://satrank.dev",
    limit: int = 50,
    max_stale_sec: int = 7 * 86400,
    min_catalogue_size: int = 50,
    require_calibration: bool = True,
    min_age_sec: int = 0,
    http: httpx.AsyncClient | None = None,
    timeout_s: float = 15.0,
) -> dict[str, Any]:
    """Combined helper: fetch peers from a seed oracle, then filter them
    by the agent's trust criteria.

    Returns::

        {
            "peers": list[OraclePeer],     # peers that passed the filter
            "total_discovered": int,        # count from the seed oracle
            "trusted_count": int,           # len(peers)
            "source_oracle": str,           # the seed URL used
        }

    The agent can then iterate ``peers`` and query each via /api/intent or
    its DVM (kind 5900) for cross-oracle Bayesian model averaging.
    """
    fetched = await fetch_oracle_peers(
        base_url=base_url, limit=limit, http=http, timeout_s=timeout_s
    )
    trusted = filter_by_calibration_error(
        fetched["peers"],
        max_stale_sec=max_stale_sec,
        min_catalogue_size=min_catalogue_size,
        require_calibration=require_calibration,
        min_age_sec=min_age_sec,
    )
    return {
        "peers": trusted,
        "total_discovered": fetched["count"],
        "trusted_count": len(trusted),
        "source_oracle": fetched["source_oracle"],
    }
