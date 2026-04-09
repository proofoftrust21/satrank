#!/usr/bin/env bash
#
# SatRank — End-to-End Demo
#
# Walkthrough of the full SatRank flow: free discovery endpoints,
# the paid L402 /api/decide call, and the report feedback loop.
#
# Usage:
#   BASE_URL=https://satrank.dev ./scripts/demo.sh           # against prod (default)
#   BASE_URL=http://localhost:3000 ./scripts/demo.sh         # against local dev
#
# Everything runs in read-only mode except /api/report, which posts a
# synthetic report to illustrate the response shape (use a throwaway
# reporter hash — real reports must describe real transactions).
#
# This script is designed to be recorded end-to-end for the WoT-a-thon
# video submission: every curl is preceded by a plain-English banner
# explaining what the step is and why it matters.

set -u

BASE_URL="${BASE_URL:-https://satrank.dev}"

# Target: ACINQ Lightning node — one of the largest, known stable hubs
TARGET_LN_PUBKEY="03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f"
TARGET_HASH="fce15c4cf8db86db85778ea4ba9a382075d36d8c19c7ad2c6ffe8f624a5f42cb"

# Caller context: SatRank's own Lightning node pubkey — stands in for
# "the agent calling SatRank from its own position in the graph"
CALLER_LN_PUBKEY="024b550337d6c46e94fed5fa31f1f5ee165b0a11c8d3a30160ee8816bc81d9f5af"
CALLER_HASH="$(printf '%s' "$CALLER_LN_PUBKEY" | shasum -a 256 | awk '{print $1}')"

BOLD="\033[1m"
CYAN="\033[36m"
DIM="\033[2m"
RESET="\033[0m"

banner() {
  echo ""
  echo -e "${BOLD}${CYAN}==> $1${RESET}"
  echo -e "${DIM}$2${RESET}"
  echo ""
}

run() {
  echo -e "${DIM}\$ $*${RESET}"
  eval "$@"
  echo ""
}

echo -e "${BOLD}SatRank End-to-End Demo${RESET}"
echo -e "${DIM}Base URL: ${BASE_URL}${RESET}"
echo -e "${DIM}Target:   ACINQ (${TARGET_LN_PUBKEY:0:16}...)${RESET}"

# ---------------------------------------------------------------------------
banner "1. Health check" \
  "First things first — is the oracle up? The /api/health endpoint reports the DB status, schema version, agents indexed, uptime, and whether the database is reachable."

run "curl -sS ${BASE_URL}/api/health | jq ."

# ---------------------------------------------------------------------------
banner "2. Network statistics" \
  "How big is the graph SatRank is scoring? /api/stats shows the number of Lightning nodes indexed, the phantom rate (nodes unreachable in routing), verified reachable nodes, channels, BTC capacity, probes in the last 24h, and the average score. These are the numbers a jury can cross-check against the landing page and the README."

run "curl -sS ${BASE_URL}/api/stats | jq ."

# ---------------------------------------------------------------------------
banner "3. Leaderboard — top scored nodes" \
  "GET /api/agents/top returns the ranked list of Lightning nodes by trust score. This is a free endpoint — anyone can consume it without an API key or a Lightning payment. Look at the response: each agent has a score, rank, 5 component breakdown, and alias."

run "curl -sS '${BASE_URL}/api/agents/top?limit=5&sort_by=score' | jq '.data[] | {rank,alias,score,components}'"

# ---------------------------------------------------------------------------
banner "4. Free ping — live reachability" \
  "Before paying for a full decision, an agent can ping a target for free. /api/ping/<ln_pubkey> runs QueryRoutes live against SatRank's LND node and reports whether a route currently exists. Free, sub-second, and fresh."

run "curl -sS ${BASE_URL}/api/ping/${TARGET_LN_PUBKEY} | jq ."

# ---------------------------------------------------------------------------
banner "5. Personalized ping — route from YOUR position" \
  "Same endpoint, with ?from=<your_ln_pubkey>. Now SatRank asks LND whether there is a route from the caller's position to the target, not from SatRank's own node. This is the personalized reachability signal that no free Lightning explorer exposes."

run "curl -sS '${BASE_URL}/api/ping/${TARGET_LN_PUBKEY}?from=${CALLER_LN_PUBKEY}' | jq ."

# ---------------------------------------------------------------------------
banner "6. L402 paid decide — the oracle call" \
  "This is the core of SatRank. POST /api/decide returns a GO/NO-GO with success probability, verdict, personalized pathfinding, and survival prediction. It is gated by L402: the first call returns HTTP 402 with a Lightning invoice, the client pays the invoice, then retries with the macaroon + preimage. Free Nostr scores are the trailer; this is the film."

echo -e "${DIM}# Step 6a — unauthenticated call, expect HTTP 402 + L402 challenge${RESET}"
run "curl -sS -i -X POST -H 'Content-Type: application/json' \
  -d '{\"target\":\"${TARGET_HASH}\",\"caller\":\"${CALLER_HASH}\"}' \
  ${BASE_URL}/api/decide | sed -n '1,20p'"

echo -e "${DIM}# Step 6b — after paying the invoice, retry with Authorization header:${RESET}"
echo -e "${DIM}#   Authorization: LSAT <base64-macaroon>:<hex-preimage>${RESET}"
echo -e "${DIM}# See sdk/src/client.ts for the full SDK helper.${RESET}"

# ---------------------------------------------------------------------------
banner "7. Report the outcome — feedback loop" \
  "After the payment attempt, the caller reports the result. /api/report is free (no L402) and feeds back into P_empirical — the probability component of future decide responses. Each report is weighted by the reporter's own SatRank score, and preimage-verified reports get a 2x bonus. This is the closed loop: usage generates data, data improves decisions."

run "curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{\"target\":\"${TARGET_HASH}\",\"reporter\":\"${CALLER_HASH}\",\"outcome\":\"success\"}' \
  ${BASE_URL}/api/report 2>&1 | jq . || echo '(note: /api/report requires X-API-Key in production — shown as 401/403 is expected)'"

# ---------------------------------------------------------------------------
banner "8. Agent profile — reports, uptime, rank" \
  "The full profile combines the static score with the dynamic data produced by the feedback loop: total reports, weighted success rate, uptime from 7 days of probes, rank among all active nodes, and the risk profile (established_hub, growing_node, etc.)."

run "curl -sS ${BASE_URL}/api/profile/${TARGET_HASH} | jq ."

# ---------------------------------------------------------------------------
banner "9. Nostr distribution — what the world sees" \
  "All of this is also published to Nostr every 6 hours as NIP-85 kind 30382:rank events. Any Nostr-native client or agent can consume SatRank without touching our REST API. Query from any standard Nostr client (nak, nostcat, nostr-tools):"
echo ""
echo -e "${DIM}['REQ', 'satrank', { kinds: [30382], authors: ['5d11d46de1ba4d3295a33658df12eebb5384d6d6679f05b65fec3c86707de7d4'], limit: 5 }]${RESET}"
echo ""

banner "Done" \
  "Full flow covered: health, stats, discovery, live ping, paid decide, report, profile, Nostr distribution. Ready for recording."
