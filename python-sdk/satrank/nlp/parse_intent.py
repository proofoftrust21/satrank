"""parse_intent() — deterministic EN natural-language → Intent. Zero-dep.

Python mirror of @satrank/sdk/nlp/parseIntent — identical algorithm and output
shape. EN-only in SDK 1.0 (Phase 6); FR deferred to 6bis.
"""

from __future__ import annotations

import re
from typing import TypedDict

from satrank.types import Intent


class ParseIntentOptions(TypedDict, total=False):
    categories: list[str]
    synonyms: dict[str, str]


class ParsedIntent(TypedDict, total=False):
    intent: Intent
    ambiguous_categories: list[str]
    category_confidence: float


_STOPWORDS_EN: set[str] = {
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "am",
    "i", "me", "my", "we", "us", "our", "you", "your", "he", "she", "it", "its",
    "they", "them", "their", "this", "that", "these", "those",
    "and", "or", "but", "if", "then", "else", "so", "because", "as", "of", "at",
    "by", "for", "with", "about", "against", "between", "into", "through",
    "during", "before", "after", "above", "below", "to", "from", "up", "down",
    "in", "out", "on", "off", "over", "under", "again", "further", "once",
    "here", "there", "when", "where", "why", "how",
    "all", "any", "both", "each", "few", "more", "most", "other", "some", "such",
    "no", "nor", "not", "only", "own", "same", "than", "too", "very",
    "can", "will", "just", "don", "should", "now", "would", "could", "must",
    "do", "does", "did", "doing", "have", "has", "had", "having",
    "get", "got", "give", "given", "need", "needs", "want", "wants",
    "please", "look", "looking", "find", "show", "tell", "ask",
    "thanks", "thank", "hi", "hello", "hey",
    "sats", "sat", "satoshi", "satoshis", "fast", "quick", "urgent", "slow",
    "cheap", "budget", "max", "within", "seconds", "second", "ms",
    "pay", "paying", "cost", "costs", "price", "priced", "around",
    "service", "services", "api",
}

_BUDGET_PATTERNS = [
    re.compile(
        r"(?:under|up\s+to|max(?:imum)?|at\s+most|below|less\s+than)\s+(\d[\d_,]*)\s*(?:sat|sats|satoshi|satoshis)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"(?:for|pay|paying|budget(?:\s+of)?|cost(?:\s+of)?|price)?\s*(\d[\d_,]*)\s*(?:sat|sats|satoshi|satoshis)\b",
        re.IGNORECASE,
    ),
]

_LATENCY_MS_RE = re.compile(
    r"(?:under\s+|below\s+|less\s+than\s+|<\s*)(\d[\d_,]*)\s*ms\b",
    re.IGNORECASE,
)
_LATENCY_SEC_RE = re.compile(
    r"(?:within|under|in|less\s+than|at\s+most)\s+(\d[\d_,]*)\s*(?:s|sec|secs|second|seconds)\b",
    re.IGNORECASE,
)
_LATENCY_KEYWORDS: list[tuple[re.Pattern[str], int]] = [
    (re.compile(r"\b(?:urgent|asap|right\s+now|immediately)\b", re.IGNORECASE), 1000),
    (
        re.compile(
            r"\b(?:fast|quick|quickly|speedy|snappy|low[-\s]?latency)\b",
            re.IGNORECASE,
        ),
        2000,
    ),
]


def _parse_int(raw: str) -> int:
    return int(raw.replace("_", "").replace(",", ""))


def _extract_budget(text: str) -> int | None:
    for pat in _BUDGET_PATTERNS:
        m = pat.search(text)
        if m:
            try:
                n = _parse_int(m.group(1))
            except ValueError:
                continue
            if n > 0:
                return n
    return None


def _extract_latency(text: str) -> int | None:
    ms = _LATENCY_MS_RE.search(text)
    if ms:
        return _parse_int(ms.group(1))
    sec = _LATENCY_SEC_RE.search(text)
    if sec:
        return _parse_int(sec.group(1)) * 1000
    for pat, ms_val in _LATENCY_KEYWORDS:
        if pat.search(text):
            return ms_val
    return None


def _tokenize(text: str) -> list[str]:
    lowered = text.lower()
    cleaned = re.sub(r"[^a-z0-9\s/_-]", " ", lowered)
    return [t for t in cleaned.split() if t]


def _score_category(
    category_name: str, input_tokens: list[str], joined_input: str
) -> float:
    cat_lower = category_name.lower()
    if cat_lower in joined_input:
        return 1.0
    parts = [p for p in re.split(r"[/_-]", cat_lower) if len(p) > 1]
    if not parts:
        return 0.0
    hits = sum(1 for p in parts if p in input_tokens)
    return hits / len(parts)


def _resolve_category(
    text: str,
    tokens: list[str],
    categories: list[str],
    synonyms: dict[str, str] | None,
) -> tuple[str, float, list[str] | None]:
    joined = text.lower()
    if synonyms:
        for phrase, cat in synonyms.items():
            if phrase.lower() in joined:
                return cat, 1.0, None

    scored = [(c, _score_category(c, tokens, joined)) for c in categories]
    scored.sort(key=lambda x: (-x[1], -len(x[0])))

    if not scored or scored[0][1] == 0:
        return "", 0.0, None

    top_cat, top_score = scored[0]
    ambiguous: list[str] = []
    for cat, score in scored:
        if score > 0 and top_score - score < 0.15:
            ambiguous.append(cat)
    return (
        top_cat,
        round(top_score, 3),
        ambiguous if len(ambiguous) > 1 else None,
    )


def _extract_keywords(tokens: list[str], category: str) -> list[str]:
    cat_lower = category.lower()
    cat_parts = {p for p in re.split(r"[/_-]", cat_lower) if p}
    out: list[str] = []
    seen: set[str] = set()
    for tok in tokens:
        if len(tok) < 3:
            continue
        if tok.isdigit():
            continue
        if tok in _STOPWORDS_EN:
            continue
        if tok == cat_lower:
            continue
        if tok in cat_parts:
            continue
        if tok in seen:
            continue
        seen.add(tok)
        out.append(tok)
        if len(out) >= 5:
            break
    return out


def parse_intent(input: str, opts: ParseIntentOptions) -> ParsedIntent:
    """Deterministic EN NL → structured Intent. Mirrors TS parseIntent exactly."""
    if not isinstance(input, str) or not input.strip():
        raise ValueError("parse_intent: input must be a non-empty string")
    categories = opts.get("categories")
    if not isinstance(categories, list):
        raise ValueError("parse_intent: opts['categories'] must be a list")

    text = input.strip()
    tokens = _tokenize(text)
    category, confidence, ambiguous = _resolve_category(
        text, tokens, categories, opts.get("synonyms")
    )
    keywords = _extract_keywords(tokens, category)
    budget_sats = _extract_budget(text)
    max_latency_ms = _extract_latency(text)

    intent: Intent = {"category": category}
    if keywords:
        intent["keywords"] = keywords
    if budget_sats is not None:
        intent["budget_sats"] = budget_sats
    if max_latency_ms is not None:
        intent["max_latency_ms"] = max_latency_ms

    result: ParsedIntent = {"intent": intent, "category_confidence": confidence}
    if ambiguous:
        result["ambiguous_categories"] = ambiguous
    return result
