#!/bin/bash
# Score validation tracker - snapshot every 30min for 72h.
# Reads latest score + components from score_snapshots, per-tier probe rates from probe_results.
# Output: /root/scoring-validation/snapshots.csv (append-only).
#
# Cron: */30 * * * * /root/scoring-validation.sh >> /var/log/scoring-validation.log 2>&1

set -u

DB=/var/lib/docker/volumes/satrank_satrank-data/_data/satrank.db
PANEL=/root/scoring-validation-panel.csv
OUTDIR=/root/scoring-validation
CSV=$OUTDIR/snapshots.csv

mkdir -p "$OUTDIR"

if [ ! -f "$CSV" ]; then
  echo "timestamp,hash,alias,category,score,volume,reputation,seniority,regularity,diversity,snapshot_age_sec,total_txs,last_seen_sec_ago,probe_1k_s,probe_10k_s,probe_100k_s,probe_1m_s,probe_1k_t,probe_10k_t,probe_100k_t,probe_1m_t,signal" > "$CSV"
fi

NOW=$(date -u +%s)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
WINDOW=$((7 * 86400))
SINCE=$((NOW - WINDOW))

# Extract hash + category from panel. Aliases can contain '|' chars so we
# locate the 64-hex hash and take $NF as category.
PAIRS=$(awk -F'|' '
  !/^#/ && NF >= 3 {
    h=""; for (i=1; i<=NF; i++) if ($i ~ /^[a-f0-9]{64}$/) { h=$i; break }
    cat=$NF; gsub(/[[:space:]]/, "", cat)
    if (h != "") print h "|" cat
  }' "$PANEL")

# Per-tier success rates over 7d window, one round-trip
RATES=$(sqlite3 "$DB" <<SQL
SELECT target_hash || '|' || probe_amount_sats || '|' || SUM(reachable) || '|' || COUNT(*)
FROM probe_results
WHERE probed_at >= $SINCE
  AND probe_amount_sats IN (1000, 10000, 100000, 1000000)
GROUP BY target_hash, probe_amount_sats;
SQL
)

declare -A TIER
while IFS='|' read -r h tier s t; do
  [ -z "$h" ] && continue
  TIER["${h}_${tier}"]="${s}|${t}"
done <<< "$RATES"

# Latest score snapshot per panel hash
HASHES=$(echo "$PAIRS" | cut -d'|' -f1 | awk '{printf "'"'"'%s'"'"',", $1}' | sed 's/,$//')
SCORES=$(sqlite3 "$DB" <<SQL
SELECT s.agent_hash || '|' || s.score || '|' || s.components || '|' || s.computed_at
FROM score_snapshots s
INNER JOIN (
  SELECT agent_hash, MAX(computed_at) AS mx
  FROM score_snapshots
  WHERE agent_hash IN ($HASHES)
  GROUP BY agent_hash
) latest ON latest.agent_hash = s.agent_hash AND latest.mx = s.computed_at
WHERE s.agent_hash IN ($HASHES);
SQL
)

declare -A SCORE_MAP
while IFS='|' read -r h score comps computed; do
  [ -z "$h" ] && continue
  SCORE_MAP["$h"]="${score}|${comps}|${computed}"
done <<< "$SCORES"

# Agent meta (alias, total_transactions, last_seen). Alias may contain '|',
# so we sanitize it to '/' before storing in a pipe-delimited map value.
AGENTS=$(sqlite3 "$DB" "SELECT public_key_hash || char(1) || REPLACE(COALESCE(alias, ''), '|', '/') || char(1) || total_transactions || char(1) || last_seen FROM agents WHERE public_key_hash IN ($HASHES);")

declare -A AGENT_MAP
while IFS=$'\x01' read -r h al tx ls; do
  [ -z "$h" ] && continue
  AGENT_MAP["$h"]="${al}|${tx}|${ls}"
done <<< "$AGENTS"

N=0
while IFS='|' read -r hash category; do
  [ -z "$hash" ] && continue
  N=$((N+1))

  # Agent meta
  am="${AGENT_MAP[$hash]:-||}"
  alias=$(echo "$am" | cut -d'|' -f1 | tr ',"' ';_')
  total_txs=$(echo "$am" | cut -d'|' -f2)
  last_seen=$(echo "$am" | cut -d'|' -f3)
  last_seen_ago=""
  [ -n "$last_seen" ] && last_seen_ago=$((NOW - last_seen))

  # Score + components (components is a JSON string)
  sm="${SCORE_MAP[$hash]:-||}"
  score=$(echo "$sm" | cut -d'|' -f1)
  comps=$(echo "$sm" | cut -d'|' -f2)
  computed=$(echo "$sm" | cut -d'|' -f3)
  age_sec=""
  [ -n "$computed" ] && age_sec=$((NOW - computed))

  volume=""; reputation=""; seniority=""; regularity=""; diversity=""
  if [ -n "$comps" ]; then
    # Extract JSON fields with jq
    volume=$(echo "$comps" | jq -r '.volume // empty' 2>/dev/null)
    reputation=$(echo "$comps" | jq -r '.reputation // empty' 2>/dev/null)
    seniority=$(echo "$comps" | jq -r '.seniority // empty' 2>/dev/null)
    regularity=$(echo "$comps" | jq -r '.regularity // empty' 2>/dev/null)
    diversity=$(echo "$comps" | jq -r '.diversity // empty' 2>/dev/null)
  fi

  # Per-tier rates
  for tier in 1000 10000 100000 1000000; do
    entry="${TIER[${hash}_${tier}]:-0|0}"
    eval "s_${tier}=\"$(echo "$entry" | cut -d'|' -f1)\""
    eval "t_${tier}=\"$(echo "$entry" | cut -d'|' -f2)\""
  done

  # Weighted signal (matches Option D in scoringService)
  signal=$(awk -v s1="$s_1000" -v t1="$t_1000" \
               -v s2="$s_10000" -v t2="$t_10000" \
               -v s3="$s_100000" -v t3="$t_100000" \
               -v s4="$s_1000000" -v t4="$t_1000000" '
    BEGIN {
      ws = 0; wt = 0;
      if (t1 > 0) { ws += (s1/t1) * 0.4; wt += 0.4 }
      if (t2 > 0) { ws += (s2/t2) * 0.3; wt += 0.3 }
      if (t3 > 0) { ws += (s3/t3) * 0.2; wt += 0.2 }
      if (t4 > 0) { ws += (s4/t4) * 0.1; wt += 0.1 }
      if (wt > 0) printf "%.4f", ws / wt
    }')

  echo "$TIMESTAMP,$hash,\"$alias\",$category,$score,$volume,$reputation,$seniority,$regularity,$diversity,$age_sec,$total_txs,$last_seen_ago,$s_1000,$s_10000,$s_100000,$s_1000000,$t_1000,$t_10000,$t_100000,$t_1000000,$signal" >> "$CSV"
done <<< "$PAIRS"

echo "[$TIMESTAMP] snapshot written: $N rows -> $CSV"
