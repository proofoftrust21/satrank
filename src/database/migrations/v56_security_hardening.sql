-- Security hardening — Phase 9.x audit fixes.
--
-- H1 — anti-double-revenue : colonne payment_hash + UNIQUE partial index
-- pour empêcher 2 concurrent HTTP requests sur le même first-use payment
-- hash de logger 2× le même revenue (race window dans onPaidCallSettled
-- avant que balanceAuth auto-crée le token_balance row).
--
-- Index partial : seulement sur les rows REVENUE avec un payment_hash
-- non-null. Les SPENDING rows et les revenues sans payment_hash (futurs
-- donations etc.) ne sont pas couverts par la contrainte.

ALTER TABLE oracle_revenue_log
  ADD COLUMN IF NOT EXISTS payment_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_oracle_revenue_log_payment_hash_unique
  ON oracle_revenue_log (payment_hash)
  WHERE type = 'revenue' AND payment_hash IS NOT NULL;

INSERT INTO schema_version (version, applied_at, description)
VALUES (56, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'Security hardening - anti-double-revenue payment_hash UNIQUE')
ON CONFLICT (version) DO NOTHING;
