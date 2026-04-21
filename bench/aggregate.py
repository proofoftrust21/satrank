#!/usr/bin/env python3
"""
Phase 12A A5 → A7 — aggregate k6 summary-export JSONs into a single
markdown table suitable for dropping into the benchmark report.

Usage :
    ./bench/aggregate.py bench/results/phase-12a-20260421-0943 > table.md
    ./bench/aggregate.py bench/results/phase-12a-20260421-0943 --json   # machine-readable

The script reads every *.json in the results dir that looks like a k6
summary-export (top-level `metrics` dict) and extracts :

  - requests (http_reqs count)
  - actual rps (http_reqs rate)
  - p50 / p90 / p95 http_req_duration (k6 summary-export does not
    carry p99 by default — use --summary-trend-stats if needed)
  - max http_req_duration
  - error rate (http_req_failed value — the Rate metric's final ratio)

It does NOT try to re-derive paliers by filename pattern; the filename
tag (e.g. verdict_rps100.json) becomes the row label.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def load_summary(path: Path) -> dict | None:
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as err:
        print(f"skip {path.name}: {err}", file=sys.stderr)
        return None
    if not isinstance(data, dict) or "metrics" not in data:
        return None
    return data


def extract_row(tag: str, data: dict) -> dict:
    metrics = data.get("metrics", {})
    reqs = metrics.get("http_reqs", {})
    dur = metrics.get("http_req_duration", {})
    failed = metrics.get("http_req_failed", {})
    return {
        "tag": tag,
        "requests": int(reqs.get("count", 0)),
        "rps": reqs.get("rate", 0.0),
        "p50_ms": dur.get("med", 0.0),
        "p90_ms": dur.get("p(90)", 0.0),
        "p95_ms": dur.get("p(95)", 0.0),
        "max_ms": dur.get("max", 0.0),
        "error_rate": failed.get("value", failed.get("rate", 0.0)),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results_dir", help="bench/results/<run-id>/")
    parser.add_argument("--json", action="store_true", help="emit JSON instead of markdown")
    args = parser.parse_args()

    root = Path(args.results_dir)
    if not root.is_dir():
        print(f"not a directory: {root}", file=sys.stderr)
        return 2

    rows: list[dict] = []
    for path in sorted(root.glob("*.json")):
        data = load_summary(path)
        if data is None:
            continue
        tag = path.stem
        rows.append(extract_row(tag, data))

    if not rows:
        print("no summary-export files found", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(rows, indent=2))
        return 0

    # Markdown table
    print(f"# Phase 12A bench — {root.name}")
    print()
    print("| tag | requests | rps | p50 ms | p90 ms | p95 ms | max ms | err rate |")
    print("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for r in rows:
        print(
            f"| {r['tag']} | {r['requests']} | {r['rps']:.2f} "
            f"| {r['p50_ms']:.1f} | {r['p90_ms']:.1f} | {r['p95_ms']:.1f} | {r['max_ms']:.1f} "
            f"| {r['error_rate']:.4f} |"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
