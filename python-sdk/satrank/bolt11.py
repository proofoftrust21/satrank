"""BOLT11 invoice amount decoder. Zero-dep, pure-Python mirror of TS bolt11.ts.

Only extracts the amount field from the human-readable prefix — we don't need
to verify the invoice, just decide whether it fits our budget.

Amount encoding (BOLT11 §HRP):
  lnbc[<amount>[<multiplier>]]...
  where multiplier ∈ {m=0.001, u=0.000001, n=0.000000001, p=1e-12} BTC.
  Amount is in BTC post-multiplier. 1 sat = 1e-8 BTC.
"""

from __future__ import annotations

import re

_HRP_RE = re.compile(r"^ln(?:bcrt|tbs|bc|tb)(\d+)?([munp])?", re.IGNORECASE)

_MULTIPLIERS: dict[str, float] = {
    "m": 1e-3,
    "u": 1e-6,
    "n": 1e-9,
    "p": 1e-12,
}


def decode_bolt11_amount(bolt11: str) -> int | None:
    """Return the invoice amount in satoshis, or None if unparseable/amountless.

    An invoice without an amount (lnbc1p...) is legal — it means "payer chooses".
    Returning None signals "invoice is not priced"; callers should treat that as
    "can't enforce budget pre-pay".
    """
    if not isinstance(bolt11, str) or not bolt11.strip():
        return None
    m = _HRP_RE.match(bolt11.strip())
    if not m:
        return None
    amount_str, mult = m.group(1), m.group(2)
    if not amount_str:
        return None
    try:
        amount = int(amount_str)
    except ValueError:
        return None
    btc = float(amount)
    if mult:
        btc *= _MULTIPLIERS[mult.lower()]
    # Convert BTC → sats. Use round() to avoid float drift on "1u" = 100 sats exactly.
    return int(round(btc * 1e8))
