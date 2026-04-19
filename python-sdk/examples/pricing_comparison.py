"""Pricing comparison across SatRank categories — Python.

Queries /api/intent for every live category and prints a per-category summary:
number of candidates, price range (sats), median latency, top candidate.

No wallet required — this is discovery-only (`sr.list_categories()` +
`sr.resolve_intent()`). No sats spent.

Run:
    cd python-sdk && .venv/bin/python examples/pricing_comparison.py
"""

from __future__ import annotations

import asyncio
from statistics import median

from satrank import SatRank


def _fmt_range(values: list[int]) -> str:
    if not values:
        return "—"
    lo, hi = min(values), max(values)
    return f"{lo}" if lo == hi else f"{lo}–{hi}"


async def main() -> None:
    async with SatRank(
        api_base="https://satrank.dev",
        caller="pricing-comparison-example",
    ) as sr:
        cats = await sr.list_categories()
        print(f"Found {len(cats['categories'])} categories on satrank.dev\n")

        # Header
        header = (
            f"{'category':<18} {'n':>3} {'price (sats)':>14} "
            f"{'median ms':>10}  top candidate"
        )
        print(header)
        print("─" * len(header))

        for c in sorted(cats["categories"], key=lambda x: x["name"]):
            if c["active_count"] == 0:
                continue
            try:
                res = await sr.resolve_intent(category=c["name"], limit=20)
            except Exception as exc:
                print(f"{c['name']:<18} !! {exc}")
                continue

            cands = res["candidates"]
            prices = [x["price_sats"] for x in cands if x.get("price_sats")]
            lats = [x["median_latency_ms"] for x in cands if x.get("median_latency_ms")]
            top = cands[0] if cands else None

            top_label = (
                f"{top.get('service_name') or top['endpoint_hash'][:12]} "
                f"(rank={top['rank']})"
                if top
                else "—"
            )
            print(
                f"{c['name']:<18} "
                f"{len(cands):>3} "
                f"{_fmt_range(prices):>14} "
                f"{int(median(lats)) if lats else 0:>10}  "
                f"{top_label}"
            )


if __name__ == "__main__":
    asyncio.run(main())
