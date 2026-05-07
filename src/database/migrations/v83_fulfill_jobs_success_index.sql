-- Phase 12A audit fix HIGH-5 (2026-05-07) — index to make the JSONB
-- LATERAL subquery in findPaidProbeCandidates / findSweepCandidates
-- O(log N) instead of O(N) on `fulfill_jobs.status='success'`.
--
-- Without this, every paid-probe cron tick scans every successful job
-- in the table and unnests every attempts[] array. At current volume
-- (109 jobs, 39 success) it is fast ; at 10k+ jobs it would stall the
-- cron. Partial index covers only the rows the throttle subquery
-- queries, keeping the index small.
CREATE INDEX IF NOT EXISTS idx_fulfill_jobs_success_created
  ON fulfill_jobs (created_at)
  WHERE status = 'success';

INSERT INTO schema_version (version, applied_at, description)
VALUES (83, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'fulfill_jobs success+created_at partial index — Phase 12A audit fix HIGH-5')
ON CONFLICT (version) DO NOTHING;
